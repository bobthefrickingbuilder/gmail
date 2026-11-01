/** PEOPLE / PROFILE ROUTES — view, edit, versions (apply/reject/revert), merge, split, delete, pinned documents. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb, now, uid, pj } from "../db/index.js";
import { parse, notFound } from "../http.js";
import { applyProposal, deletePerson, editPerson, mergePeople, rejectProposal, revertTo, splitPerson } from "../profiles/service.js";
import { audit } from "../audit.js";
import { startSeedJob, runSeedJob } from "../profiles/seed.js";

export async function peopleRoutes(app: FastifyInstance) {
  app.get("/api/people", async (req) => {
    const { q } = parse(z.object({ q: z.string().optional() }), req.query);
    const db = await getDb();
    let query = db.selectFrom("people").select(["id", "display_name", "organization", "relationship", "vip", "last_contact_at", "language"]);
    if (q) query = query.where((eb) => eb.or([eb("display_name", "like", `%${q}%`), eb("organization", "like", `%${q}%`),
      eb("id", "in", db.selectFrom("person_addresses").select("person_id").where("email", "like", `%${q}%`))]));
    const people = await query.orderBy("last_contact_at", "desc").limit(500).execute();
    const pending = await db.selectFrom("profile_versions").select("person_id").where("status", "=", "proposed").execute();
    const pend = new Set(pending.map((p) => p.person_id));
    return people.map((p) => ({ ...p, vip: p.vip === 1, pending_update: pend.has(p.id) }));
  });

  app.get("/api/people/:id", async (req) => {
    const { id } = req.params as { id: string };
    const db = await getDb();
    const p = await db.selectFrom("people").selectAll().where("id", "=", id).executeTakeFirst();
    if (!p) throw notFound();
    const [addresses, versions, docs, threads] = await Promise.all([
      db.selectFrom("person_addresses").select("email").where("person_id", "=", id).execute(),
      db.selectFrom("profile_versions").selectAll().where("person_id", "=", id).orderBy("version", "desc").limit(50).execute(),
      db.selectFrom("pinned_docs").selectAll().where("person_id", "=", id).orderBy("created_at").execute(),
      db.selectFrom("threads").select(["id", "subject", "last_message_at", "category", "state"]).where("person_id", "=", id).orderBy("last_message_at", "desc").limit(50).execute(),
    ]);
    return { person: { ...p, vip: p.vip === 1, data: pj(p.data_json, {}), data_json: undefined }, addresses: addresses.map((a) => a.email),
      versions: versions.map((v) => ({ ...v, snapshot: pj(v.snapshot_json, {}), snapshot_json: undefined })), docs, threads };
  });

  app.put("/api/people/:id", async (req) => {
    const b = parse(z.object({
      display_name: z.string().min(1).optional(), organization: z.string().nullable().optional(), role: z.string().nullable().optional(),
      relationship: z.string().nullable().optional(), formality: z.string().nullable().optional(), tone: z.string().nullable().optional(),
      language: z.string().nullable().optional(), summary: z.string().max(4000).optional(),
      data: z.object({ topics: z.array(z.object({ topic: z.string(), status: z.string() })).optional(),
        commitments: z.array(z.object({ who: z.string(), what: z.string(), due: z.string().nullable() })).optional(),
        facts: z.array(z.string()).optional(), do_not_mention: z.array(z.string()).optional(), response_expectations: z.string().nullable().optional() }).partial().optional(),
      notes_to_assistant: z.string().max(4000).optional(), vip: z.boolean().optional(), escalate_model: z.string().nullable().optional(),
      signature_key: z.string().nullable().optional(), auto_apply_updates: z.boolean().nullable().optional(),
    }), req.body);
    return editPerson((req.params as { id: string }).id, b as Parameters<typeof editPerson>[1]);
  });

  app.post("/api/people/:id/versions/:vid/apply", async (req) => { await applyProposal((req.params as { vid: string }).vid); return { ok: true }; });
  app.post("/api/people/:id/versions/:vid/reject", async (req) => { await rejectProposal((req.params as { vid: string }).vid); return { ok: true }; });
  app.post("/api/people/:id/versions/:vid/revert", async (req) => revertTo((req.params as { vid: string }).vid));
  app.post("/api/people/:id/merge", async (req) => {
    const b = parse(z.object({ sourceId: z.string() }), req.body);
    await mergePeople((req.params as { id: string }).id, b.sourceId);
    return { ok: true };
  });
  app.post("/api/people/:id/split", async (req) => {
    const b = parse(z.object({ emails: z.array(z.string()).min(1) }), req.body);
    return { newPersonId: await splitPerson((req.params as { id: string }).id, b.emails) };
  });
  app.post("/api/people/:id/addresses", async (req) => {
    const b = parse(z.object({ email: z.string().email() }), req.body);
    const db = await getDb();
    await db.insertInto("person_addresses").values({ email: b.email.toLowerCase(), person_id: (req.params as { id: string }).id })
      .onConflict((oc) => oc.column("email").doUpdateSet({ person_id: (req.params as { id: string }).id })).execute();
    return { ok: true };
  });
  app.delete("/api/people/:id", async (req) => { await deletePerson((req.params as { id: string }).id); return { ok: true }; });

  app.post("/api/people/:id/docs", async (req) => {
    const b = parse(z.object({ title: z.string().min(1).max(200), content: z.string().min(1).max(50_000) }), req.body);
    const db = await getDb(); const id = uid();
    await db.insertInto("pinned_docs").values({ id, person_id: (req.params as { id: string }).id, title: b.title, content: b.content, created_at: now() }).execute();
    await audit("user", "profile.pin_doc", "person", (req.params as { id: string }).id);
    return { id };
  });
  app.delete("/api/people/:id/docs/:docId", async (req) => {
    const db = await getDb();
    await db.deleteFrom("pinned_docs").where("id", "=", (req.params as { docId: string }).docId).execute();
    return { ok: true };
  });

  // seeding job
  app.post("/api/jobs/seed", async (req) => {
    const b = parse(z.object({ months: z.number().min(1).max(36).default(12), top: z.number().min(1).max(200).default(40) }), req.body);
    const id = await startSeedJob(b.months, b.top);
    void runSeedJob(id);
    return { jobId: id };
  });
  app.get("/api/jobs/:id", async (req) => {
    const db = await getDb();
    const j = await db.selectFrom("jobs").select(["id", "kind", "status", "progress_json", "error", "updated_at"]).where("id", "=", (req.params as { id: string }).id).executeTakeFirstOrThrow();
    return { ...j, progress: pj(j.progress_json, {}) };
  });
  app.get("/api/jobs", async () => {
    const db = await getDb();
    return (await db.selectFrom("jobs").select(["id", "kind", "status", "progress_json", "error", "updated_at"]).orderBy("created_at", "desc").limit(10).execute())
      .map((j) => ({ ...j, progress: pj(j.progress_json, {}) }));
  });
  app.post("/api/jobs/:id/pause", async (req) => {
    const db = await getDb();
    await db.updateTable("jobs").set({ status: "paused", updated_at: now() }).where("id", "=", (req.params as { id: string }).id).execute();
    return { ok: true };
  });
  app.post("/api/jobs/:id/resume", async (req) => {
    const id = (req.params as { id: string }).id;
    void runSeedJob(id);
    return { ok: true };
  });
}
