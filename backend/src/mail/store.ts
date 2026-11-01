/**
 * STORING MESSAGES
 * Saves a parsed message (and its thread) to the database. Safe to call
 * twice for the same Gmail message: the unique index on
 * (account, provider_message_id) means the second call is a no-op.
 */
import { getDb, now, uid, j, pj } from "../db/index.js";
import type { ParsedMessage } from "./types.js";
import { cleanForModel } from "./quotes.js";
import { findOrCreatePerson } from "../profiles/service.js";

export async function storeMessage(accountId: string, p: ParsedMessage, myAddresses: string[]):
  Promise<{ messageId: string; threadId: string; isNew: boolean }> {
  const db = await getDb();
  const existing = await db.selectFrom("messages").select(["id", "thread_id"])
    .where("account_id", "=", accountId).where("provider_message_id", "=", p.providerMessageId).executeTakeFirst();
  if (existing) return { messageId: existing.id, threadId: existing.thread_id, isNew: false };

  const mine = new Set(myAddresses.map((a) => a.toLowerCase()));
  const isFromMe = mine.has(p.from.email);
  const ts = now();

  // thread upsert
  let thread = await db.selectFrom("threads").selectAll().where("account_id", "=", accountId)
    .where("provider_thread_id", "=", p.providerThreadId).executeTakeFirst();
  const counterpart = isFromMe ? p.to.find((a) => !mine.has(a.email)) : p.from;
  const personId = counterpart && !isFromMe ? (await findOrCreatePerson(counterpart.email, counterpart.name)).id : null;
  if (!thread) {
    const id = uid();
    await db.insertInto("threads").values({
      id, account_id: accountId, provider_thread_id: p.providerThreadId, subject: p.subject, last_message_at: p.date,
      state: isFromMe ? "done" : "open", snooze_until: null, category: null, priority: null, summary: null, urgent: 0, scheduling: 0,
      draft_status: "none", person_id: personId, last_drafted_message_id: null, needs_attention: 0, created_at: ts, updated_at: ts,
    }).onConflict((oc) => oc.columns(["account_id", "provider_thread_id"]).doNothing()).execute();
    thread = await db.selectFrom("threads").selectAll().where("account_id", "=", accountId)
      .where("provider_thread_id", "=", p.providerThreadId).executeTakeFirstOrThrow();
  } else {
    const later = p.date > thread.last_message_at;
    await db.updateTable("threads").set({
      last_message_at: later ? p.date : thread.last_message_at,
      person_id: thread.person_id ?? personId,
      // a new incoming email re-opens a thread you had marked done
      state: later && !isFromMe && thread.state === "done" ? "open"
        : later && isFromMe && thread.state === "open" ? "done" // you replied (e.g. from Gmail): waiting on them now
        : thread.state,
      updated_at: ts,
    }).where("id", "=", thread.id).execute();
  }

  const id = uid();
  await db.insertInto("messages").values({
    id, account_id: accountId, thread_id: thread.id, provider_message_id: p.providerMessageId,
    rfc_message_id: p.messageIdHeader, in_reply_to: p.inReplyTo, references_hdr: p.references,
    from_email: p.from.email, from_name: p.from.name, reply_to: p.replyTo.length ? j(p.replyTo) : null,
    to_json: j(p.to), cc_json: j(p.cc), bcc_json: j(p.bcc), subject: p.subject, date: p.date, snippet: p.snippet.slice(0, 300),
    body_text: p.text, body_html: p.html, stripped_text: cleanForModel(p.text), attachments_json: j(p.attachments),
    labels_json: j(p.labels), headers_json: j({ ...p.headers, ...(p.calendarInvite ? { "x-calendar-invite": p.calendarInvite.slice(0, 4000) } : {}) }),
    list_unsubscribe: p.headers["list-unsubscribe"] ? 1 : 0, is_from_me: isFromMe ? 1 : 0, body_purged_at: null, created_at: ts,
  }).onConflict((oc) => oc.columns(["account_id", "provider_message_id"]).doNothing()).execute();

  if (personId) {
    await db.updateTable("people").set({ last_contact_at: p.date }).where("id", "=", personId)
      .where((eb) => eb.or([eb("last_contact_at", "is", null), eb("last_contact_at", "<", p.date)])).execute();
  }
  return { messageId: id, threadId: thread.id, isNew: true };
}

/** Rebuild a ParsedMessage-like object from a stored row (for drafting & triage). */
export async function loadParsed(messageId: string): Promise<ParsedMessage & { id: string; threadId: string; isFromMe: boolean; strippedText: string }> {
  const db = await getDb();
  const m = await db.selectFrom("messages").selectAll().where("id", "=", messageId).executeTakeFirstOrThrow();
  const headers = pj<Record<string, string>>(m.headers_json, {});
  return {
    id: m.id, threadId: m.thread_id, isFromMe: m.is_from_me === 1, strippedText: m.stripped_text ?? "",
    providerMessageId: m.provider_message_id, providerThreadId: "", labels: pj(m.labels_json, []),
    from: { name: m.from_name, email: m.from_email }, replyTo: pj(m.reply_to, []), to: pj(m.to_json, []), cc: pj(m.cc_json, []),
    bcc: pj(m.bcc_json, []), subject: m.subject, date: m.date, messageIdHeader: m.rfc_message_id, inReplyTo: m.in_reply_to,
    references: m.references_hdr, snippet: m.snippet ?? "", text: m.body_text ?? "", html: m.body_html,
    attachments: pj(m.attachments_json, []), headers, calendarInvite: headers["x-calendar-invite"] ?? null,
  };
}
