/**
 * New features through the real HTTP API (mock mode): writing new emails,
 * contact autocomplete, the to-do list, the junk filter, and scanning email
 * for calendar events (which must list only — never add by itself).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setup, authedServer } from "./helpers.js";
import { pollOnce } from "../src/worker/index.js";
import { getDb } from "../src/db/index.js";
import { parseQuickAdd } from "../src/tasks/service.js";
import { contactsFor } from "../src/providers/index.js";
import { MockContactsProvider, ContactsPermissionError } from "../src/providers/contacts.js";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { ctx = await setup(); });

describe("compose (new emails)", () => {
  it("autosaves, saves to Gmail as a thread-less draft with Bcc, and sends only with a fresh confirmation", async () => {
    const { call } = await authedServer();
    const c = (await call("POST", "/api/compose", { to: [{ name: "Raj Patel", email: "raj@example.net" }], subject: "Hello" })).json();
    expect(c.status).toBe("open");
    await call("PUT", `/api/compose/${c.id}`, { body: "Are you free next week?", bcc: [{ name: null, email: "me2@example.com" }] });
    const saved = (await call("POST", `/api/compose/${c.id}/save`)).json();
    expect(saved.saved).toBe(true);
    const d = ctx.mail.drafts.get(saved.provider_draft_id)!;
    expect(d.threadId).toBeNull();
    expect(d.raw).toContain("To: Raj Patel <raj@example.net>");
    expect(d.raw).toContain("Bcc: me2@example.com");
    expect(d.raw).toContain("Subject: Hello");
    expect(d.raw).not.toContain("In-Reply-To");
    expect(ctx.mail.sent).toHaveLength(0);

    // a confirmation is bound to exactly what was reviewed
    const prep = (await call("POST", `/api/compose/${c.id}/send/prepare`)).json();
    expect(prep.bcc).toEqual([{ name: null, email: "me2@example.com" }]);
    await call("PUT", `/api/compose/${c.id}`, { body: "Changed after review" });
    const stale = await call("POST", `/api/compose/${c.id}/send`, { token: prep.token, confirm: true });
    expect(stale.statusCode).toBe(409);
    expect(ctx.mail.sent).toHaveLength(0);

    const prep2 = (await call("POST", `/api/compose/${c.id}/send/prepare`)).json();
    expect((await call("POST", `/api/compose/${c.id}/send`, { token: prep2.token, confirm: true })).statusCode).toBe(200);
    expect(ctx.mail.sent).toHaveLength(1);
    expect(Buffer.from(ctx.mail.sent[0].raw.split("base64")[1].split("--")[0].replace(/\s+/g, ""), "base64").toString()).toContain("Changed after review");
    expect((await call("POST", `/api/compose/${c.id}/send`, { token: prep2.token, confirm: true })).statusCode).toBe(409); // no double send
    expect((await call("GET", "/api/compose")).json()).toHaveLength(0);
  });

  it("refuses to send without recipients or with [CONFIRM] placeholders; discard deletes the Gmail draft", async () => {
    const { call } = await authedServer();
    const c = (await call("POST", "/api/compose", { subject: "x" })).json();
    expect((await call("POST", `/api/compose/${c.id}/send/prepare`)).statusCode).toBe(409);
    await call("PUT", `/api/compose/${c.id}`, { to: [{ name: null, email: "a@b.co" }], body: "See you at [CONFIRM: time]" });
    const prep = (await call("POST", `/api/compose/${c.id}/send/prepare`)).json();
    expect(prep.hasPlaceholders).toBe(true);
    expect((await call("POST", `/api/compose/${c.id}/send`, { token: prep.token, confirm: true })).statusCode).toBe(409);
    const saved = (await call("POST", `/api/compose/${c.id}/save`)).json();
    expect(ctx.mail.drafts.has(saved.provider_draft_id)).toBe(true);
    await call("DELETE", `/api/compose/${c.id}`);
    expect(ctx.mail.drafts.has(saved.provider_draft_id)).toBe(false);
    expect((await call("GET", `/api/compose/${c.id}`)).statusCode).toBe(404);
  });

  it("Claude writes the body from an instruction, with the hard rules, and nothing is sent", async () => {
    const { call } = await authedServer();
    const c = (await call("POST", "/api/compose", { to: [{ name: "Claire Dubois", email: "claire.dubois@choir.example.org" }] })).json();
    const r = (await call("POST", `/api/compose/${c.id}/write`, { instruction: "ask if Thursday works for rehearsal" })).json();
    expect(r.compose.body.length).toBeGreaterThan(10);
    const last = ctx.llm.calls.at(-1)!;
    expect(last.system).toContain("Never invent facts");
    expect(last.user).toContain("NEW email");
    expect(last.user).toContain("ask if Thursday works for rehearsal");
    expect(ctx.mail.sent).toHaveLength(0);
  });
});

describe("contacts autocomplete", () => {
  it("combines people from mail (ranked by how often you write) with Google contacts", async () => {
    await pollOnce();
    const { call } = await authedServer();
    await call("POST", "/api/contacts/sync");
    const claire = (await call("GET", "/api/contacts?q=cla")).json();
    expect(claire[0]).toMatchObject({ email: "claire.dubois@choir.example.org", name: "Claire Dubois" });
    const google = (await call("GET", "/api/contacts?q=luc")).json(); // only in Google contacts
    expect(google[0]).toMatchObject({ email: "luc.tremblay@example.ca", source: "google" });
    const byDomain = (await call("GET", "/api/contacts?q=choir")).json();
    expect(byDomain.length).toBeGreaterThan(0);
    const mine = (await call("GET", "/api/contacts?q=matthew")).json();
    expect(mine.every((c: { email: string }) => c.email !== "matthew@menard.example")).toBe(true);
    expect((await call("GET", "/api/contacts?q=")).json()).toEqual([]);
    expect((await call("GET", "/api/contacts/status")).json().google).toBe("ok");
  });

  it("without the contacts permission it still works from mail and says so", async () => {
    await pollOnce();
    const acc = { id: ctx.accountId, provider: "mock" };
    (contactsFor(acc) as MockContactsProvider).list = async () => { throw new ContactsPermissionError(); };
    const { call } = await authedServer();
    const st = (await call("POST", "/api/contacts/sync")).json();
    expect(st.google).toBe("needs_permission");
    expect((await call("GET", "/api/contacts?q=raj")).json()[0].email).toBe("raj@example.net");
    (contactsFor(acc) as MockContactsProvider).list = MockContactsProvider.prototype.list;
  });
});

describe("to-do list", () => {
  it("quick add reads dates, priority and project", () => {
    const projects = [{ id: "p1", name: "Messiah Concert" }];
    // 2026-11-02 is a Monday (weekday 1)
    expect(parseQuickAdd("Book hall friday !high #messiah", "2026-11-02", 1, projects)).toEqual({ title: "Book hall", due_date: "2026-11-06", priority: 3, project_id: "p1" });
    expect(parseQuickAdd("Call Ana tomorrow", "2026-11-02", 1, projects)).toMatchObject({ title: "Call Ana", due_date: "2026-11-03", priority: 0 });
    expect(parseQuickAdd("Send scores 2026-12-01 !2", "2026-11-02", 1, projects)).toMatchObject({ title: "Send scores", due_date: "2026-12-01", priority: 2 });
    expect(parseQuickAdd("Plan monday", "2026-11-02", 1, projects).due_date).toBe("2026-11-09"); // next Monday, not today
    expect(parseQuickAdd("Fix #unknown thing", "2026-11-02", 1, projects)).toMatchObject({ title: "Fix #unknown thing", project_id: null });
  });

  it("projects break into tasks and steps; finishing a task finishes its steps; deletes cascade", async () => {
    const { call } = await authedServer();
    const p = (await call("POST", "/api/projects", { name: "Messiah concert" })).json();
    const t = (await call("POST", "/api/tasks", { title: "Prepare programme", project_id: p.id })).json();
    const s1 = (await call("POST", "/api/tasks", { title: "Collect bios", parent_id: t.id })).json();
    const s2 = (await call("POST", "/api/tasks", { title: "Print", parent_id: t.id })).json();
    const s11 = (await call("POST", "/api/tasks", { title: "Ask soprano", parent_id: s1.id })).json();
    expect(s11.project_id).toBe(p.id); // steps live in their parent's project

    // a task can't become a step of its own step
    expect((await call("PATCH", `/api/tasks/${t.id}`, { parent_id: s11.id })).statusCode).toBe(400);

    await call("PATCH", `/api/tasks/${t.id}`, { status: "done" });
    const all = (await call("GET", "/api/tasks")).json();
    for (const id of [t.id, s1.id, s2.id, s11.id]) expect(all.tasks.find((x: { id: string }) => x.id === id).status).toBe("done");

    // moving a task moves its steps
    await call("PATCH", `/api/tasks/${t.id}`, { project_id: null });
    const moved = (await call("GET", "/api/tasks")).json();
    expect(moved.tasks.find((x: { id: string }) => x.id === s11.id).project_id).toBeNull();

    expect((await call("DELETE", `/api/tasks/${t.id}`)).json().deleted).toBe(4);
    await call("POST", "/api/tasks", { title: "Another", project_id: p.id });
    await call("DELETE", `/api/projects/${p.id}`);
    const after = (await call("GET", "/api/tasks")).json();
    expect(after.tasks).toHaveLength(0);
    expect(after.projects).toHaveLength(0);
  });

  it("Claude suggests steps but adds nothing until you choose; tasks can come from an email", async () => {
    await pollOnce();
    const { call } = await authedServer();
    const thread = await (await getDb()).selectFrom("threads").select("id").where("subject", "like", "%Messiah%").executeTakeFirstOrThrow();
    const t = (await call("POST", "/api/tasks", { title: "Organise the spring tour", thread_id: thread.id })).json();
    expect(t.thread_id).toBe(thread.id);
    const sug = (await call("POST", `/api/tasks/${t.id}/suggest`)).json();
    expect(sug.steps.length).toBeGreaterThan(1);
    expect((await call("GET", "/api/tasks")).json().tasks).toHaveLength(1); // nothing added yet
    await call("POST", `/api/tasks/${t.id}/steps`, { steps: sug.steps.slice(0, 2) });
    const tasks = (await call("GET", "/api/tasks")).json().tasks;
    expect(tasks.filter((x: { parent_id: string | null }) => x.parent_id === t.id)).toHaveLength(2);
  });
});

describe("junk filter", () => {
  it("Focused hides FYI/newsletter/other unless urgent; junk skips the sender now and in future", async () => {
    await pollOnce();
    const { call } = await authedServer();
    const db = await getDb();
    const all = (await call("GET", "/api/threads?view=inbox&sort=date")).json();
    const focused = (await call("GET", "/api/threads?view=inbox&sort=date&focus=1")).json();
    expect(focused.length).toBeLessThanOrEqual(all.length);
    expect(focused.every((t: { category: string | null; urgent: boolean }) => t.urgent || !["newsletter", "fyi", "other"].includes(t.category ?? ""))).toBe(true);

    const gig = await db.selectFrom("threads").selectAll().where("subject", "like", "%Paid gig%").executeTakeFirstOrThrow();
    const r = (await call("POST", `/api/threads/${gig.id}/junk`, { scope: "domain", spam: true })).json();
    expect(r.rule).toBe("@totally-legit.example.net");
    expect((await db.selectFrom("threads").select("state").where("id", "=", gig.id).executeTakeFirstOrThrow()).state).toBe("skipped");
    expect([...(ctx.mail.threadLabels.get(gig.provider_thread_id) ?? [])]).toContain("SPAM");

    // future mail from that domain skips the inbox
    ctx.mail.receive({ id: "spam2", threadId: "ts2", from: "Promo <promo@totally-legit.example.net>", subject: "Another offer", date: new Date().toUTCString(), body: "Act now?" });
    await pollOnce();
    expect((await db.selectFrom("threads").select("state").where("provider_thread_id", "=", "ts2").executeTakeFirstOrThrow()).state).toBe("skipped");

    // never block a whole personal email provider
    const raj = await db.selectFrom("threads").select("id").where("subject", "like", "%dinner%").executeTakeFirstOrThrow();
    ctx.mail.receive({ id: "g1", threadId: "tg", from: "Someone <someone@gmail.com>", subject: "hi", date: new Date().toUTCString(), body: "hello?" });
    await pollOnce();
    const g = await db.selectFrom("threads").select("id").where("provider_thread_id", "=", "tg").executeTakeFirstOrThrow();
    expect((await call("POST", `/api/threads/${g.id}/junk`, { scope: "domain" })).statusCode).toBe(400);
    expect(raj.id).toBeTruthy();
  });
});

describe("scan emails for events", () => {
  it("lists events found in mail and adds nothing; adding is a separate request", async () => {
    await pollOnce();
    const { call } = await authedServer();
    const before = ctx.calendar.created.length;
    const r = (await call("POST", "/api/calendar/scan", { days: 30 })).json();
    expect(r.scanned).toBeGreaterThan(0);
    expect(r.events.length).toBeGreaterThan(0);
    expect(r.events[0]).toHaveProperty("threadId");
    expect(ctx.calendar.created.length).toBe(before); // scanning never adds
    const scanCall = ctx.llm.calls.find((c) => c.schemaName === "event_scan")!;
    expect(scanCall.system).toContain("Never invent");
    expect(scanCall.user).not.toContain("newsletter@news.example.com"); // newsletters aren't scanned

    const e = r.events[0];
    await call("POST", "/api/calendar/events", { title: e.title, kind: "rehearsal", start: e.start, durationMinutes: 90 });
    expect(ctx.calendar.created.length).toBe(before + 1);
    expect(ctx.calendar.created.at(-1)!.tentative).toBe(true);

    const again = (await call("POST", "/api/calendar/scan", { days: 30 })).json();
    expect(again.events.find((x: { key: string }) => x.key === e.key).alreadyOnCalendar).toBe(true);

    await call("POST", "/api/calendar/events", { title: "Grant report", kind: "other", start: "2026-12-01", allDay: true });
    expect(ctx.calendar.created.at(-1)).toMatchObject({ allDay: true, start: "2026-12-01", end: "2026-12-02" });
  });
});

describe("email analysis (to-do / calendar suggestions)", () => {
  const threadBySubject = async (subject: string) =>
    (await (await getDb()).selectFrom("threads").select("id").where("subject", "=", subject).executeTakeFirstOrThrow()).id;

  it("suggests only concrete items, adds nothing until you press a button, and is saved per message", async () => {
    await pollOnce();
    const { call } = await authedServer();
    const contract = await threadBySubject("Contract for the new commission");
    const r = (await call("GET", `/api/threads/${contract}/analysis`)).json();
    const todo = r.items.find((i: { type: string }) => i.type === "todo");
    expect(todo.title).toMatch(/review clause 4/i);
    expect(todo.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todo.added).toBeNull();
    expect((await call("GET", "/api/tasks")).json().tasks).toHaveLength(0); // analysing adds nothing
    const llmCall = ctx.llm.calls.find((c) => c.schemaName === "thread_analysis")!;
    expect(llmCall.system).toContain("Most emails contain NOTHING concrete");

    // opening it again uses the saved result
    const calls = ctx.llm.calls.length;
    await call("GET", `/api/threads/${contract}/analysis`);
    expect(ctx.llm.calls.length).toBe(calls);

    // pressing the button adds it, linked to the email, once
    const added = (await call("POST", `/api/threads/${contract}/analysis/${todo.key}/add`, {})).json();
    expect(added.added).toBeTruthy();
    const tasks = (await call("GET", "/api/tasks")).json().tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].thread_id).toBe(contract);
    expect(tasks[0].due_date).toBe(todo.due_date);
    expect((await call("POST", `/api/threads/${contract}/analysis/${todo.key}/add`, {})).statusCode).toBe(409);
  });

  it("finds nothing in chit-chat, skips newsletters without calling the AI, and can hide a suggestion", async () => {
    await pollOnce();
    const { call } = await authedServer();
    const dinner = await threadBySubject("dinner saturday?");
    expect((await call("GET", `/api/threads/${dinner}/analysis`)).json().items).toEqual([]);

    const before = ctx.llm.calls.filter((c) => c.schemaName === "thread_analysis").length;
    const news = await threadBySubject("This week in choral music");
    expect((await call("GET", `/api/threads/${news}/analysis`)).json()).toEqual({ items: [], status: "skipped" });
    expect(ctx.llm.calls.filter((c) => c.schemaName === "thread_analysis").length).toBe(before);

    const contract = await threadBySubject("Contract for the new commission");
    const { items } = (await call("GET", `/api/threads/${contract}/analysis`)).json();
    await call("POST", `/api/threads/${contract}/analysis/${items[0].key}/dismiss`);
    expect((await call("GET", `/api/threads/${contract}/analysis`)).json().items[0].dismissed).toBe(true);
    expect(ctx.calendar.created).toHaveLength(0);
  });

  it("adds a suggested event as a tentative calendar event when you press it", async () => {
    await pollOnce();
    const { call } = await authedServer();
    const db = await getDb();
    const t = await threadBySubject("dinner saturday?");
    // a concrete event in the latest email
    await db.updateTable("messages").set({ stripped_text: "Rehearsal is on Thursday at 7 in the chapel." }).where("thread_id", "=", t).execute();
    const r = (await call("GET", `/api/threads/${t}/analysis?force=1`)).json();
    const ev = r.items.find((i: { type: string }) => i.type === "event");
    expect(ev.title).toBe("Rehearsal");
    expect(ctx.calendar.created).toHaveLength(0);
    await call("POST", `/api/threads/${t}/analysis/${ev.key}/add`, {});
    expect(ctx.calendar.created).toHaveLength(1);
    expect(ctx.calendar.created[0].tentative).toBe(true);
  });
});
