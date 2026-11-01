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
    expect((await threadBySubject("Messiah")).draft_status).toBe("drafted:haiku");
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
    expect(d.buttons.primary.label).toBe("Draft with Haiku");
    expect(d.buttons.toggle.label).toBe("Start on Sonnet");

    await call("POST", `/api/threads/${t.id}/draft`, {});
    d = (await call("GET", `/api/threads/${t.id}`)).json();
    expect(d.buttons.primary.label).toBe("Redraft with Sonnet");
    expect(d.versions[0].model_key).toBe("haiku");
    expect(d.scheduling).not.toBeNull();

    await call("POST", `/api/threads/${t.id}/draft`, { model: "sonnet", instruction: "decline politely" });
    d = (await call("GET", `/api/threads/${t.id}`)).json();
    expect(d.buttons.primary.label).toBe("Redraft with Opus");
    expect(d.buttons.secondary.label).toBe("Redraft");
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
