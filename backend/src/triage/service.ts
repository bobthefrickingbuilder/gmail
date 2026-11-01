/**
 * TRIAGE SERVICE
 * Runs stage 1 (rules) and, if the email survives, stage 2 (Haiku): a
 * category, a 0–100 priority, a one-line summary and the reasoning. Your
 * one-tap corrections are stored and fed back in as examples next time.
 */
import { getDb, now, uid, j, pj } from "../db/index.js";
import { applyRules, deadlineWithin, keywordUrgent } from "./rules.js";
import { getModels, getSettings, getTriageRules } from "../settings.js";
import { getLlm } from "../providers/index.js";
import { TriageOutput } from "../providers/llm/schemas.js";
import { buildTriageSystem, buildTriageUser } from "../drafting/prompt.js";
import { recordUsage } from "../usage/cost.js";
import { loadParsed } from "../mail/store.js";
import { audit } from "../audit.js";
import { INJECTION_RE } from "../providers/llm/mock.js";
import { parseIcs } from "../mail/ics.js";
import { todayString } from "../time.js";

export interface TriageDecision {
  triageId: string;
  category: string;
  priority: number;
  urgent: boolean;
  skipped: boolean;
  scheduling: boolean;
  vip: boolean;
  escalateModel: string | null;
  flags: string[];
}

export async function triageMessage(messageId: string, opts: { force?: boolean } = {}): Promise<TriageDecision> {
  const db = await getDb();
  const existing = await db.selectFrom("triage").selectAll().where("message_id", "=", messageId).orderBy("created_at", "desc").executeTakeFirst();
  const m = await loadParsed(messageId);
  const settings = await getSettings();
  const cfg = await getTriageRules();
  const senderRules = await db.selectFrom("sender_rules").select(["match", "action", "value"]).execute();
  const person = await db.selectFrom("person_addresses").innerJoin("people", "people.id", "person_addresses.person_id")
    .select(["people.vip", "people.escalate_model"]).where("person_addresses.email", "=", m.from.email).executeTakeFirst();
  const rules = applyRules({ fromEmail: m.from.email, labels: m.labels, headers: m.headers, isFromMe: m.isFromMe }, cfg, senderRules,
    [...settings.vip_emails, ...(person?.vip ? [m.from.email] : [])]);
  const escalateModel = rules.escalateModel ?? person?.escalate_model ?? null;

  if (existing && !opts.force) {
    return { triageId: existing.id, category: existing.corrected_category ?? existing.category, priority: existing.priority,
      urgent: existing.urgent === 1, skipped: existing.stage === "rules" && existing.category !== "needs-reply" && rules.skip,
      scheduling: pj<{ detected?: boolean }>(existing.scheduling_json, {}).detected === true, vip: rules.vip, escalateModel, flags: pj(existing.flags_json, []) };
  }

  const ts = now();
  const id = uid();
  let category: string, priority: number, summary: string, reasoning: string, urgent = false, scheduling: unknown = { detected: false };
  let flags: string[] = [], stage = "rules", modelKey: string | null = null;

  const invite = m.calendarInvite ? parseIcs(m.calendarInvite) : null;
  if (rules.skip || rules.category) {
    category = rules.category ?? "other";
    priority = rules.skip ? 5 : 50;
    summary = m.subject || m.snippet.slice(0, 80);
    reasoning = rules.reason ?? `Category set by sender rule`;
  } else {
    const models = await getModels();
    const corrections = await db.selectFrom("triage_corrections").selectAll().orderBy("created_at", "desc").limit(30).execute();
    const ranked = [...corrections.filter((c) => c.from_email === m.from.email), ...corrections.filter((c) => c.from_email !== m.from.email)].slice(0, 8);
    const res = await getLlm().complete({
      modelKey: models.triage_model, purpose: "triage", schemaName: "triage", schema: TriageOutput, maxTokens: models.max_output_tokens.triage,
      system: buildTriageSystem(cfg.categories, settings.urgent_keywords, rules.vip),
      user: buildTriageUser({ fromName: m.from.name, fromEmail: m.from.email, isFromMe: false, date: m.date, subject: m.subject,
        text: m.strippedText + (invite ? `\n[calendar invitation: ${invite.summary ?? ""} ${invite.start ?? ""}–${invite.end ?? ""}]` : ""),
        attachments: m.attachments, to: m.to.map((a) => a.email), cc: m.cc.map((a) => a.email), labels: m.labels },
        todayString(settings.timezone), ranked.map((c) => ({ from: c.from_email, subject: c.subject, summary: c.summary, to: c.to_category }))),
    });
    await recordUsage({ purpose: "triage", modelKey: res.modelKey, modelId: res.modelId, inputTokens: res.inputTokens,
      outputTokens: res.outputTokens, costUsd: res.costUsd, threadId: m.threadId });
    const o = res.data;
    stage = "model"; modelKey = res.modelKey;
    category = o.category; priority = Math.max(0, Math.min(100, Math.round(o.priority)));
    summary = o.summary; reasoning = o.reasoning; urgent = o.urgent || deadlineWithin(o.deadline, cfg.urgent_deadline_hours);
    scheduling = o.scheduling; flags = o.flags;
    if (invite && !o.scheduling.detected) scheduling = { ...o.scheduling, detected: true, kind: "invitation",
      proposed_times: [{ text: invite.summary ?? "Invitation", start: invite.start, end: invite.end }], requested_range: null };
  }

  // Deterministic checks that don't depend on the model:
  const kw = keywordUrgent(`${m.subject}\n${m.strippedText}`, settings.urgent_keywords);
  if (!rules.skip && (kw || rules.vip)) urgent = true;
  if (!rules.skip && INJECTION_RE.test(`${m.subject}\n${m.text}`) && !flags.includes("possible_prompt_injection")) flags.push("possible_prompt_injection");
  if (urgent && category !== "urgent" && !rules.skip) reasoning += kw ? ` Urgent keyword: "${kw}".` : rules.vip ? " VIP sender." : "";
  if (rules.vip) priority = Math.max(priority, 75);
  const schedDetected = (scheduling as { detected?: boolean }).detected === true || category === "scheduling";

  await db.insertInto("triage").values({ id, message_id: messageId, thread_id: m.threadId, stage, category, priority, summary, reasoning,
    urgent: urgent ? 1 : 0, scheduling_json: j(scheduling), flags_json: j(flags), model_key: modelKey, corrected_category: null, created_at: ts }).execute();
  const isLatest = await isLatestMessage(m.threadId, messageId);
  if (isLatest) {
    await db.updateTable("threads").set({ category, priority, summary, urgent: urgent ? 1 : 0, scheduling: schedDetected ? 1 : 0, updated_at: ts })
      .where("id", "=", m.threadId).execute();
    if (rules.skip) await db.updateTable("threads").set({ state: "skipped" }).where("id", "=", m.threadId).where("state", "=", "open").execute();
    else await db.updateTable("threads").set({ state: "open" }).where("id", "=", m.threadId).where("state", "=", "skipped").execute();
  }
  await audit("worker", "triage", "message", messageId, { category, stage, urgent, flags });
  return { triageId: id, category, priority, urgent, skipped: rules.skip, scheduling: schedDetected, vip: rules.vip, escalateModel, flags };
}

async function isLatestMessage(threadId: string, messageId: string) {
  const db = await getDb();
  const latest = await db.selectFrom("messages").select("id").where("thread_id", "=", threadId).orderBy("date", "desc").limit(1).executeTakeFirst();
  return latest?.id === messageId;
}

/** One-tap correction from the app. Stored and reused as a few-shot example. */
export async function correctCategory(threadId: string, toCategory: string) {
  const db = await getDb();
  const msg = await db.selectFrom("messages").selectAll().where("thread_id", "=", threadId).where("is_from_me", "=", 0)
    .orderBy("date", "desc").limit(1).executeTakeFirstOrThrow();
  const tri = await db.selectFrom("triage").selectAll().where("message_id", "=", msg.id).orderBy("created_at", "desc").executeTakeFirst();
  const from = tri?.corrected_category ?? tri?.category ?? "other";
  if (tri) await db.updateTable("triage").set({ corrected_category: toCategory }).where("id", "=", tri.id).execute();
  await db.insertInto("triage_corrections").values({ id: uid(), message_id: msg.id, from_category: from, to_category: toCategory,
    from_email: msg.from_email, subject: msg.subject, summary: tri?.summary ?? "", created_at: now() }).execute();
  await db.updateTable("threads").set({ category: toCategory, state: "open", updated_at: now() }).where("id", "=", threadId).execute();
  await audit("user", "triage.correct", "thread", threadId, { from, to: toCategory });
  return { from, to: toCategory };
}
