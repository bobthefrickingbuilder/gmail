/**
 * CHAT ROUTES — the in-app chat with Claude (chat/service.ts).
 *   GET    /api/chat                     your chats (newest first) + model choices
 *   POST   /api/chat                     start a chat {thread_id?, model?}
 *   GET    /api/chat/:id                 messages, tool activity, pending confirm cards
 *   PATCH  /api/chat/:id                 {model}
 *   DELETE /api/chat/:id                 delete the chat
 *   POST   /api/chat/:id/messages        {text, model?} → streamed reply (NDJSON: one ChatEvent per line)
 *   POST   /api/chat/actions/:id/confirm runs a proposed change (discard, junk, calendar, bulk…)
 *   POST   /api/chat/actions/:id/cancel
 * Nothing here can send email.
 */
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, HttpError } from "../http.js";
import { getModels } from "../settings.js";
import { createConversation, deleteConversation, getConversation, listConversations, runTurn, setConversationModel, type ChatEvent } from "../chat/service.js";
import { cancelAction, confirmAction } from "../chat/tools.js";
import { LlmRefusalError } from "../providers/llm/types.js";
import { getDb } from "../db/index.js";
import { emit } from "../notify/sse.js";
import { log } from "../log.js";

export async function chatRoutes(app: FastifyInstance) {
  const turnLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
  const actionLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

  app.get("/api/chat", async () => {
    const m = await getModels();
    return { chats: await listConversations(), default_model: m.chat_model,
      models: Object.entries(m.models).map(([key, v]) => ({ key, label: v.label })) };
  });

  app.post("/api/chat", async (req) => {
    const b = parse(z.object({ thread_id: z.string().max(100).nullable().optional(), model: z.string().max(40).nullable().optional() }), req.body ?? {});
    return createConversation({ threadId: b.thread_id, model: b.model });
  });

  app.get("/api/chat/:id", async (req) => getConversation((req.params as { id: string }).id));

  app.patch("/api/chat/:id", async (req) => {
    const b = parse(z.object({ model: z.string().max(40) }), req.body);
    return setConversationModel((req.params as { id: string }).id, b.model);
  });

  app.delete("/api/chat/:id", async (req) => { await deleteConversation((req.params as { id: string }).id); return { ok: true }; });

  app.post("/api/chat/:id/messages", turnLimit, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ text: z.string().trim().min(1).max(4000), model: z.string().max(40).optional() }), req.body);
    // fail fast (proper status codes) before the stream starts
    if (!(await (await getDb()).selectFrom("chat_conversations").select("id").where("id", "=", id).executeTakeFirst())) throw new HttpError(404, "Chat not found");

    const stream = new PassThrough();
    const write = (e: ChatEvent) => { if (!stream.writableEnded) stream.write(JSON.stringify(e) + "\n"); };
    void (async () => {
      try {
        await runTurn(id, b.text, write, { model: b.model });
      } catch (e) {
        const err = e as Error & { statusCode?: number };
        const safe = err instanceof HttpError || err instanceof LlmRefusalError ? err.message
          : err.statusCode && err.statusCode < 500 ? err.message : "Claude couldn't finish that — please try again.";
        if (!(err instanceof HttpError)) log.error({ chat: id, err: err.message }, "chat turn failed");
        write({ type: "error", error: safe });
      } finally {
        stream.end();
        emit("chat", { id });
      }
    })();
    return reply.type("application/x-ndjson; charset=utf-8").header("Cache-Control", "no-cache, no-transform").header("X-Accel-Buffering", "no").send(stream);
  });

  app.post("/api/chat/actions/:id/confirm", actionLimit, async (req) => {
    const r = await confirmAction((req.params as { id: string }).id);
    emit("chat", {});
    return r;
  });
  app.post("/api/chat/actions/:id/cancel", actionLimit, async (req) => {
    const r = await cancelAction((req.params as { id: string }).id);
    emit("chat", {});
    return r;
  });
}
