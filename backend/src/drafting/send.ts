/**
 * SENDING — the ONLY path that sends email.
 * ------------------------------------------
 * Two steps, both triggered by you in the app:
 *   1. prepareSend(): returns exactly what will go out (recipients, subject,
 *      first lines) plus a one-time confirmation token valid for 2 minutes.
 *      The app shows this in a confirmation dialog.
 *   2. confirmSend(token): checks the token (unused, unexpired, same draft
 *      version you saw), makes sure Gmail has that exact version, then asks
 *      Gmail to send the draft.
 * The worker (background jobs) never imports this file — a test enforces it.
 */
import { getDb, now, uid, pj } from "../db/index.js";
import { mailFor } from "../providers/index.js";
import { randomToken, sha256 } from "../crypto.js";
import { writeDraftToGmail, applyThreadLabels, AI_LABELS } from "./gmail.js";
import { audit } from "../audit.js";
import { emit } from "../notify/sse.js";
import type { Address } from "../mail/types.js";

export const CONFIRM_TTL_MS = 2 * 60 * 1000;

export class SendConfirmationError extends Error {}

export async function prepareSend(draftId: string) {
  const db = await getDb();
  const d = await db.selectFrom("drafts").selectAll().where("id", "=", draftId).executeTakeFirstOrThrow();
  if (!["active", "saved"].includes(d.status)) throw new SendConfirmationError(`Draft is ${d.status}`);
  const v = await db.selectFrom("draft_versions").selectAll().where("id", "=", d.current_version_id!).executeTakeFirstOrThrow();
  const to = pj<Address[]>(d.to_json, []);
  if (!to.length) throw new SendConfirmationError("The draft has no recipients");
  const token = randomToken(24);
  await db.insertInto("send_confirmations").values({ id: uid(), draft_id: draftId, version_id: v.id, token_hash: sha256(token),
    expires_at: new Date(Date.now() + CONFIRM_TTL_MS).toISOString(), used_at: null, created_at: now() }).execute();
  await audit("user", "send.prepare", "draft", draftId, { version: v.version });
  return {
    token, expiresInSeconds: CONFIRM_TTL_MS / 1000,
    from: d.from_email, to, cc: pj<Address[]>(d.cc_json, []), subject: v.subject,
    preview: v.body.split("\n").filter((l) => l.trim()).slice(0, 4).join("\n"),
    versionId: v.id, flags: pj<string[]>(v.flags_json, []),
    hasPlaceholders: /\[CONFIRM:/i.test(v.body),
  };
}

export async function confirmSend(draftId: string, token: string) {
  const db = await getDb();
  const c = await db.selectFrom("send_confirmations").selectAll().where("draft_id", "=", draftId).where("token_hash", "=", sha256(token)).executeTakeFirst();
  if (!c) throw new SendConfirmationError("Invalid confirmation");
  if (c.used_at) throw new SendConfirmationError("This confirmation was already used");
  if (new Date(c.expires_at).getTime() < Date.now()) throw new SendConfirmationError("Confirmation expired — review the draft again");
  const d = await db.selectFrom("drafts").selectAll().where("id", "=", draftId).executeTakeFirstOrThrow();
  if (d.current_version_id !== c.version_id) throw new SendConfirmationError("The draft changed after you reviewed it — review again");
  const v = await db.selectFrom("draft_versions").selectAll().where("id", "=", c.version_id).executeTakeFirstOrThrow();
  if (/\[CONFIRM:/i.test(v.body)) throw new SendConfirmationError("The draft still contains [CONFIRM: …] placeholders");
  // mark used first so a double-tap cannot send twice
  const upd = await db.updateTable("send_confirmations").set({ used_at: now() }).where("id", "=", c.id).where("used_at", "is", null).executeTakeFirst();
  if (Number(upd.numUpdatedRows) !== 1) throw new SendConfirmationError("This confirmation was already used");

  const providerDraftId = await writeDraftToGmail(draftId); // Gmail now holds exactly the reviewed version
  const acc = await db.selectFrom("accounts").selectAll().where("id", "=", d.account_id).executeTakeFirstOrThrow();
  const sent = await mailFor(acc).sendDraft(providerDraftId);
  const orig = await db.selectFrom("draft_versions").select("body").where("id", "=", d.original_version_id ?? v.id).executeTakeFirst();
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  await db.updateTable("drafts").set({ status: "sent", provider_draft_id: null, final_body: v.body,
    edit_class: orig && norm(orig.body) === norm(v.body) ? "unedited" : "edited", updated_at: now() }).where("id", "=", draftId).execute();
  await db.updateTable("threads").set({ state: "done", draft_status: "none", updated_at: now() }).where("id", "=", d.thread_id).execute();
  const t = await db.selectFrom("threads").select("provider_thread_id").where("id", "=", d.thread_id).executeTakeFirstOrThrow();
  await applyThreadLabels(acc, t.provider_thread_id, [], [AI_LABELS.review]).catch(() => undefined);
  await audit("user", "send", "draft", draftId, { version: v.version, provider_message_id: sent.messageId });
  emit("draft", { threadId: d.thread_id, draftId, sent: true });
  return sent;
}
