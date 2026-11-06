/**
 * ATTACHMENT ROUTES (files on your drafts)
 *   GET    /api/attachments?kind=reply|compose&owner=<draft id>      list
 *   POST   /api/attachments?kind=…&owner=…&name=<file name>          upload: the request body is the file itself
 *   POST   /api/attachments/from-message {kind, owner, messageId, index}   re-attach a file someone sent you
 *   GET    /api/attachments/:id/download                             always a download, never shown inline
 *   DELETE /api/attachments/:id
 * After a change, a draft that is already in Gmail is updated there too, so
 * Gmail's Drafts folder always shows the same files.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "../http.js";
import { getDb, pj } from "../db/index.js";
import { mailFor } from "../providers/index.js";
import { addAttachment, getAttachment, listAttachments, MAX_TOTAL_BYTES, removeAttachment, type OwnerKind } from "../drafting/attachments.js";
import { writeDraftToGmail } from "../drafting/gmail.js";
import { emit } from "../notify/sse.js";

const Owner = z.object({ kind: z.enum(["reply", "compose"]), owner: z.string().min(1).max(100) });

/** Keep Gmail's copy in step. Replies already in Gmail are rewritten; new emails go back to "not saved" until the next Save. */
async function afterChange(kind: OwnerKind, ownerId: string) {
  const db = await getDb();
  if (kind === "reply") {
    const d = await db.selectFrom("drafts").select(["thread_id", "provider_draft_id"]).where("id", "=", ownerId).executeTakeFirstOrThrow();
    if (d.provider_draft_id) await writeDraftToGmail(ownerId);
    emit("draft", { threadId: d.thread_id, draftId: ownerId });
  } else {
    await db.updateTable("compose_drafts").set({ status: "open" }).where("id", "=", ownerId).where("status", "=", "saved").execute();
    emit("compose", { id: ownerId });
  }
}

export async function attachmentRoutes(app: FastifyInstance) {
  // Uploads arrive as the raw file. Accept any content type on this route only, up to Gmail's 25 MB.
  // (text/plain normally has its own parser, which would turn a .txt upload into a string.)
  app.removeContentTypeParser("text/plain");
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_TOTAL_BYTES + 1024 }, (_req, body, done) => done(null, body));
  const uploadLimit = { bodyLimit: MAX_TOTAL_BYTES + 1024, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

  app.get("/api/attachments", async (req) => {
    const q = parse(Owner, req.query);
    return listAttachments(q.kind, q.owner);
  });

  app.post("/api/attachments", uploadLimit, async (req) => {
    const q = parse(Owner.extend({ name: z.string().min(1).max(255) }), req.query);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const a = await addAttachment(q.kind, q.owner, { filename: q.name, mimeType: req.headers["content-type"] ?? null, data });
    await afterChange(q.kind, q.owner);
    return a;
  });

  app.post("/api/attachments/from-message", uploadLimit, async (req) => {
    const b = parse(Owner.extend({ messageId: z.string().min(1), index: z.number().int().min(0) }), req.body);
    const db = await getDb();
    const m = await db.selectFrom("messages").selectAll().where("id", "=", b.messageId).executeTakeFirstOrThrow();
    const src = pj<{ filename: string; mimeType: string; attachmentId: string | null }[]>(m.attachments_json, [])[b.index];
    if (!src?.attachmentId) throw Object.assign(new Error("That file is no longer available"), { statusCode: 404 });
    const acc = await db.selectFrom("accounts").selectAll().where("id", "=", m.account_id).executeTakeFirstOrThrow();
    const data = await mailFor(acc).getAttachment(m.provider_message_id, src.attachmentId);
    const a = await addAttachment(b.kind, b.owner, { filename: src.filename, mimeType: src.mimeType, data });
    await afterChange(b.kind, b.owner);
    return a;
  });

  app.get("/api/attachments/:id/download", async (req, reply) => {
    const a = await getAttachment((req.params as { id: string }).id);
    const ascii = a.filename.replace(/[^\w.\- ]+/g, "_");
    return reply.header("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`)
      .header("X-Content-Type-Options", "nosniff").type("application/octet-stream").send(Buffer.from(a.data_b64, "base64"));
  });

  app.delete("/api/attachments/:id", async (req) => {
    const a = await removeAttachment((req.params as { id: string }).id);
    await afterChange(a.owner_kind as OwnerKind, a.owner_id);
    return { ok: true };
  });
}
