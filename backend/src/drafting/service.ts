/**
 * DRAFT ACTIONS YOU TAKE IN THE APP
 * Edit (creates a "user" version), Save to Gmail, Revert to an earlier
 * version, Discard. Every version is kept so you can compare and revert.
 */
import { getDb, now, uid, j, pj } from "../db/index.js";
import { writeDraftToGmail, applyThreadLabels, AI_LABELS } from "./gmail.js";
import { clearAttachments } from "./attachments.js";
import { mailFor } from "../providers/index.js";
import { audit } from "../audit.js";
import { emit } from "../notify/sse.js";
import { computeRecipients } from "../mail/mime.js";
import { loadParsed } from "../mail/store.js";
import { myAddresses } from "../mail/sync.js";
import type { Address } from "../mail/types.js";

export interface DraftEdit {
  body?: string; subject?: string; to?: Address[]; cc?: Address[]; reply_mode?: "reply" | "reply_all";
  signature_key?: string | null; share_schedule_details?: boolean;
}

export async function getDraftBundle(draftId: string) {
  const db = await getDb();
  const draft = await db.selectFrom("drafts").selectAll().where("id", "=", draftId).executeTakeFirstOrThrow();
  const versions = await db.selectFrom("draft_versions").selectAll().where("draft_id", "=", draftId).orderBy("version", "desc").execute();
  return { draft, versions };
}

export async function editDraft(draftId: string, e: DraftEdit) {
  const db = await getDb();
  const { draft, versions } = await getDraftBundle(draftId);
  const cur = versions.find((v) => v.id === draft.current_version_id)!;
  const patch: Record<string, unknown> = { updated_at: now() };
  if (e.reply_mode && e.reply_mode !== draft.reply_mode && !e.to) {
    // recompute recipients for the new mode
    const acc = await db.selectFrom("accounts").selectAll().where("id", "=", draft.account_id).executeTakeFirstOrThrow();
    const r = computeRecipients(await loadParsed(draft.reply_to_message_id), myAddresses(acc), e.reply_mode);
    patch.to_json = j(r.to); patch.cc_json = j(r.cc);
  }
  if (e.reply_mode) patch.reply_mode = e.reply_mode;
  if (e.to) patch.to_json = j(e.to);
  if (e.cc) patch.cc_json = j(e.cc);
  if (e.signature_key !== undefined) patch.signature_key = e.signature_key;
  if (e.share_schedule_details !== undefined) patch.share_schedule_details = e.share_schedule_details ? 1 : 0;
  let versionId = cur.id;
  if ((e.body !== undefined && e.body !== cur.body) || (e.subject !== undefined && e.subject !== cur.subject)) {
    versionId = uid();
    await db.insertInto("draft_versions").values({ ...cur, id: versionId, version: versions[0].version + 1, origin: "user",
      body: e.body ?? cur.body, subject: e.subject ?? cur.subject, input_tokens: 0, output_tokens: 0, cost_usd: 0, instruction: null, created_at: now() }).execute();
    patch.current_version_id = versionId;
  }
  await db.updateTable("drafts").set(patch).where("id", "=", draftId).execute();
  await audit("user", "draft.edit", "draft", draftId, { fields: Object.keys(e) });
  emit("draft", { threadId: draft.thread_id, draftId });
  return { versionId };
}

function classifyEdit(original: string, final: string) {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return norm(original) === norm(final) ? "unedited" : "edited";
}

export async function saveToGmail(draftId: string) {
  const db = await getDb();
  const { draft, versions } = await getDraftBundle(draftId);
  const providerDraftId = await writeDraftToGmail(draftId);
  const cur = versions.find((v) => v.id === draft.current_version_id)!;
  const orig = versions.find((v) => v.id === draft.original_version_id) ?? cur;
  await db.updateTable("drafts").set({ status: "saved", final_body: cur.body, edit_class: classifyEdit(orig.body, cur.body), updated_at: now() })
    .where("id", "=", draftId).execute();
  await audit("user", "draft.save_gmail", "draft", draftId, { version: cur.version });
  emit("draft", { threadId: draft.thread_id, draftId });
  return { providerDraftId };
}

export async function revertDraft(draftId: string, versionId: string) {
  const db = await getDb();
  const { draft, versions } = await getDraftBundle(draftId);
  const target = versions.find((v) => v.id === versionId);
  if (!target) throw new Error("Version not found");
  await db.updateTable("drafts").set({ current_version_id: versionId, updated_at: now() }).where("id", "=", draftId).execute();
  if (target.model_key) await db.updateTable("threads").set({ draft_status: `drafted:${target.model_key}` }).where("id", "=", draft.thread_id).execute();
  await writeDraftToGmail(draftId);
  await audit("user", "draft.revert", "draft", draftId, { to_version: target.version });
  emit("draft", { threadId: draft.thread_id, draftId });
}

export async function discardDraft(draftId: string) {
  const db = await getDb();
  const { draft } = await getDraftBundle(draftId);
  const acc = await db.selectFrom("accounts").selectAll().where("id", "=", draft.account_id).executeTakeFirstOrThrow();
  if (draft.provider_draft_id) {
    const mail = mailFor(acc);
    if (await mail.draftExists(draft.provider_draft_id)) await mail.deleteDraft(draft.provider_draft_id);
  }
  await db.updateTable("drafts").set({ status: "discarded", edit_class: "discarded", provider_draft_id: null, updated_at: now() }).where("id", "=", draftId).execute();
  await clearAttachments("reply", draftId);
  await db.updateTable("threads").set({ draft_status: "none" }).where("id", "=", draft.thread_id).execute();
  const t = await db.selectFrom("threads").select("provider_thread_id").where("id", "=", draft.thread_id).executeTakeFirstOrThrow();
  await applyThreadLabels(acc, t.provider_thread_id, [], [AI_LABELS.drafted, AI_LABELS.review]).catch(() => undefined);
  await audit("user", "draft.discard", "draft", draftId);
  emit("draft", { threadId: draft.thread_id, draftId });
}

export const _test = { classifyEdit };
export { pj };
