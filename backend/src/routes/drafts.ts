/**
 * DRAFT ROUTES
 *   GET  /api/drafts                every unsent draft: replies + new emails, newest first
 *   POST /api/threads/:id/draft     draft / redraft (model + optional instruction)
 *   PUT  /api/drafts/:id            your edits (new "user" version)
 *   POST /api/drafts/:id/save       save the current version to Gmail
 *   POST /api/drafts/:id/revert     make an older version current
 *   DELETE /api/drafts/:id          discard (deletes the Gmail draft)
 *   POST /api/drafts/:id/send/prepare  → what will be sent + one-time token
 *   POST /api/drafts/:id/send          {token} → sends. The ONLY send path.
 *   POST /api/scratch               draft from shared text (Android share sheet); not saved to Gmail
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "../http.js";
import { draftThread } from "../drafting/pipeline.js";
import { discardDraft, editDraft, revertDraft, saveToGmail } from "../drafting/service.js";
import { confirmSend, prepareSend } from "../drafting/send.js";
import { getLlm } from "../providers/index.js";
import { DraftOutput } from "../providers/llm/schemas.js";
import { buildDraftPrompt, DEFAULT_OWNER } from "../drafting/prompt.js";
import { getModels, getSettings, getStyleGuide } from "../settings.js";
import { recordUsage } from "../usage/cost.js";
import { todayString } from "../time.js";
import { postCheck } from "../drafting/postcheck.js";
import { INJECTION_RE } from "../security/injection.js";
import { getDb, pj } from "../db/index.js";

const Address = z.object({ name: z.string().nullable(), email: z.string().email() });
type Addr = z.infer<typeof Address>;

const preview = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 240);

export async function draftRoutes(app: FastifyInstance) {
  const draftLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

  app.get("/api/drafts", async (req) => {
    const q = parse(z.object({ kind: z.enum(["all", "reply", "new"]).default("all"), q: z.string().max(200).optional() }), req.query);
    const db = await getDb();
    const replies = q.kind === "new" ? [] : await db.selectFrom("drafts")
      .innerJoin("threads", "threads.id", "drafts.thread_id")
      .leftJoin("draft_versions", "draft_versions.id", "drafts.current_version_id")
      .leftJoin("people", "people.id", "threads.person_id")
      .select(["drafts.id", "drafts.thread_id", "drafts.status", "drafts.to_json", "drafts.provider_draft_id", "drafts.updated_at",
        "threads.subject as thread_subject", "people.display_name as person_name",
        "draft_versions.subject", "draft_versions.body", "draft_versions.origin", "draft_versions.model_key", "draft_versions.confidence",
        "draft_versions.flags_json", "draft_versions.open_questions_json", "draft_versions.created_at as version_at"])
      .where("drafts.status", "in", ["active", "saved"]).orderBy("drafts.updated_at", "desc").limit(200).execute();
    const composed = q.kind === "reply" ? [] : await db.selectFrom("compose_drafts").selectAll()
      .where("status", "in", ["open", "saved"]).orderBy("updated_at", "desc").limit(200).execute();

    const rows = [
      ...replies.map((d) => ({
        kind: "reply" as const, id: d.id, thread_id: d.thread_id, subject: d.subject || d.thread_subject, to: pj<Addr[]>(d.to_json, []),
        person_name: d.person_name, preview: preview(d.body ?? ""), origin: d.origin, model_key: d.model_key, confidence: d.confidence,
        flags: pj<string[]>(d.flags_json, []), open_questions: pj<string[]>(d.open_questions_json, []).length,
        in_gmail: Boolean(d.provider_draft_id), updated_at: [d.updated_at, d.version_at ?? ""].sort().at(-1)!,
      })),
      ...composed.map((c) => ({
        kind: "new" as const, id: c.id, thread_id: null, subject: c.subject, to: pj<Addr[]>(c.to_json, []), person_name: null,
        preview: preview(c.body), origin: "user", model_key: null, confidence: null, flags: [] as string[], open_questions: 0,
        in_gmail: Boolean(c.provider_draft_id), updated_at: c.updated_at,
      })),
    ];
    const needle = q.q?.trim().toLowerCase();
    return rows
      .filter((r) => !needle || [r.subject, r.preview, r.person_name ?? "", ...r.to.flatMap((a) => [a.name ?? "", a.email])].some((s) => s.toLowerCase().includes(needle)))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  });

  app.post("/api/threads/:id/draft", draftLimit, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ model: z.string().optional(), instruction: z.string().max(2000).nullable().optional(),
      shareScheduleDetails: z.boolean().optional() }), req.body);
    const r = await draftThread(id, { modelKey: b.model, instruction: b.instruction ?? null, shareScheduleDetails: b.shareScheduleDetails, actor: "user" });
    return { draftId: r.draftId, versionId: r.versionId, version: r.version, model: r.modelKey, notes: r.notes };
  });

  app.put("/api/drafts/:id", async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ body: z.string().max(100_000).optional(), subject: z.string().max(500).optional(), to: z.array(Address).optional(),
      cc: z.array(Address).optional(), reply_mode: z.enum(["reply", "reply_all"]).optional(), signature_key: z.string().nullable().optional(),
      share_schedule_details: z.boolean().optional() }), req.body);
    return editDraft(id, b);
  });

  app.post("/api/drafts/:id/save", async (req) => saveToGmail((req.params as { id: string }).id));
  app.post("/api/drafts/:id/revert", async (req) => {
    const b = parse(z.object({ versionId: z.string() }), req.body);
    await revertDraft((req.params as { id: string }).id, b.versionId);
    return { ok: true };
  });
  app.delete("/api/drafts/:id", async (req) => { await discardDraft((req.params as { id: string }).id); return { ok: true }; });

  app.post("/api/drafts/:id/send/prepare", async (req) => prepareSend((req.params as { id: string }).id));
  app.post("/api/drafts/:id/send", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const b = parse(z.object({ token: z.string().min(10), confirm: z.literal(true) }), req.body);
    return confirmSend((req.params as { id: string }).id, b.token);
  });

  app.post("/api/scratch", draftLimit, async (req) => {
    const b = parse(z.object({ text: z.string().min(1).max(30000), instruction: z.string().max(2000).optional(), model: z.string().optional() }), req.body);
    const models = await getModels(); const s = await getSettings();
    const modelKey = b.model ?? models.default_draft_model;
    const { system, user } = buildDraftPrompt({ ownerDescription: DEFAULT_OWNER, styleGuide: await getStyleGuide(), profile: null, pinnedDocs: [],
      thread: [{ fromName: "Shared text", fromEmail: "shared@local", isFromMe: false, date: new Date().toISOString(), subject: "Shared text", text: b.text, attachments: [] }],
      availability: null, shareScheduleDetails: false, instruction: b.instruction ?? null, examples: [], replyLanguageHint: null, today: todayString(s.timezone), recipients: { to: [], cc: [] } });
    const res = await getLlm().complete({ modelKey, purpose: "draft", system, user, schema: DraftOutput, schemaName: "draft", maxTokens: models.max_output_tokens.draft });
    await recordUsage({ purpose: "draft", modelKey, modelId: res.modelId, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd });
    return postCheck(res.data, { eventSummaries: [], shareScheduleDetails: false, injectionSuspected: INJECTION_RE.test(b.text) }).output;
  });
}
