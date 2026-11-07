/**
 * End-to-end flows in mock mode, through the real HTTP API:
 * sync → triage → auto-draft → redraft → edit → save → send-confirmation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setup, authedServer } from "./helpers.js";
import { pollOnce } from "../src/worker/index.js";
import { getDb } from "../src/db/index.js";
import { saveSettings } from "../src/settings.js";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { ctx = await setup(); });

async function threadBySubject(s: string) {
  const db = await getDb();
  return db.selectFrom("threads").selectAll().where("subject", "like", `%${s}%`).executeTakeFirstOrThrow();
}

describe("worker: sync, triage, auto-draft", () => {
  it("drafts only reply-worthy mail, skips bulk/no-reply, never sends", async () => {
    const r = await pollOnce();
    expect(r.newMessages).toBe(18);
    expect((await threadBySubject("This week in choral")).state).toBe("skipped");
    expect((await threadBySubject("Reminder: dentist")).state).toBe("skipped");
    expect((await threadBySubject("Messiah")).draft_status).toBe("drafted:sonnet"); // default drafting model
    expect((await threadBySubject("Invoice")).draft_status).toBe("none");
    expect(ctx.mail.sent).toHaveLength(0); // the worker NEVER sends
    expect(ctx.mail.drafts.size).toBeGreaterThan(0);
    const labels = [...ctx.mail.threadLabels.get("t1")!].map((id) => [...ctx.mail.labels.entries()].find(([, v]) => v === id)![0]);
    expect(labels).toEqual(expect.arrayContaining(["AI/Drafted", "AI/Needs-Review"]));
    const skipped = [...(ctx.mail.threadLabels.get("t4") ?? [])].map((id) => [...ctx.mail.labels.entries()].find(([, v]) => v === id)![0]);
    expect(skipped).toContain("AI/Skipped");
  });

  it("is idempotent: polling again creates nothing new; a new reply updates the same Gmail draft", async () => {
    await pollOnce();
    const draftsBefore = ctx.mail.drafts.size;
    const db = await getDb();
    const nVersions = (await db.selectFrom("draft_versions").selectAll().execute()).length;
    await pollOnce();
    expect(ctx.mail.drafts.size).toBe(draftsBefore);
    expect((await db.selectFrom("draft_versions").selectAll().execute()).length).toBe(nVersions);
    // Claire writes again in the same thread → redraft into the SAME Gmail draft
    ctx.mail.receive({ id: "m1b", threadId: "t1", from: "Claire Dubois <claire.dubois@choir.example.org>", subject: "Re: Bass soloist – Messiah sing-along rehearsals",
      date: new Date().toUTCString(), body: "Also, could you do a third rehearsal on the Friday?", messageId: "<m1b@x>", inReplyTo: "<m1@choir.example.org>" });
    await pollOnce();
    expect(ctx.mail.drafts.size).toBe(draftsBefore);
    const t = await threadBySubject("Messiah");
    const drafts = await db.selectFrom("drafts").selectAll().where("thread_id", "=", t.id).execute();
    expect(drafts).toHaveLength(1);
    const mime = ctx.mail.draftMime(drafts[0].provider_draft_id!)!;
    expect(mime).toContain("In-Reply-To: <m1b@x>");
    expect(mime).toMatch(/References: .*<m1b@x>/);
  });

  it("falls back to a full sync when the history id has expired", async () => {
    await pollOnce();
    ctx.mail.minHistory = 999999;
    ctx.mail.receive({ id: "late", threadId: "tl", from: "Raj Patel <raj@example.net>", subject: "late one", date: new Date().toUTCString(), body: "you there?" });
    const r = await pollOnce();
    expect(r.newMessages).toBe(1);
  });

  it("budget cap pauses automatic drafting but not manual drafting", async () => {
    await saveSettings({ monthly_budget_usd: 0.0000001 });
    const db = await getDb();
    await db.insertInto("usage").values({ id: "u", ts: new Date().toISOString(), purpose: "draft", model_key: "haiku", model_id: "x", input_tokens: 1, output_tokens: 1, cost_usd: 1, thread_id: null, draft_id: null }).execute();
    await pollOnce();
    expect((await threadBySubject("Messiah")).draft_status).toBe("none");
    const { call } = await authedServer();
    const t = await threadBySubject("Messiah");
    expect((await call("POST", `/api/threads/${t.id}/draft`, {})).statusCode).toBe(200);
  });

  it("failed drafts go to the needs-attention list, and malformed output is retried once", async () => {
    await saveSettings({ auto_draft: false });
    await pollOnce();
    const { call } = await authedServer();
    const t = await threadBySubject("Messiah");
    ctx.llm.failNext = 1; // first answer malformed, retry succeeds
    expect((await call("POST", `/api/threads/${t.id}/draft`, {})).statusCode).toBe(200);
    ctx.llm.failNext = 2; // malformed twice → error, left undrafted
    const bad = await call("POST", `/api/threads/${t.id}/draft`, { model: "sonnet" });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error).toContain("left undrafted");
  });
});

describe("draft → redraft → edit → save → send flow", () => {
  it("follows the button logic and only sends after confirmation", async () => {
    await saveSettings({ auto_draft: false });
    await pollOnce();
    const { call } = await authedServer();
    const t = await threadBySubject("Messiah");
    let d = (await call("GET", `/api/threads/${t.id}`)).json();
    expect(d.buttons.primary.label).toBe("Draft with Sonnet");
    expect(d.buttons.options.map((o: { key: string }) => o.key)).toEqual(["haiku", "sonnet", "opus"]);
    expect(d.buttons.default).toBe("sonnet");

    await call("POST", `/api/threads/${t.id}/draft`, { model: "haiku" }); // any model can be picked
    d = (await call("GET", `/api/threads/${t.id}`)).json();
    expect(d.buttons.primary.label).toBe("Redraft with Haiku"); // picker stays on the model you used
    expect(d.buttons.selected).toBe("haiku");
    expect(d.versions[0].model_key).toBe("haiku");
    expect(d.scheduling).not.toBeNull();

    await call("POST", `/api/threads/${t.id}/draft`, { model: "sonnet", instruction: "decline politely" });
    d = (await call("GET", `/api/threads/${t.id}`)).json();
    expect(d.buttons.primary.label).toBe("Redraft with Sonnet");
    expect(d.versions.map((v: { model_key: string }) => v.model_key)).toEqual(["sonnet", "haiku"]);
    expect(d.versions[0].instruction).toBe("decline politely");
    expect(ctx.mail.drafts.size).toBe(1); // replaced, not duplicated
    const draftId = d.draft.id;

    // placeholder in body blocks sending
    await call("PUT", `/api/drafts/${draftId}`, { body: "Hi Claire,\n\nYes — [CONFIRM: fee]" });
    const prep0 = (await call("POST", `/api/drafts/${draftId}/send/prepare`)).json();
    expect(prep0.hasPlaceholders).toBe(true);
    expect((await call("POST", `/api/drafts/${draftId}/send`, { token: prep0.token, confirm: true })).statusCode).toBe(409);

    // edit, save to Gmail
    await call("PUT", `/api/drafts/${draftId}`, { body: "Hi Claire,\n\nYes, Tuesday and Thursday evenings work." });
    expect((await call("POST", `/api/drafts/${draftId}/save`)).statusCode).toBe(200);
    const pid = [...ctx.mail.drafts.keys()][0];
    expect(ctx.mail.draftMime(pid)).toContain(Buffer.from("Hi Claire,\n\nYes, Tuesday and Thursday evenings work.").toString("base64").slice(0, 40));

    // revert to the Haiku version and back
    const haiku = d.versions.find((v: { model_key: string }) => v.model_key === "haiku");
    await call("POST", `/api/drafts/${draftId}/revert`, { versionId: haiku.id });
    expect((await call("GET", `/api/threads/${t.id}`)).json().draft.current_version_id).toBe(haiku.id);
    await call("PUT", `/api/drafts/${draftId}`, { body: "Hi Claire,\n\nYes, Tuesday and Thursday evenings work." });

    // send without confirm flag / with a bad token / after an edit → refused
    expect((await call("POST", `/api/drafts/${draftId}/send`, { token: "x".repeat(20) })).statusCode).toBe(400);
    expect((await call("POST", `/api/drafts/${draftId}/send`, { token: "x".repeat(20), confirm: true })).statusCode).toBe(409);
    const prep = (await call("POST", `/api/drafts/${draftId}/send/prepare`)).json();
    expect(prep.to[0].email).toBe("claire.dubois@choir.example.org");
    expect(prep.subject).toBe("Re: Bass soloist – Messiah sing-along rehearsals");
    expect(prep.preview).toContain("Tuesday and Thursday");
    await call("PUT", `/api/drafts/${draftId}`, { body: "Hi Claire,\n\nChanged my mind about the wording." });
    expect((await call("POST", `/api/drafts/${draftId}/send`, { token: prep.token, confirm: true })).json().error).toContain("changed after you reviewed");
    expect(ctx.mail.sent).toHaveLength(0);

    // proper confirmation → sent exactly once
    const prep2 = (await call("POST", `/api/drafts/${draftId}/send/prepare`)).json();
    expect((await call("POST", `/api/drafts/${draftId}/send`, { token: prep2.token, confirm: true })).statusCode).toBe(200);
    expect((await call("POST", `/api/drafts/${draftId}/send`, { token: prep2.token, confirm: true })).statusCode).toBe(409);
    expect(ctx.mail.sent).toHaveLength(1);
    expect(ctx.mail.sent[0].raw).toContain("In-Reply-To: <m1@choir.example.org>");
    const after = (await call("GET", `/api/threads/${t.id}`)).json();
    expect(after.thread.state).toBe("done");
    const db = await getDb();
    expect((await db.selectFrom("drafts").select("edit_class").where("id", "=", draftId).executeTakeFirstOrThrow()).edit_class).toBe("edited");
    const actions = (await db.selectFrom("audit_log").select("action").execute()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["draft.create", "draft.redraft", "draft.edit", "draft.save_gmail", "draft.revert", "send.prepare", "send"]));
  });

  it("discard deletes the Gmail draft; triage correction is stored and reused as an example", async () => {
    await pollOnce();
    const { call } = await authedServer();
    const t = await threadBySubject("Messiah");
    const d = (await call("GET", `/api/threads/${t.id}`)).json();
    await call("DELETE", `/api/drafts/${d.draft.id}`);
    expect(ctx.mail.drafts.has(d.draft.provider_draft_id)).toBe(false);
    await call("POST", `/api/threads/${t.id}/triage`, { category: "fyi" });
    ctx.mail.receive({ id: "m1c", threadId: "t1c", from: "Claire Dubois <claire.dubois@choir.example.org>", subject: "Another note", date: new Date().toUTCString(), body: "Just letting you know." });
    await pollOnce();
    const triageCall = ctx.llm.calls.filter((c) => c.schemaName === "triage").at(-1)!;
    expect(triageCall.user).toContain("Matthew corrected these earlier classifications");
    expect(triageCall.user).toContain("→ fyi");
  });

  it("calendar events are created only by explicit request and follow the title rule", async () => {
    await pollOnce();
    expect(ctx.calendar.created).toHaveLength(0); // nothing automatic
    const { call } = await authedServer();
    const r = (await call("POST", "/api/calendar/events", { title: "Concert rehearsal – Messiah", kind: "rehearsal", start: "2026-11-17T23:00:00Z" })).json();
    expect(r.summary).toBe("Rehearsal: Messiah");
    expect(ctx.calendar.created[0]).toMatchObject({ tentative: true, summary: "Rehearsal: Messiah" });
  });

  it("export excludes tokens; wipe requires the phrase and password", async () => {
    await pollOnce();
    const { call } = await authedServer();
    const ex = (await call("GET", "/api/export")).json();
    expect(ex.data.messages.length).toBe(18);
    expect(JSON.stringify(ex.data.accounts)).not.toContain("tokens_enc");
    expect((await call("POST", "/api/wipe", { confirm: "yes", password: "a long test password" })).statusCode).toBe(400);
    expect((await call("POST", "/api/wipe", { confirm: "DELETE EVERYTHING", password: "nope" })).statusCode).toBe(401);
    expect((await call("POST", "/api/wipe", { confirm: "DELETE EVERYTHING", password: "a long test password" })).statusCode).toBe(200);
    const db = await getDb();
    expect(await db.selectFrom("messages").selectAll().execute()).toEqual([]);
  });
});

describe("inbox sort", () => {
  it("sort=date is newest first only; the default (smart) puts urgent first", async () => {
    await pollOnce();
    const { call } = await authedServer();
    const byDate = (await call("GET", "/api/threads?view=all&sort=date")).json() as { last_message_at: string; urgent: boolean }[];
    expect(byDate.length).toBeGreaterThan(2);
    expect(byDate.map((t) => t.last_message_at)).toEqual([...byDate.map((t) => t.last_message_at)].sort().reverse());
    const smart = (await call("GET", "/api/threads?view=all")).json() as { urgent: boolean }[];
    const firstNonUrgent = smart.findIndex((t) => !t.urgent);
    expect(smart.slice(firstNonUrgent).some((t) => t.urgent)).toBe(false);
    expect(smart.some((t) => t.urgent)).toBe(true);
  });
});

describe("drafting defaults", () => {
  it("by default auto-drafts only needs-reply and urgent mail", async () => {
    await setup({ defaultSettings: true });
    await pollOnce();
    const db = await getDb();
    const drafted = await db.selectFrom("threads").select(["category"]).where("draft_status", "like", "drafted:%").execute();
    expect(drafted.length).toBeGreaterThan(0);
    for (const t of drafted) expect(["needs-reply", "urgent"]).toContain(t.category);
    expect((await threadBySubject("Messiah")).draft_status).toBe("none");
  });
});

describe("no reply needed", () => {
  it("discards the draft (also in Gmail) and moves the thread to Done", async () => {
    await pollOnce();
    const t = await threadBySubject("Messiah");
    expect(t.draft_status).toBe("drafted:sonnet");
    const { call } = await authedServer();
    expect(ctx.mail.drafts.size).toBeGreaterThan(0);
    const before = ctx.mail.drafts.size;
    expect((await call("POST", `/api/threads/${t.id}/no-reply`)).statusCode).toBe(200);
    const after = await threadBySubject("Messiah");
    expect(after.state).toBe("done");
    expect(after.draft_status).toBe("none");
    expect(ctx.mail.drafts.size).toBe(before - 1);
  });
});

describe("read / unread", () => {
  it("opening marks read in Gmail; reading in Gmail shows up after the next sync", async () => {
    await pollOnce();
    const { call } = await authedServer();
    const rows = (await call("GET", "/api/threads?view=all&sort=date")).json() as { id: string; unread: boolean }[];
    const unread = rows.filter((r) => r.unread);
    expect(unread.length).toBeGreaterThan(1);
    const [a, b] = unread;

    // App → Gmail
    expect((await call("POST", `/api/threads/${a.id}/read`, { read: true })).statusCode).toBe(200);
    const ta = await (await getDb()).selectFrom("threads").select("provider_thread_id").where("id", "=", a.id).executeTakeFirstOrThrow();
    const gmailMsgs = [...ctx.mail.messages.values()].filter((m) => m.threadId === ta.provider_thread_id);
    for (const m of gmailMsgs) expect(m.labelIds).not.toContain("UNREAD");
    expect(((await call("GET", `/api/threads/${a.id}`)).json() as { thread: { unread: boolean } }).thread.unread).toBe(false);

    // Gmail → app
    const tb = await (await getDb()).selectFrom("threads").select("provider_thread_id").where("id", "=", b.id).executeTakeFirstOrThrow();
    await ctx.mail.modifyThreadLabels(tb.provider_thread_id, [], ["UNREAD"]);
    await pollOnce();
    const after = (await call("GET", "/api/threads?view=all&sort=date")).json() as { id: string; unread: boolean }[];
    expect(after.find((r) => r.id === b.id)?.unread).toBe(false);

    // Mark unread again
    await call("POST", `/api/threads/${a.id}/read`, { read: false });
    expect(((await call("GET", "/api/threads?view=all")).json() as { id: string; unread: boolean }[]).find((r) => r.id === a.id)?.unread).toBe(true);
  });
});

describe("choosing the drafting model", () => {
  it("Settings default applies to new drafts, any model can redraft, compose takes a model, unknown models are refused", async () => {
    const { call } = await authedServer();
    expect((await call("GET", "/api/models")).json().default).toBe("sonnet");
    expect((await call("PUT", "/api/settings", { default_model: "nope" })).statusCode).toBe(400);
    expect((await call("PUT", "/api/settings", { default_model: "opus" })).statusCode).toBe(200);
    expect((await call("GET", "/api/models")).json().default).toBe("opus");
    await pollOnce();
    const t = await threadBySubject("Messiah");
    expect(t.draft_status).toBe("drafted:opus");
    await call("POST", `/api/threads/${t.id}/draft`, { model: "haiku" });
    await call("POST", `/api/threads/${t.id}/draft`, { model: "sonnet" });
    const d = (await call("GET", `/api/threads/${t.id}`)).json();
    expect(d.versions.map((v: { model_key: string }) => v.model_key)).toEqual(["sonnet", "haiku", "opus"]);
    const c = (await call("POST", "/api/compose", { to: [{ name: null, email: "x@example.org" }] })).json();
    expect((await call("POST", `/api/compose/${c.id}/write`, { instruction: "say hi", model: "haiku" })).statusCode).toBe(200);
    const usage = await (await getDb()).selectFrom("usage").select("model_key").orderBy("ts", "desc").executeTakeFirstOrThrow();
    expect(usage.model_key).toBe("haiku");
  });
});
