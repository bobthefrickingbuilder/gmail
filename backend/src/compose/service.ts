/**
 * NEW EMAILS (COMPOSE)
 * Emails you start yourself, as opposed to replies. Each one is kept here
 * while you write and saved into Gmail as a normal draft (no thread) when you
 * press Save, so it also shows in Gmail's Drafts folder. Claude can write or
 * polish the text from your instruction; it never sends. Sending goes through
 * the same confirmed two-step path as replies (drafting/send.ts).
 */
import { getDb, now, uid, pj, j } from "../db/index.js";
import { mailFor, getLlm } from "../providers/index.js";
import { buildReplyMime } from "../mail/mime.js";
import { resolveSignature } from "../drafting/signature.js";
import { draftModelKey } from "../drafting/models.js";
import { attachmentsForMime, clearAttachments } from "../drafting/attachments.js";
import { buildComposePrompt, DEFAULT_OWNER } from "../drafting/prompt.js";
import { DraftOutput } from "../providers/llm/schemas.js";
import { postCheck } from "../drafting/postcheck.js";
import { toPromptProfile } from "../profiles/service.js";
import { getModels, getSettings, getStyleGuide } from "../settings.js";
import { budgetExceeded, recordUsage } from "../usage/cost.js";
import { todayString } from "../time.js";
import { HttpError } from "../http.js";
import { audit } from "../audit.js";
import { emit } from "../notify/sse.js";
import type { Address } from "../mail/types.js";
import type { SendAs } from "../providers/mail/types.js";
import type { ComposeDraftsTable } from "../db/schema.js";

export interface ComposePatch { to?: Address[]; cc?: Address[]; bcc?: Address[]; subject?: string; body?: string; from_email?: string }

export function composeView(c: ComposeDraftsTable) {
  return { id: c.id, from_email: c.from_email, to: pj<Address[]>(c.to_json, []), cc: pj<Address[]>(c.cc_json, []), bcc: pj<Address[]>(c.bcc_json, []),
    subject: c.subject, body: c.body, status: c.status, saved: c.status === "saved", provider_draft_id: c.provider_draft_id, created_at: c.created_at, updated_at: c.updated_at };
}

async function defaultAccount() {
  const db = await getDb();
  const acc = await db.selectFrom("accounts").selectAll().where("enabled", "=", 1).orderBy("created_at").executeTakeFirst();
  if (!acc) throw new HttpError(400, "Connect a Google account first (Settings → Accounts)");
  return acc;
}

export async function getCompose(id: string) {
  const db = await getDb();
  const c = await db.selectFrom("compose_drafts").selectAll().where("id", "=", id).executeTakeFirst();
  if (!c || c.status === "discarded") throw new HttpError(404, "Not found");
  return c;
}

export async function createCompose(p: ComposePatch) {
  const db = await getDb();
  const acc = await defaultAccount();
  const sendAs = pj<SendAs[]>(acc.send_as_json, []);
  const from = p.from_email ?? sendAs.find((s) => s.isDefault)?.email ?? acc.email;
  const row: ComposeDraftsTable = { id: uid(), account_id: acc.id, from_email: from, to_json: j(p.to ?? []), cc_json: j(p.cc ?? []), bcc_json: j(p.bcc ?? []),
    subject: p.subject ?? "", body: p.body ?? "", provider_draft_id: null, status: "open", created_at: now(), updated_at: now() };
  await db.insertInto("compose_drafts").values(row).execute();
  emit("compose", { id: row.id });
  return composeView(row);
}

/** Your edits. Gmail's copy is now older, so the draft is "open" again until the next Save. */
export async function updateCompose(id: string, p: ComposePatch) {
  const db = await getDb();
  const c = await getCompose(id);
  if (c.status === "sent") throw new HttpError(409, "This email was already sent");
  const set: Partial<ComposeDraftsTable> = { updated_at: now(), status: "open" };
  if (p.to) set.to_json = j(p.to);
  if (p.cc) set.cc_json = j(p.cc);
  if (p.bcc) set.bcc_json = j(p.bcc);
  if (p.subject !== undefined) set.subject = p.subject;
  if (p.body !== undefined) set.body = p.body;
  if (p.from_email) set.from_email = p.from_email;
  await db.updateTable("compose_drafts").set(set).where("id", "=", id).execute();
  emit("compose", { id });
  return composeView(await getCompose(id));
}

/** Create or update the Gmail draft so Gmail holds exactly this version. */
export async function saveComposeToGmail(id: string): Promise<string> {
  const db = await getDb();
  const c = await getCompose(id);
  const acc = await db.selectFrom("accounts").selectAll().where("id", "=", c.account_id).executeTakeFirstOrThrow();
  const sendAs = pj<SendAs[]>(acc.send_as_json, []);
  const sig = await resolveSignature(null, c.from_email, sendAs);
  const fromName = sendAs.find((s) => s.email === c.from_email)?.displayName ?? acc.display_name ?? null;
  const mime = buildReplyMime({
    from: { name: fromName, email: c.from_email }, to: pj<Address[]>(c.to_json, []), cc: pj<Address[]>(c.cc_json, []), bcc: pj<Address[]>(c.bcc_json, []),
    subject: c.subject.trim() || "(no subject)", inReplyTo: null, references: null,
    bodyText: c.body, signatureText: sig.text, signatureHtml: sig.html,
    attachments: await attachmentsForMime("compose", id),
  });
  const mail = mailFor(acc);
  let draftId = c.provider_draft_id;
  if (draftId && (await mail.draftExists(draftId))) await mail.updateDraft(draftId, null, mime);
  else draftId = (await mail.createDraft(null, mime)).draftId;
  await db.updateTable("compose_drafts").set({ provider_draft_id: draftId, status: "saved", updated_at: now() }).where("id", "=", id).execute();
  await audit("user", "compose.save", "compose", id);
  emit("compose", { id });
  return draftId;
}

export async function discardCompose(id: string) {
  const db = await getDb();
  const c = await getCompose(id);
  if (c.provider_draft_id && c.status !== "sent") {
    const acc = await db.selectFrom("accounts").selectAll().where("id", "=", c.account_id).executeTakeFirstOrThrow();
    const mail = mailFor(acc);
    if (await mail.draftExists(c.provider_draft_id).catch(() => false)) await mail.deleteDraft(c.provider_draft_id);
  }
  await db.updateTable("compose_drafts").set({ status: "discarded", provider_draft_id: null, updated_at: now() }).where("id", "=", id).execute();
  await clearAttachments("compose", id);
  await audit("user", "compose.discard", "compose", id);
  emit("compose", { id });
}

/** Claude writes (or polishes) the body from your instruction. Returns the new text; you still review it. */
export async function writeCompose(id: string, instruction: string, modelKey?: string) {
  if (await budgetExceeded()) throw new HttpError(402, "Monthly AI budget reached (Settings → Usage)");
  const db = await getDb();
  const c = await getCompose(id);
  const to = pj<Address[]>(c.to_json, []); const cc = pj<Address[]>(c.cc_json, []);
  const first = to[0]?.email.toLowerCase();
  const person = first ? await db.selectFrom("people").selectAll()
    .where("id", "in", db.selectFrom("person_addresses").select("person_id").where("email", "=", first)).executeTakeFirst() : undefined;
  const models = await getModels(); const s = await getSettings();
  const key = modelKey && models.models[modelKey] ? modelKey : await draftModelKey();
  const fmt = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email);
  const { system, user } = buildComposePrompt({ ownerDescription: DEFAULT_OWNER, styleGuide: await getStyleGuide(), profile: person ? toPromptProfile(person) : null,
    instruction, currentBody: c.body, subject: c.subject, to: to.map(fmt), cc: cc.map(fmt), today: todayString(s.timezone) });
  const res = await getLlm().complete({ modelKey: key, purpose: "draft", system, user, schema: DraftOutput, schemaName: "draft", maxTokens: models.max_output_tokens.draft });
  await recordUsage({ purpose: "draft", modelKey: key, modelId: res.modelId, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd });
  const out = postCheck(res.data, { eventSummaries: [], shareScheduleDetails: false, injectionSuspected: false }).output;
  const subject = c.subject.trim() ? c.subject : out.subject ?? c.subject;
  const view = await updateCompose(id, { body: out.draft_body, subject });
  await audit("user", "compose.write", "compose", id, { model: key });
  return { compose: view, model: key, open_questions: out.open_questions, flags: out.flags, confidence: out.confidence };
}
