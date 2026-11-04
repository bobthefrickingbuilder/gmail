/** INBOX / THREAD ROUTES — list (Focused hides low-value mail), view, change state (done/snooze/skip), read/unread, no reply needed,
 *  junk sender (always skip a sender or domain, optionally report spam to Gmail), correct triage, search. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "kysely";
import { getDb, now, pj } from "../db/index.js";
import { parse, notFound, HttpError } from "../http.js";
import { correctCategory, triageMessage } from "../triage/service.js";
import { buttonState } from "../drafting/models.js";
import { schedulingCard } from "../calendar/service.js";
import { parseIcs } from "../mail/ics.js";
import { mailFor } from "../providers/index.js";
import { listThreads, setThreadState, setThreadRead, junkSender, changeThreadLabels } from "../threads/service.js";
import { audit } from "../audit.js";
import { emit } from "../notify/sse.js";
import { discardDraft } from "../drafting/service.js";
import { CATEGORIES } from "../providers/llm/schemas.js";
import { signatureOptions } from "../drafting/signature.js";
import { stripQuotedText } from "../mail/quotes.js";
import { analyzeThread, addSuggestion, dismissSuggestion } from "../analysis/service.js";
import type { SendAs } from "../providers/mail/types.js";

export { LOW_VALUE } from "../threads/service.js";

export async function threadRoutes(app: FastifyInstance) {
  app.get("/api/threads", async (req) => {
    const q = parse(z.object({
      view: z.enum(["inbox", "done", "skipped", "snoozed", "all", "attention"]).default("inbox"),
      category: z.string().optional(), status: z.enum(["drafted", "needs-review", "urgent", "scheduling", "undrafted"]).optional(),
      person: z.string().optional(), model: z.string().optional(), label: z.string().optional(), q: z.string().optional(),
      limit: z.coerce.number().max(200).default(100), before: z.string().optional(),
      sort: z.enum(["smart", "date"]).default("smart"),
      focus: z.enum(["0", "1"]).default("0"),
    }), req.query);
    return listThreads({ ...q, focus: q.focus === "1" });
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
      thread: { ...thread, urgent: thread.urgent === 1, scheduling: thread.scheduling === 1,
        unread: messages.some((m) => m.is_from_me === 0 && pj<string[]>(m.labels_json, []).includes("UNREAD")) },
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
    await setThreadState(id, b.state, b.snooze_until);
    return { ok: true };
  });

  // Read / unread, kept in step with Gmail (changes made in Gmail arrive with the next sync)
  app.post("/api/threads/:id/read", async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ read: z.boolean() }), req.body);
    await setThreadRead(id, b.read);
    return { ok: true };
  });

  // "No reply needed": discard any draft (also in Gmail Drafts) and move the thread to Done
  app.post("/api/threads/:id/no-reply", async (req) => {
    const { id } = req.params as { id: string };
    const db = await getDb();
    if (!(await db.selectFrom("threads").select("id").where("id", "=", id).executeTakeFirst())) throw notFound();
    for (const d of await db.selectFrom("drafts").select("id").where("thread_id", "=", id).where("status", "in", ["active", "saved"]).execute())
      await discardDraft(d.id);
    await db.updateTable("threads").set({ state: "done", snooze_until: null, needs_attention: 0, updated_at: now() }).where("id", "=", id).execute();
    await audit("user", "thread.no_reply", "thread", id);
    emit("thread", { threadId: id });
    return { ok: true };
  });

  // Junk: future mail from this sender (or their whole domain) skips the inbox; this thread and their other
  // open threads move to Skipped. spam=true also moves this thread to Gmail's Spam folder.
  app.post("/api/threads/:id/junk", async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ scope: z.enum(["sender", "domain"]).default("sender"), spam: z.boolean().default(false) }), req.body ?? {});
    const r = await junkSender(id, b.scope, b.spam);
    return { ok: true, ...r };
  });

  // Your own Gmail labels on a thread (created in Gmail if missing)
  app.post("/api/threads/:id/labels", async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ add: z.array(z.string().max(100)).max(10).default([]), remove: z.array(z.string().max(100)).max(10).default([]) }), req.body ?? {});
    await changeThreadLabels(id, b.add, b.remove);
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

  // To-do / calendar suggestions found in the email (analysis/service.ts). Nothing is added until you press a button.
  app.get("/api/threads/:id/analysis", async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(z.object({ force: z.string().optional() }), req.query);
    return analyzeThread(id, { force: q.force === "1" });
  });
  app.post("/api/threads/:id/analysis/:key/add", async (req) => {
    const { id, key } = req.params as { id: string; key: string };
    const b = parse(z.object({ title: z.string().min(1).max(200).optional(), start: z.string().optional(), due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }), req.body ?? {});
    return addSuggestion(id, key, b);
  });
  app.post("/api/threads/:id/analysis/:key/dismiss", async (req) => {
    const { id, key } = req.params as { id: string; key: string };
    return dismissSuggestion(id, key);
  });
}
