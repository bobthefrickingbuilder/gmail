/**
 * THREAD ACTIONS — list/search threads, change state (done/snooze/skip/open),
 * read/unread (kept in step with Gmail), user labels, and junk-sender rules.
 * Shared by the inbox routes (routes/threads.ts) and the in-app chat
 * (chat/tools.ts), so both behave exactly the same.
 */
import { sql } from "kysely";
import { getDb, now, pj } from "../db/index.js";
import { notFound, HttpError } from "../http.js";
import { mailFor } from "../providers/index.js";
import { audit, type Actor } from "../audit.js";
import { emit } from "../notify/sse.js";
import { discardDraft } from "../drafting/service.js";
import { AI_LABELS } from "../drafting/gmail.js";

export const LOW_VALUE = ["newsletter", "fyi", "other"];
const PERSONAL_PROVIDERS = /^@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail)\.[a-z.]+$/;

export type ThreadState = "open" | "done" | "snoozed" | "skipped";

export interface ThreadQuery {
  view?: "inbox" | "done" | "skipped" | "snoozed" | "all" | "attention";
  category?: string; status?: "drafted" | "needs-review" | "urgent" | "scheduling" | "undrafted";
  person?: string; model?: string; label?: string; q?: string;
  /** sender name or address (substring) */
  from?: string;
  limit?: number; before?: string; sort?: "smart" | "date"; focus?: boolean;
}

export async function listThreads(q: ThreadQuery) {
  const view = q.view ?? "inbox";
  const db = await getDb();
  let query = db.selectFrom("threads")
    .leftJoin("people", "people.id", "threads.person_id")
    .leftJoin("drafts", (j) => j.onRef("drafts.thread_id", "=", "threads.id").on("drafts.status", "in", ["active", "saved"]))
    .leftJoin("draft_versions", "draft_versions.id", "drafts.current_version_id")
    .select(["threads.id", "threads.subject", "threads.last_message_at", "threads.state", "threads.snooze_until", "threads.category",
      "threads.priority", "threads.summary", "threads.urgent", "threads.scheduling", "threads.draft_status", "threads.needs_attention",
      "threads.person_id", "people.display_name as person_name", "people.vip as person_vip", "drafts.id as draft_id", "drafts.status as draft_state",
      "draft_versions.confidence", "draft_versions.flags_json", "draft_versions.open_questions_json",
      sql<number>`exists(select 1 from messages m where m.thread_id = threads.id and m.is_from_me = 0 and m.labels_json like '%"UNREAD"%')`.as("unread")]);
  if (view === "inbox") query = query.where("threads.state", "=", "open");
  else if (view === "attention") query = query.where("threads.needs_attention", "=", 1);
  else if (view !== "all") query = query.where("threads.state", "=", view);
  if (q.category) query = query.where("threads.category", "=", q.category);
  if (q.person) query = query.where("threads.person_id", "=", q.person);
  if (q.model) query = query.where("threads.draft_status", "=", `drafted:${q.model}`);
  if (q.status === "drafted") query = query.where("threads.draft_status", "like", "drafted:%");
  if (q.status === "undrafted") query = query.where("threads.draft_status", "=", "none");
  if (q.status === "urgent") query = query.where("threads.urgent", "=", 1);
  if (q.status === "scheduling") query = query.where("threads.scheduling", "=", 1);
  if (q.status === "needs-review") query = query.where("draft_versions.confidence", "!=", "high");
  if (q.before) query = query.where("threads.last_message_at", "<", q.before);
  // Focused: hide newsletters, FYI and "other" mail unless it's urgent (untriaged mail stays visible)
  if (q.focus) query = query.where((eb) => eb.or([eb("threads.category", "is", null), eb("threads.category", "not in", LOW_VALUE), eb("threads.urgent", "=", 1)]));
  if (q.label) query = query.where("threads.id", "in", db.selectFrom("messages").select("thread_id").where("labels_json", "like", `%"${q.label}"%`));
  if (q.from) {
    const like = `%${q.from}%`;
    query = query.where((eb) => eb.or([eb("people.display_name", "like", like),
      eb("threads.id", "in", db.selectFrom("messages").select("thread_id").where("is_from_me", "=", 0)
        .where((e2) => e2.or([e2("from_email", "like", like), e2("from_name", "like", like)])))]));
  }
  if (q.q) {
    const like = `%${q.q}%`;
    query = query.where((eb) => eb.or([eb("threads.subject", "like", like), eb("threads.summary", "like", like), eb("people.display_name", "like", like),
      eb("threads.id", "in", db.selectFrom("messages").select("thread_id").where((e2) => e2.or([e2("from_email", "like", like), e2("from_name", "like", like), e2("stripped_text", "like", like)])))]));
  }
  if ((q.sort ?? "smart") === "smart") query = query.orderBy("threads.urgent", "desc");
  const rows = await query.orderBy("threads.last_message_at", "desc").limit(q.limit ?? 100).execute();
  const ids = rows.map((r) => r.id);
  const latest = ids.length ? await db.selectFrom("messages").select(["thread_id", "from_name", "from_email", "snippet", "date", "is_from_me"])
    .where("thread_id", "in", ids).orderBy("date", "desc").execute() : [];
  const latestBy = new Map<string, (typeof latest)[number]>();
  for (const m of latest) if (!latestBy.has(m.thread_id)) latestBy.set(m.thread_id, m);
  return rows.map((r) => ({
    ...r, urgent: r.urgent === 1, scheduling: r.scheduling === 1, needs_attention: r.needs_attention === 1, person_vip: r.person_vip === 1, unread: r.unread === 1,
    flags: pj<string[]>(r.flags_json, []), open_questions: pj<string[]>(r.open_questions_json, []).length, flags_json: undefined, open_questions_json: undefined,
    latest: latestBy.get(r.id) ?? null,
  }));
}

export async function setThreadState(id: string, state: ThreadState, snoozeUntil?: string | null, actor: Actor = "user") {
  const db = await getDb();
  const r = await db.updateTable("threads").set({ state, snooze_until: state === "snoozed" ? snoozeUntil ?? new Date(Date.now() + 86400_000).toISOString() : null,
    needs_attention: state === "open" ? undefined : 0, updated_at: now() }).where("id", "=", id).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw notFound("Thread not found");
  await audit(actor, `thread.${state}`, "thread", id);
  emit("thread", { threadId: id });
}

/** Read / unread, kept in step with Gmail (changes made in Gmail arrive with the next sync). */
export async function setThreadRead(id: string, read: boolean) {
  const db = await getDb();
  const thread = await db.selectFrom("threads").select(["account_id", "provider_thread_id"]).where("id", "=", id).executeTakeFirst();
  if (!thread) throw notFound();
  const acc = await db.selectFrom("accounts").selectAll().where("id", "=", thread.account_id).executeTakeFirstOrThrow();
  await mailFor(acc).modifyThreadLabels(thread.provider_thread_id, read ? [] : ["UNREAD"], read ? ["UNREAD"] : []);
  for (const m of await db.selectFrom("messages").select(["id", "labels_json"]).where("thread_id", "=", id).execute()) {
    const labels = pj<string[]>(m.labels_json, []).filter((l) => l !== "UNREAD");
    await db.updateTable("messages").set({ labels_json: JSON.stringify(read ? labels : [...labels, "UNREAD"]) }).where("id", "=", m.id).execute();
  }
  emit("thread", { threadId: id });
}

/** Gmail system labels and the app's own AI/* labels can't be set or removed by name. */
const RESERVED_LABEL = /^(INBOX|SPAM|TRASH|SENT|DRAFT|UNREAD|STARRED|IMPORTANT|CHAT|CATEGORY_.*)$/i;
export function checkLabelName(name: string): string {
  const n = name.trim();
  if (!n || n.length > 100) throw new HttpError(400, "Label names must be 1–100 characters");
  if (RESERVED_LABEL.test(n)) throw new HttpError(400, `"${n}" is a Gmail system label — use the inbox actions instead`);
  if (Object.values(AI_LABELS).some((l) => l.toLowerCase() === n.toLowerCase()) || /^AI\//i.test(n)) throw new HttpError(400, "AI/* labels are managed by the app");
  return n;
}

/** Add/remove your own Gmail labels on a thread (labels are created in Gmail if missing). */
export async function changeThreadLabels(id: string, add: string[], remove: string[], actor: Actor = "user") {
  const addN = add.map(checkLabelName); const removeN = remove.map(checkLabelName);
  if (!addN.length && !removeN.length) return;
  const db = await getDb();
  const thread = await db.selectFrom("threads").select(["account_id", "provider_thread_id"]).where("id", "=", id).executeTakeFirst();
  if (!thread) throw notFound("Thread not found");
  const acc = await db.selectFrom("accounts").selectAll().where("id", "=", thread.account_id).executeTakeFirstOrThrow();
  const mail = mailFor(acc);
  const ids = await mail.ensureLabels([...new Set([...addN, ...removeN])]);
  const addIds = addN.map((n) => ids[n]).filter(Boolean); const removeIds = removeN.map((n) => ids[n]).filter(Boolean);
  await mail.modifyThreadLabels(thread.provider_thread_id, addIds, removeIds);
  for (const m of await db.selectFrom("messages").select(["id", "labels_json"]).where("thread_id", "=", id).execute()) {
    const labels = new Set(pj<string[]>(m.labels_json, []));
    addIds.forEach((l) => labels.add(l)); removeIds.forEach((l) => labels.delete(l));
    await db.updateTable("messages").set({ labels_json: JSON.stringify([...labels]) }).where("id", "=", m.id).execute();
  }
  await audit(actor, "thread.labels", "thread", id, { added: addN, removed: removeN });
  emit("thread", { threadId: id });
}

/**
 * Junk: future mail from this sender (or their whole domain) skips the inbox; this thread and their other
 * open threads move to Skipped. spam=true also moves this thread to Gmail's Spam folder.
 */
export async function junkSender(id: string, scope: "sender" | "domain", spam: boolean, actor: Actor = "user") {
  const db = await getDb();
  const thread = await db.selectFrom("threads").selectAll().where("id", "=", id).executeTakeFirst();
  if (!thread) throw notFound();
  const from = await db.selectFrom("messages").select("from_email").where("thread_id", "=", id).where("is_from_me", "=", 0).orderBy("date", "desc").executeTakeFirst();
  if (!from) throw new HttpError(400, "No incoming message in this thread");
  const email = from.from_email.toLowerCase();
  const match = scope === "domain" ? `@${email.split("@")[1]}` : email;
  if (scope === "domain" && PERSONAL_PROVIDERS.test(match)) throw new HttpError(400, "That's a personal email provider — block just this sender instead");
  if (!(await db.selectFrom("sender_rules").select("id").where("match", "=", match).where("action", "=", "skip").executeTakeFirst()))
    await db.insertInto("sender_rules").values({ id: crypto.randomUUID(), match, action: "skip", value: null, created_at: now() }).execute();
  const senderThreads = db.selectFrom("messages").select("thread_id").where("is_from_me", "=", 0)
    .where("from_email", scope === "domain" ? "like" : "=", scope === "domain" ? `%${match}` : email);
  const moved = await db.updateTable("threads").set({ state: "skipped", updated_at: now() })
    .where((eb) => eb.or([eb("id", "=", id), eb.and([eb("state", "=", "open"), eb("id", "in", senderThreads)])])).executeTakeFirst();
  for (const d of await db.selectFrom("drafts").select("id").where("thread_id", "=", id).where("status", "in", ["active", "saved"]).execute()) await discardDraft(d.id);
  if (spam) {
    const acc = await db.selectFrom("accounts").selectAll().where("id", "=", thread.account_id).executeTakeFirstOrThrow();
    await mailFor(acc).modifyThreadLabels(thread.provider_thread_id, ["SPAM"], ["INBOX"]);
  }
  await audit(actor, "thread.junk", "thread", id, { scope, spam });
  emit("thread", {});
  return { rule: match, moved: Number(moved.numUpdatedRows) };
}
