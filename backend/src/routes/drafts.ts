/**
 * DRAFT ROUTES
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
import { INJECTION_RE } from "../providers/llm/mock.js";

const Address = z.object({ name: z.string().nullable(), email: z.string().email() });

export async function draftRoutes(app: FastifyInstance) {
  const draftLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

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
