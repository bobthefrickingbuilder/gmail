/**
 * NEW EMAIL + CONTACTS ROUTES
 *   GET    /api/compose              your unsent new emails
 *   POST   /api/compose              start one {to, cc, bcc, subject, body}
 *   GET    /api/compose/:id
 *   PUT    /api/compose/:id          your edits (autosaved by the app)
 *   POST   /api/compose/:id/write    Claude writes/polishes the text {instruction, model}
 *   POST   /api/compose/:id/save     save into Gmail Drafts
 *   DELETE /api/compose/:id          discard (deletes the Gmail draft)
 *   POST   /api/compose/:id/send/prepare  → what will be sent + one-time token
 *   POST   /api/compose/:id/send          {token, confirm:true} → sends
 *   GET    /api/contacts?q=          address autocomplete
 *   GET    /api/contacts/status      last refresh, whether Google contacts are connected
 *   POST   /api/contacts/sync        refresh now
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { parse } from "../http.js";
import { composeView, createCompose, discardCompose, getCompose, saveComposeToGmail, updateCompose, writeCompose } from "../compose/service.js";
import { confirmComposeSend, prepareComposeSend } from "../drafting/send.js";
import { contactsStatus, searchContacts, syncContacts, syncContactsIfStale } from "../contacts/service.js";

const Address = z.object({ name: z.string().max(200).nullable(), email: z.string().email() });
const Patch = z.object({ to: z.array(Address).max(100).optional(), cc: z.array(Address).max(100).optional(), bcc: z.array(Address).max(100).optional(),
  subject: z.string().max(500).optional(), body: z.string().max(100_000).optional(), from_email: z.string().email().optional() });

export async function composeRoutes(app: FastifyInstance) {
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get("/api/compose", async () => {
    const rows = await (await getDb()).selectFrom("compose_drafts").selectAll().where("status", "in", ["open", "saved"]).orderBy("updated_at", "desc").limit(100).execute();
    return rows.map(composeView);
  });
  app.post("/api/compose", async (req) => createCompose(parse(Patch, req.body ?? {})));
  app.get("/api/compose/:id", async (req) => composeView(await getCompose(id(req))));
  app.put("/api/compose/:id", async (req) => updateCompose(id(req), parse(Patch, req.body)));
  app.post("/api/compose/:id/write", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const b = parse(z.object({ instruction: z.string().min(1).max(2000), model: z.string().optional() }), req.body);
    return writeCompose(id(req), b.instruction, b.model);
  });
  app.post("/api/compose/:id/save", async (req) => { await saveComposeToGmail(id(req)); return composeView(await getCompose(id(req))); });
  app.delete("/api/compose/:id", async (req) => { await discardCompose(id(req)); return { ok: true }; });
  app.post("/api/compose/:id/send/prepare", async (req) => prepareComposeSend(id(req)));
  app.post("/api/compose/:id/send", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const b = parse(z.object({ token: z.string().min(10), confirm: z.literal(true) }), req.body);
    return confirmComposeSend(id(req), b.token);
  });

  app.get("/api/contacts", async (req) => {
    const q = parse(z.object({ q: z.string().max(100).default(""), limit: z.coerce.number().min(1).max(20).default(8) }), req.query);
    const s = await contactsStatus();
    if (!s.last_sync_at) await syncContactsIfStale(); // first use: build the list now
    return searchContacts(q.q, q.limit);
  });
  app.get("/api/contacts/status", async () => contactsStatus());
  app.post("/api/contacts/sync", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async () => syncContacts());
}
