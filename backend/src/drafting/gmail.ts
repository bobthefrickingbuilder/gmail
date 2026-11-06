/**
 * WRITING DRAFTS INTO GMAIL
 * Builds the reply email (correct thread, In-Reply-To, References, "Re:"
 * subject, recipients, signature) and creates the Gmail draft — or UPDATES
 * the existing one, so redrafting never leaves duplicates behind.
 */
import { getDb, now, pj } from "../db/index.js";
import { mailFor } from "../providers/index.js";
import { buildReferences, buildReplyMime, replySubject } from "../mail/mime.js";
import { resolveSignature } from "./signature.js";
import { attachmentsForMime } from "./attachments.js";
import type { Address } from "../mail/types.js";
import type { SendAs } from "../providers/mail/types.js";

export const AI_LABELS = { drafted: "AI/Drafted", review: "AI/Needs-Review", skipped: "AI/Skipped", escalated: "AI/Escalated" } as const;

export async function applyThreadLabels(account: { id: string; provider: string }, providerThreadId: string, add: string[], remove: string[] = []) {
  const mail = mailFor(account);
  const ids = await mail.ensureLabels([...new Set([...add, ...remove])]);
  await mail.modifyThreadLabels(providerThreadId, add.map((n) => ids[n]), remove.map((n) => ids[n]).filter(Boolean));
}

export async function writeDraftToGmail(draftId: string): Promise<string> {
  const db = await getDb();
  const d = await db.selectFrom("drafts").selectAll().where("id", "=", draftId).executeTakeFirstOrThrow();
  const v = await db.selectFrom("draft_versions").selectAll().where("id", "=", d.current_version_id!).executeTakeFirstOrThrow();
  const acc = await db.selectFrom("accounts").selectAll().where("id", "=", d.account_id).executeTakeFirstOrThrow();
  const thread = await db.selectFrom("threads").select(["provider_thread_id"]).where("id", "=", d.thread_id).executeTakeFirstOrThrow();
  const orig = await db.selectFrom("messages").selectAll().where("id", "=", d.reply_to_message_id).executeTakeFirstOrThrow();
  const sendAs = pj<SendAs[]>(acc.send_as_json, []);
  const sig = await resolveSignature(d.signature_key, d.from_email, sendAs);
  const fromName = sendAs.find((s) => s.email === d.from_email)?.displayName ?? acc.display_name ?? null;
  const mime = buildReplyMime({
    from: { name: fromName, email: d.from_email },
    to: pj<Address[]>(d.to_json, []), cc: pj<Address[]>(d.cc_json, []),
    subject: v.subject || replySubject(orig.subject),
    inReplyTo: orig.rfc_message_id, references: buildReferences({ references: orig.references_hdr, messageIdHeader: orig.rfc_message_id }),
    bodyText: v.body, signatureText: sig.text, signatureHtml: sig.html,
    attachments: await attachmentsForMime("reply", draftId),
  });
  const mail = mailFor(acc);
  let providerDraftId = d.provider_draft_id;
  if (providerDraftId && (await mail.draftExists(providerDraftId))) {
    await mail.updateDraft(providerDraftId, thread.provider_thread_id, mime);
  } else {
    providerDraftId = (await mail.createDraft(thread.provider_thread_id, mime)).draftId;
  }
  await db.updateTable("drafts").set({ provider_draft_id: providerDraftId, updated_at: now() }).where("id", "=", draftId).execute();
  return providerDraftId;
}
