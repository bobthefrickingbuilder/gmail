/**
 * DRAFTING PIPELINE
 * -----------------
 * draftThread() is what runs when the worker decides an email needs a reply,
 * or when you tap "Draft" / "Redraft":
 *   1. gather context (thread, profile, pinned docs, past replies,
 *      availability if scheduling was detected)
 *   2. build the prompt (prompt.ts) and call Claude — text in, JSON out, no tools
 *   3. validate + post-check the result
 *   4. store a new draft version and write/update the Gmail draft
 *   5. label the thread, record cost, propose a profile update, notify the app
 * It never sends anything.
 */
import { getDb, now, uid, j, pj } from "../db/index.js";
import { getLlm } from "../providers/index.js";
import { DraftOutput } from "../providers/llm/schemas.js";
import { buildDraftPrompt, DEFAULT_OWNER, type PromptMessage } from "./prompt.js";
import { getModels, getSettings, getStyleGuide } from "../settings.js";
import { recordUsage } from "../usage/cost.js";
import { toPromptProfile, proposeUpdate } from "../profiles/service.js";
import { availabilityFor, busyIntervals, schedulingRange } from "../calendar/service.js";
import { computeRecipients, defaultReplyMode, replySubject } from "../mail/mime.js";
import { loadParsed } from "../mail/store.js";
import { myAddresses } from "../mail/sync.js";
import { postCheck } from "./postcheck.js";
import { AI_LABELS, applyThreadLabels, writeDraftToGmail } from "./gmail.js";
import { audit, type Actor } from "../audit.js";
import { emit } from "../notify/sse.js";
import { todayString } from "../time.js";
import { INJECTION_RE } from "../providers/llm/mock.js";
import { log } from "../log.js";
import type { Address } from "../mail/types.js";
import type { DraftVersionsTable } from "../db/schema.js";

export interface DraftOptions {
  modelKey?: string;
  instruction?: string | null;
  shareScheduleDetails?: boolean;
  actor: Actor;
  /** Override the message being answered (default: latest incoming). */
  replyToMessageId?: string;
}

export async function latestIncoming(threadId: string) {
  const db = await getDb();
  return db.selectFrom("messages").selectAll().where("thread_id", "=", threadId).where("is_from_me", "=", 0)
    .orderBy("date", "desc").limit(1).executeTakeFirst();
}

/** Up to 3 of Matthew's own past replies: same person first, then same category. */
export async function retrieveExamples(personId: string | null, category: string | null, subject: string, excludeThreadId: string) {
  const db = await getDb();
  const picks: { to: string; subject: string; body: string; reason: string }[] = [];
  if (personId) {
    const rows = await db.selectFrom("messages").innerJoin("threads", "threads.id", "messages.thread_id")
      .select(["messages.to_json", "messages.subject", "messages.stripped_text"])
      .where("threads.person_id", "=", personId).where("messages.is_from_me", "=", 1).where("threads.id", "!=", excludeThreadId)
      .where("messages.stripped_text", "is not", null).orderBy("messages.date", "desc").limit(3).execute();
    for (const r of rows) picks.push({ to: pj<Address[]>(r.to_json, [])[0]?.email ?? "", subject: r.subject, body: r.stripped_text ?? "", reason: "same person" });
  }
  if (picks.length < 3 && category) {
    const rows = await db.selectFrom("messages").innerJoin("threads", "threads.id", "messages.thread_id")
      .select(["messages.to_json", "messages.subject", "messages.stripped_text"])
      .where("threads.category", "=", category).where("messages.is_from_me", "=", 1).where("threads.id", "!=", excludeThreadId)
      .where("messages.stripped_text", "is not", null).orderBy("messages.date", "desc").limit(20).execute();
    const words = new Set(subject.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const scored = rows.map((r) => ({ r, score: r.subject.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length }))
      .sort((a, b) => b.score - a.score);
    for (const { r } of scored.slice(0, 3 - picks.length))
      picks.push({ to: pj<Address[]>(r.to_json, [])[0]?.email ?? "", subject: r.subject, body: r.stripped_text ?? "", reason: `similar ${category} email` });
  }
  return picks.filter((p) => p.body.trim());
}

export async function draftThread(threadId: string, opts: DraftOptions) {
  const db = await getDb();
  const settings = await getSettings();
  const models = await getModels();
  const thread = await db.selectFrom("threads").selectAll().where("id", "=", threadId).executeTakeFirstOrThrow();
  const acc = await db.selectFrom("accounts").selectAll().where("id", "=", thread.account_id).executeTakeFirstOrThrow();
  const targetRow = opts.replyToMessageId
    ? await db.selectFrom("messages").selectAll().where("id", "=", opts.replyToMessageId).executeTakeFirstOrThrow()
    : await latestIncoming(threadId);
  if (!targetRow) throw new Error("This thread has no incoming message to reply to");
  const target = await loadParsed(targetRow.id);
  const mine = myAddresses(acc);

  const existing = await db.selectFrom("drafts").selectAll().where("thread_id", "=", threadId).where("status", "in", ["active", "saved"])
    .orderBy("created_at", "desc").executeTakeFirst();
  const modelKey = opts.modelKey ?? models.default_draft_model;
  if (!models.models[modelKey]) throw new Error(`Unknown model "${modelKey}"`);
  const shareDetails = opts.shareScheduleDetails ?? (existing?.share_schedule_details === 1);

  // ---- context ----
  const msgs = await db.selectFrom("messages").selectAll().where("thread_id", "=", threadId).where("date", "<=", target.date)
    .orderBy("date", "desc").limit(40).execute();
  const promptThread: PromptMessage[] = msgs.map((m) => ({
    fromName: m.from_name, fromEmail: m.from_email, isFromMe: m.is_from_me === 1, date: m.date, subject: m.subject,
    text: m.stripped_text ?? m.snippet ?? "", attachments: pj<{ filename: string; text?: string | null; inline?: boolean }[]>(m.attachments_json, []).filter((a) => !a.inline),
  }));
  const person = thread.person_id ? await db.selectFrom("people").selectAll().where("id", "=", thread.person_id).executeTakeFirst() : undefined;
  const pinned = person ? await db.selectFrom("pinned_docs").select(["title", "content"]).where("person_id", "=", person.id).execute() : [];
  const examples = await retrieveExamples(person?.id ?? null, thread.category, thread.subject, threadId);

  let availability: { timezone: string; slots: { start: string; end: string; label: string }[]; details?: string[] } | null = null;
  let eventSummaries: string[] = [];
  if (thread.scheduling === 1 || thread.category === "scheduling") {
    try {
      const tri = await db.selectFrom("triage").select("scheduling_json").where("message_id", "=", target.id).orderBy("created_at", "desc").executeTakeFirst();
      const sched = pj<{ duration_minutes?: number | null; proposed_times?: { start: string | null }[]; requested_range?: { from: string; to: string } | null }>(tri?.scheduling_json, {});
      const range = schedulingRange(sched, settings.timezone);
      const a = await availabilityFor(acc, { from: range.from, to: range.to, durationMinutes: sched.duration_minutes ?? 60 });
      availability = { timezone: a.timezone, slots: a.slots, details: shareDetails ? a.details : undefined };
      eventSummaries = a.details;
    } catch (e) {
      log.warn({ thread: threadId, err: (e as Error).message }, "availability unavailable");
    }
  } else {
    try { eventSummaries = (await busyIntervals(acc, new Date(Date.now() - 7 * 86400_000), new Date(Date.now() + 60 * 86400_000))).details; } catch { /* calendar optional */ }
  }

  // recipients: keep the user's choice on redraft
  const replyMode = (existing?.reply_mode as "reply" | "reply_all") ?? defaultReplyMode(target, mine, settings.reply_all_default);
  const computed = computeRecipients(target, mine, replyMode);
  const to = existing ? pj<Address[]>(existing.to_json, computed.to) : computed.to;
  const cc = existing ? pj<Address[]>(existing.cc_json, computed.cc) : computed.cc;
  const fromEmail = existing?.from_email ?? ([...target.to, ...target.cc].find((a) => mine.includes(a.email))?.email ?? acc.email);

  const { system, user } = buildDraftPrompt({
    ownerDescription: DEFAULT_OWNER, styleGuide: await getStyleGuide(), profile: person ? toPromptProfile(person) : null,
    pinnedDocs: pinned, thread: promptThread, availability, shareScheduleDetails: shareDetails, instruction: opts.instruction ?? null,
    examples, replyLanguageHint: person?.language ?? null, today: todayString(settings.timezone),
    recipients: { to: to.map((a) => a.email), cc: cc.map((a) => a.email) },
  });

  // ---- model call ----
  const res = await getLlm().complete({ modelKey, purpose: "draft", system, user, schema: DraftOutput, schemaName: "draft", maxTokens: models.max_output_tokens.draft });
  const injectionSuspected = INJECTION_RE.test(`${target.subject}\n${target.text}`);
  const { output, notes } = postCheck(res.data, { eventSummaries, shareScheduleDetails: shareDetails, injectionSuspected });

  // ---- store ----
  const ts = now();
  let draftId = existing?.id;
  if (!draftId) {
    draftId = uid();
    await db.insertInto("drafts").values({ id: draftId, thread_id: threadId, account_id: acc.id, reply_to_message_id: target.id,
      provider_draft_id: null, current_version_id: null, status: "active", reply_mode: replyMode, to_json: j(to), cc_json: j(cc),
      from_email: fromEmail, signature_key: person?.signature_key ?? null, share_schedule_details: shareDetails ? 1 : 0,
      original_version_id: null, final_body: null, edit_class: null, created_at: ts, updated_at: ts }).execute();
  } else {
    await db.updateTable("drafts").set({ reply_to_message_id: target.id, share_schedule_details: shareDetails ? 1 : 0, status: "active", updated_at: ts })
      .where("id", "=", draftId).execute();
  }
  const versionRow = await db.selectFrom("draft_versions").select((eb) => eb.fn.max("version").as("v")).where("draft_id", "=", draftId).executeTakeFirst();
  const version: DraftVersionsTable = {
    id: uid(), draft_id: draftId, version: Number(versionRow?.v ?? 0) + 1, origin: "model", model_key: modelKey, model_id: res.modelId,
    body: output.draft_body, subject: output.subject?.trim() || replySubject(target.subject),
    open_questions_json: j(output.open_questions), detected_dates_json: j(output.detected_dates),
    calendar_actions_json: j(output.suggested_calendar_actions), confidence: output.confidence,
    flags_json: j([...output.flags, ...(res.fellBack ? ["served_by_fallback_model"] : [])]), instruction: opts.instruction ?? null,
    input_tokens: res.inputTokens, output_tokens: res.outputTokens, cost_usd: res.costUsd, created_at: ts,
  };
  await db.insertInto("draft_versions").values(version).execute();
  await db.updateTable("drafts").set({ current_version_id: version.id, original_version_id: existing?.original_version_id ?? version.id })
    .where("id", "=", draftId).execute();
  await db.updateTable("threads").set({ draft_status: `drafted:${modelKey}`, last_drafted_message_id: target.id, needs_attention: 0, updated_at: ts })
    .where("id", "=", threadId).execute();
  await recordUsage({ purpose: "draft", modelKey, modelId: res.modelId, inputTokens: res.inputTokens, outputTokens: res.outputTokens,
    costUsd: res.costUsd, threadId, draftId });

  // ---- Gmail ----
  await writeDraftToGmail(draftId);
  const needsReview = output.confidence !== "high" || output.flags.length > 0 || output.open_questions.length > 0;
  const add: string[] = [AI_LABELS.drafted, ...(needsReview ? [AI_LABELS.review] : []), ...(modelKey !== models.default_draft_model ? [AI_LABELS.escalated] : [])];
  await applyThreadLabels(acc, thread.provider_thread_id, add, needsReview ? [] : [AI_LABELS.review]);

  await audit(opts.actor, existing ? "draft.redraft" : "draft.create", "thread", threadId,
    { draft_id: draftId, version: version.version, model: modelKey, flags: output.flags, confidence: output.confidence });
  emit("draft", { threadId, draftId });

  // ---- profile update proposal (best-effort, never blocks the draft) ----
  if (person && output.profile_update_proposal.needed && output.profile_update_proposal.notes.length) {
    const context = promptThread.slice(0, 3).map((m) => `${m.isFromMe ? "Matthew" : m.fromName ?? m.fromEmail}: ${m.text.slice(0, 1500)}`).join("\n---\n");
    proposeUpdate(person.id, output.profile_update_proposal.notes, context, { threadId })
      .then(() => emit("profile", { personId: person.id }))
      .catch((e) => log.warn({ person: person.id, err: (e as Error).message }, "profile proposal failed"));
  }
  return { draftId, versionId: version.id, version: version.version, output, notes, modelKey };
}
