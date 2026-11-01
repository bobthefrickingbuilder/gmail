import { describe, it, expect, beforeEach } from "vitest";
import { setup } from "./helpers.js";
import { pollOnce } from "../src/worker/index.js";
import { getDb } from "../src/db/index.js";
import { startSeedJob, runSeedJob } from "../src/profiles/seed.js";
import { runLearning, decideProposal } from "../src/learning/nightly.js";
import { purgeOldBodies } from "../src/ops/retention.js";
import { getStyleGuide, saveSettings } from "../src/settings.js";
import { safePayload, inQuietHours } from "../src/notify/push.js";
import { AnthropicProvider } from "../src/providers/llm/anthropic.js";
import { LlmOutputError, LlmRefusalError } from "../src/providers/llm/types.js";
import { TriageOutput } from "../src/providers/llm/schemas.js";
import { autoModelFor } from "../src/drafting/models.js";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { ctx = await setup(); });

describe("profile seeding job", () => {
  it("scans sent mail, profiles top correspondents, is resumable", async () => {
    const id = await startSeedJob(12, 10);
    expect(await startSeedJob(12, 10)).toBe(id); // no duplicate job
    expect(await runSeedJob(id, { delayMs: 0, maxSteps: 1 })).toBe("paused");
    expect(await runSeedJob(id, { delayMs: 0 })).toBe("done");
    const db = await getDb();
    const people = await db.selectFrom("people").selectAll().where("summary", "!=", "").execute();
    expect(people.map((p) => p.display_name).sort()).toEqual(["Claire Dubois", "Daniel Okafor", "Raj Patel", "Sophie Tremblay"]);
    const job = await db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(JSON.parse(job.progress_json)).toMatchObject({ phase: "done", scanned: 4, profiled: 4 });
  });
});

describe("learning from edits", () => {
  it("proposes style-guide changes; nothing applied until accepted", async () => {
    await saveSettings({ auto_draft: true });
    await pollOnce();
    const db = await getDb();
    for (const d of await db.selectFrom("drafts").selectAll().execute())
      await db.updateTable("drafts").set({ edit_class: "edited", final_body: "Short reply.", updated_at: new Date().toISOString() }).where("id", "=", d.id).execute();
    const before = await getStyleGuide();
    const r = await runLearning();
    expect(r.proposed).toBe(true);
    expect(await getStyleGuide()).toBe(before);
    await decideProposal(r.id!, true);
    expect(await getStyleGuide()).toContain("Keep the opening to one sentence.");
  });
});

describe("retention", () => {
  it("purges old bodies, keeps metadata and your own words", async () => {
    await pollOnce();
    const n = await purgeOldBodies(5); // fixtures are 0–40 days old
    expect(n).toBeGreaterThan(0);
    const db = await getDb();
    const purged = await db.selectFrom("messages").selectAll().where("body_purged_at", "is not", null).execute();
    for (const m of purged) { expect(m.body_text).toBeNull(); expect(m.subject).not.toBe(""); if (!m.is_from_me) expect(m.stripped_text).toBeNull(); }
    expect(purged.some((m) => m.is_from_me && m.stripped_text)).toBe(true);
  });
});

describe("notifications", () => {
  it("payload carries sender + subject only, truncated", () => {
    const p = safePayload({ title: "Claire Dubois", body: "Subject line ".repeat(30) });
    expect(p.body.length).toBeLessThanOrEqual(120);
    expect(Object.keys(p).filter((k) => (p as unknown as Record<string, unknown>)[k] !== undefined).sort()).toEqual(["body", "title"]);
  });
  it("quiet hours wrap midnight", () => {
    const q = { start: "22:00", end: "07:30" };
    expect(inQuietHours(q, "UTC", new Date("2026-11-01T23:00:00Z"))).toBe(true);
    expect(inQuietHours(q, "UTC", new Date("2026-11-01T06:00:00Z"))).toBe(true);
    expect(inQuietHours(q, "UTC", new Date("2026-11-01T12:00:00Z"))).toBe(false);
  });
});

describe("model selection", () => {
  it("auto-escalation rules", async () => {
    expect(await autoModelFor({ fromEmail: "a@b.c", labels: [], category: "needs-reply", personEscalate: null, ruleEscalate: null })).toBe("haiku");
    await saveSettings({ escalation_rules: { senders: ["@publisher.example"], labels: [], categories: ["urgent"], model: "sonnet" } });
    expect(await autoModelFor({ fromEmail: "x@publisher.example", labels: [], category: "fyi", personEscalate: null, ruleEscalate: null })).toBe("sonnet");
    expect(await autoModelFor({ fromEmail: "a@b.c", labels: [], category: "urgent", personEscalate: null, ruleEscalate: null })).toBe("sonnet");
    expect(await autoModelFor({ fromEmail: "a@b.c", labels: [], category: "fyi", personEscalate: "opus", ruleEscalate: null })).toBe("opus");
  });
});

describe("Anthropic provider (stubbed client)", () => {
  const good = { category: "fyi", priority: 10, summary: "s", reasoning: "r", urgent: false, deadline: null,
    scheduling: { detected: false, kind: "none", proposed_times: [], requested_range: null, duration_minutes: null }, flags: [] };
  const resp = (text: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", model: "claude-haiku-5-5",
    usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, ...extra });
  function provider(responses: unknown[]) {
    const p = new AnthropicProvider("test-key");
    const calls: Record<string, unknown>[] = [];
    (p as unknown as { client: unknown }).client = { beta: { messages: { create: async (body: Record<string, unknown>) => { calls.push(body); return responses.shift(); } } } };
    return { p, calls };
  }
  const req = { modelKey: "haiku", purpose: "triage" as const, system: "sys", user: "u", schema: TriageOutput, schemaName: "triage", maxTokens: 100 };

  it("sends no tools, uses structured output, model id from config, and prices usage", async () => {
    const { p, calls } = provider([resp(JSON.stringify(good))]);
    const r = await p.complete(req);
    expect(r.data.category).toBe("fyi");
    expect(calls[0].model).toBe("claude-haiku-5-5");
    expect(calls[0].tools).toBeUndefined();
    expect((calls[0].output_config as { format: { type: string } }).format.type).toBe("json_schema");
    expect(r.costUsd).toBeCloseTo((1000 * 0.1 + 100 * 0.5) / 1e6, 10);
  });
  it("retries once on malformed JSON, then fails", async () => {
    const ok = provider([resp("not json"), resp(JSON.stringify(good))]);
    expect((await ok.p.complete(req)).attempts).toBe(2);
    expect(ok.calls[1].messages).toEqual([{ role: "user", content: expect.stringContaining("not valid JSON") }]);
    const bad = provider([resp("{}"), resp("nope")]);
    await expect(bad.p.complete(req)).rejects.toBeInstanceOf(LlmOutputError);
  });
  it("refusal stops with a clear error; Sonnet requests opt into server-side fallback", async () => {
    const r = provider([resp("", { stop_reason: "refusal", stop_details: { category: "cyber" } })]);
    await expect(r.p.complete(req)).rejects.toBeInstanceOf(LlmRefusalError);
    const s = provider([resp(JSON.stringify(good), { model: "claude-sonnet-5-5" })]);
    await s.p.complete({ ...req, modelKey: "sonnet" });
    expect(s.calls[0]).toMatchObject({ model: "claude-sonnet-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
  });
});
