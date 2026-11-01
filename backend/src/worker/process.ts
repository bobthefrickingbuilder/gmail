/**
 * PROCESSING NEW MAIL (what the worker does with each new message)
 *   triage → if the category is draft-enabled and the budget allows → draft
 * Idempotent: a thread is never auto-drafted twice for the same message
 * (threads.last_drafted_message_id), and existing drafts are updated.
 */
import { getDb, pj } from "../db/index.js";
import { triageMessage } from "../triage/service.js";
import { draftThread } from "../drafting/pipeline.js";
import { autoModelFor } from "../drafting/models.js";
import { budgetExceeded } from "../usage/cost.js";
import { getSettings } from "../settings.js";
import { sendPush } from "../notify/push.js";
import { deadLetter } from "./deadletter.js";
import { applyThreadLabels, AI_LABELS } from "../drafting/gmail.js";
import { emit } from "../notify/sse.js";
import { log } from "../log.js";
import { LlmRefusalError } from "../providers/llm/types.js";

export async function processNewMessage(messageId: string, threadId: string): Promise<"drafted" | "skipped" | "triaged" | "failed"> {
  const db = await getDb();
  const msg = await db.selectFrom("messages").selectAll().where("id", "=", messageId).executeTakeFirstOrThrow();
  if (msg.is_from_me) return "skipped";
  let decision;
  try { decision = await triageMessage(messageId); } catch (e) { await deadLetter("triage", messageId, e); return "failed"; }
  const thread = await db.selectFrom("threads").selectAll().where("id", "=", threadId).executeTakeFirstOrThrow();
  const acc = await db.selectFrom("accounts").selectAll().where("id", "=", thread.account_id).executeTakeFirstOrThrow();
  emit("thread", { threadId });

  if (decision.skipped) {
    await applyThreadLabels(acc, thread.provider_thread_id, [AI_LABELS.skipped]).catch(() => undefined);
    return "skipped";
  }
  const s = await getSettings();
  if (decision.urgent && s.notifications.urgent) {
    await sendPush({ title: `Urgent: ${msg.from_name ?? msg.from_email}`, body: msg.subject, url: `/#/thread/${threadId}`, tag: threadId }).catch(() => undefined);
  }
  // Is this the latest message, and have we already drafted for it?
  const latest = await db.selectFrom("messages").select("id").where("thread_id", "=", threadId).orderBy("date", "desc").limit(1).executeTakeFirst();
  if (latest?.id !== messageId || thread.last_drafted_message_id === messageId) return "triaged";
  if (!s.auto_draft || !s.draft_categories.includes(decision.category)) return "triaged";
  if (await budgetExceeded()) { log.info({ thread: threadId }, "budget cap reached: auto-drafting paused"); return "triaged"; }

  const person = thread.person_id ? await db.selectFrom("people").select(["escalate_model"]).where("id", "=", thread.person_id).executeTakeFirst() : undefined;
  const modelKey = await autoModelFor({ fromEmail: msg.from_email, labels: pj(msg.labels_json, []), category: decision.category,
    personEscalate: person?.escalate_model ?? null, ruleEscalate: decision.escalateModel });
  try {
    await draftThread(threadId, { modelKey, actor: "worker", replyToMessageId: messageId });
    if (s.notifications.drafts) await sendPush({ title: `Draft ready: ${msg.from_name ?? msg.from_email}`, body: msg.subject, url: `/#/thread/${threadId}`, tag: threadId }).catch(() => undefined);
    return "drafted";
  } catch (e) {
    await deadLetter("draft", threadId, e instanceof LlmRefusalError ? new Error(`${e.message}; left undrafted`) : e);
    return "failed";
  }
}
