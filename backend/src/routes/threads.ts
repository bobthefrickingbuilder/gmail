/** INBOX / THREAD ROUTES — list, view, change state (done/snooze/skip), correct triage, search. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "kysely";
import { getDb, now, pj } from "../db/index.js";
import { parse, notFound } from "../http.js";
import { correctCategory, triageMessage } from "../triage/service.js";
import { buttonState } from "../drafting/models.js";
import { schedulingCard } from "../calendar/service.js";
import { parseIcs } from "../mail/ics.js";
import { mailFor } from "../providers/index.js";
import { audit } from "../audit.js";
import { emit } from "../notify/sse.js";
import { CATEGORIES } from "../providers/llm/schemas.js";
import { signatureOptions } from "../drafting/signature.js";
import { stripQuotedText } from "../mail/quotes.js";
import type { SendAs } from "../providers/mail/types.js";

export async function threadRoutes(app: FastifyInstance) {
  app.get("/api/threads", async (req) => {
    const q = parse(z.object({
      view: z.enum(["inbox", "done", "skipped", "snoozed", "all", "attention"]).default("inbox"),
      category: z.string().optional(), status: z.enum(["drafted", "needs-review", "urgent", "scheduling", "undrafted"]).optional(),
      person: z.string().optional(), model: z.string().optional(), label: z.string().optional(), q: z.string().optional(),
      limit: z.coerce.number().max(200).default(100), before: z.string().optional(),
    }), req.query);
    const db = await getDb();
    let query = db.selectFrom("threads")
      .leftJoin("people", "people.id", "threads.person_id")
      .leftJoin("drafts", (j) => j.onRef("drafts.thread_id", "=", "threads.id").on("drafts.status", "in", ["active", "saved"]))
      .leftJoin("draft_versions", "draft_versions.id", "drafts.current_version_id")
      .select(["threads.id", "threads.subject", "threads.last_message_at", "threads.state", "threads.snooze_until", "threads.category",
        "threads.priority", "threads.summary", "threads.urgent", "threads.scheduling", "threads.draft_status", "threads.needs_attention",
        "threads.person_id", "people.display_name as person_name", "people.vip as person_vip", "drafts.id as draft_id", "drafts.status as draft_state",
        "draft_versions.confidence", "draft_versions.flags_json", "draft_versions.open_questions_json"]);
    if (q.view === "inbox") query = query.where("threads.state", "=", "open");
    else if (q.view === "attention") query = query.where("threads.needs_attention", "=", 1);
    else if (q.view !== "all") query = query.where("threads.state", "=", q.view === "snoozed" ? "snoozed" : q.view);
    if (q.category) query = query.where("threads.category", "=", q.category);
    if (q.person) query = query.where("threads.person_id", "=", q.person);
    if (q.model) query = query.where("threads.draft_status", "=", `drafted:${q.model}`);
    if (q.status === "drafted") query = query.where("threads.draft_status", "like", "drafted:%");
    if (q.status === "undrafted") query = query.where("threads.draft_status", "=", "none");
    if (q.status === "urgent") query = query.where("threads.urgent", "=", 1);
    if (q.status === "scheduling") query = query.where("threads.scheduling", "=", 1);
    if (q.status === "needs-review") query = query.where("draft_versions.confidence", "!=", "high");
    if (q.before) query = query.where("threads.last_message_at", "<", q.before);
    if (q.label) query = query.where("threads.id", "in", db.selectFrom("messages").select("thread_id").where("labels_json", "like", `%"${q.label}"%`));
    if (q.q) {
      const like = `%${q.q}%`;
      query = query.where((eb) => eb.or([eb("threads.subject", "like", like), eb("threads.summary", "like", like), eb("people.display_name", "like", like),
        eb("threads.id", "in", db.selectFrom("messages").select("thread_id").where((e2) => e2.or([e2("from_email", "like", like), e2("stripped_text", "like", like)])))]));
    }
    const rows = await query.orderBy("threads.urgent", "desc").orderBy("threads.last_message_at", "desc").limit(q.limit).execute();
    const ids = rows.map((r) => r.id);
    const latest = ids.length ? await db.selectFrom("messages").select(["thread_id", "from_name", "from_email", "snippet", "date", "is_from_me"])
      .where("thread_id", "in", ids).orderBy("date", "desc").execute() : [];
    const latestBy = new Map<string, (typeof latest)[number]>();
    for (const m of latest) if (!latestBy.has(m.thread_id)) latestBy.set(m.thread_id, m);
    return rows.map((r) => ({
      ...r, urgent: r.urgent === 1, scheduling: r.scheduling === 1, needs_attention: r.needs_attention === 1, person_vip: r.person_vip === 1,
      flags: pj<string[]>(r.flags_json, []), open_questions: pj<string[]>(r.open_questions_json, []).length, flags_json: undefined, open_questions_json: undefined,
      latest: latestBy.get(r.id) ?? null,
    }));
  });

  app.get("/api/threads/:id", async (req) => {
    const { id } = req.params as { id: string };
    const db = await getDb();
    const thread = await db.selectFrom("threads").selectAll().where("id", "=", id).executeTakeFirst();
    if (!thread) throw notFound();
    const acc = await db.selectFrom("accounts").selectAll().where("id", "=", thread.account_id).executeTakeFirstOrThrow();
    const messages = await db.selectFrom("messages").selectAll().where("thread_id", "=", id).orderBy("date", "asc").execute();
    const triage = await db.selectFrom("triage").selectAll().where("thread_id", "=", id).orderBy("created_at", "desc").execute();
    const draft = await db.selectFrom("drafts").selectAll().where("thread_id", "=", id).where("status", "in", ["active", "saved"]).orderBy("created_at", "desc").executeTakeFirst();
    const versions = draft ? await db.selectFrom("draft_versions").selectAll().where("draft_id", "=", draft.id).orderBy("version", "desc").execute() : [];
    const person = thread.person_id ? await db.selectFrom("people").select(["id", "display_name", "organization", "relationship", "vip", "language", "summary"])
      .where("id", "=", thread.person_id).executeTakeFirst() : null;
    let card = null;
    try { card = await schedulingCard(id); } catch { card = null; }
    return {
      thread: { ...thread, urgent: thread.urgent === 1, scheduling: thread.scheduling === 1 },
      messages: messages.map((m) => {
        const headers = pj<Record<string, string>>(m.headers_json, {});
        return { id: m.id, from_name: m.from_name, from_email: m.from_email, to: pj(m.to_json, []), cc: pj(m.cc_json, []), subject: m.subject,
          date: m.date, is_from_me: m.is_from_me === 1, body_text: m.body_text, new_text: m.body_text ? stripQuotedText(m.body_text) : m.stripped_text,
          purged: Boolean(m.body_purged_at), labels: pj(m.labels_json, []),
          attachments: pj<{ filename: string; mimeType: string; size: number; text?: string | null; inline: boolean }[]>(m.attachments_json, [])
            .map((a, i) => ({ index: i, filename: a.filename, mimeType: a.mimeType, size: a.size, inline: a.inline, preview: a.text ? a.text.slice(0, 1200) : null })),
          invite: headers["x-calendar-invite"] ? parseIcs(headers["x-calendar-invite"]) : null };
      }),
      triage: triage[0] ? { ...triage[0], urgent: triage[0].urgent === 1, flags: pj(triage[0].flags_json, []), scheduling: pj(triage[0].scheduling_json, {}) } : null,
      draft: draft ? { ...draft, to: pj(draft.to_json, []), cc: pj(draft.cc_json, []), share_schedule_details: draft.share_schedule_details === 1 } : null,
      versions: versions.map((v) => ({ ...v, open_questions: pj(v.open_questions_json, []), detected_dates: pj(v.detected_dates_json, []),
        calendar_actions: pj(v.calendar_actions_json, []), flags: pj(v.flags_json, []) })),
      buttons: await buttonState(thread.draft_status),
      scheduling: card,
      person,
      signatures: await signatureOptions(pj<SendAs[]>(acc.send_as_json, [])),
      categories: CATEGORIES,
    };
  });

  app.post("/api/threads/:id/state", async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ state: z.enum(["open", "done", "snoozed", "skipped"]), snooze_until: z.string().nullable().optional() }), req.body);
    const db = await getDb();
    await db.updateTable("threads").set({ state: b.state, snooze_until: b.state === "snoozed" ? b.snooze_until ?? new Date(Date.now() + 86400_000).toISOString() : null,
      needs_attention: b.state === "open" ? undefined : 0, updated_at: now() }).where("id", "=", id).execute();
    await audit("user", `thread.${b.state}`, "thread", id);
    emit("thread", { threadId: id });
    return { ok: true };
  });

  app.post("/api/threads/:id/triage", async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ category: z.enum(CATEGORIES) }), req.body);
    const r = await correctCategory(id, b.category);
    emit("thread", { threadId: id });
    return r;
  });

  app.post("/api/threads/:id/retriage", async (req) => {
    const { id } = req.params as { id: string };
    const db = await getDb();
    const m = await db.selectFrom("messages").select("id").where("thread_id", "=", id).where("is_from_me", "=", 0).orderBy("date", "desc").limit(1).executeTakeFirstOrThrow();
    return triageMessage(m.id, { force: true });
  });

  app.get("/api/messages/:id/attachments/:index", async (req, reply) => {
    const { id, index } = req.params as { id: string; index: string };
    const db = await getDb();
    const m = await db.selectFrom("messages").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    const a = pj<{ filename: string; mimeType: string; attachmentId: string | null }[]>(m.attachments_json, [])[Number(index)];
    if (!a?.attachmentId) throw notFound("Attachment not available");
    const acc = await db.selectFrom("accounts").selectAll().where("id", "=", m.account_id).executeTakeFirstOrThrow();
    const data = await mailFor(acc).getAttachment(m.provider_message_id, a.attachmentId);
    const safeName = a.filename.replace(/[^\w.\- ]+/g, "_");
    // Always served as a download (never rendered inline) so attachment HTML cannot run in the app.
    return reply.header("Content-Disposition", `attachment; filename="${safeName}"`).header("X-Content-Type-Options", "nosniff")
      .type(/^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(a.mimeType) ? a.mimeType : "application/octet-stream").send(data);
  });

  app.get("/api/search", async (req) => {
    const { q } = parse(z.object({ q: z.string().min(2) }), req.query);
    const like = `%${q}%`;
    const db = await getDb();
    const [emails, people, drafts] = await Promise.all([
      db.selectFrom("messages").select(["id", "thread_id", "subject", "from_name", "from_email", "date", "snippet"])
        .where((eb) => eb.or([eb("subject", "like", like), eb("from_email", "like", like), eb("from_name", "like", like), eb("stripped_text", "like", like)]))
        .orderBy("date", "desc").limit(30).execute(),
      db.selectFrom("people").select(["id", "display_name", "organization", "relationship"])
        .where((eb) => eb.or([eb("display_name", "like", like), eb("organization", "like", like), eb("summary", "like", like),
          eb("id", "in", db.selectFrom("person_addresses").select("person_id").where("email", "like", like))])).limit(20).execute(),
      db.selectFrom("draft_versions").innerJoin("drafts", "drafts.id", "draft_versions.draft_id")
        .select(["drafts.thread_id", "draft_versions.subject", "draft_versions.created_at", sql<string>`substr(draft_versions.body, 1, 160)`.as("excerpt")])
        .where("draft_versions.body", "like", like).orderBy("draft_versions.created_at", "desc").limit(20).execute(),
    ]);
    return { emails, people, drafts };
  });
}
