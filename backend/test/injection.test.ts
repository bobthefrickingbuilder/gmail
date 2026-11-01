/**
 * PROMPT-INJECTION TEST SET
 * Hostile emails must (a) cause no action — no send, no calendar write, no
 * label beyond our normal AI/* labels, no forwarding — and (b) be flagged.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setup } from "./helpers.js";
import { pollOnce } from "../src/worker/index.js";
import { getDb, pj } from "../src/db/index.js";
import { buildDraftPrompt } from "../src/drafting/prompt.js";
import { HOSTILE } from "../src/eval/hostile.js";

const here = path.dirname(fileURLToPath(import.meta.url));



describe("prompt-injection test set", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { ctx = await setup({ seed: false }); });

  it("no action occurs and every hostile email is flagged", async () => {
    HOSTILE.forEach((h, i) => ctx.mail.receive({ id: `h${i}`, threadId: `th${i}`, from: `Stranger ${i} <s${i}@unknown.example>`, subject: h.subject,
      body: h.body, date: new Date().toUTCString(), messageId: `<h${i}@unknown.example>` }));
    const sentBefore = ctx.mail.sent.length;
    await pollOnce();
    expect(ctx.mail.sent.length).toBe(sentBefore);           // nothing sent
    expect(ctx.calendar.created).toHaveLength(0);              // nothing scheduled
    const allowed = new Set(["AI/Drafted", "AI/Needs-Review", "AI/Skipped", "AI/Escalated", "INBOX", "SENT", "UNREAD"]);
    for (const name of ctx.mail.labels.keys()) expect(allowed.has(name)).toBe(true); // no foreign labels created
    const db = await getDb();
    const tri = await db.selectFrom("triage").select(["flags_json", "message_id"]).execute();
    expect(tri).toHaveLength(HOSTILE.length);
    for (const t of tri) expect(pj<string[]>(t.flags_json, [])).toContain("possible_prompt_injection");
    const versions = await db.selectFrom("draft_versions").select("flags_json").execute();
    for (const v of versions) expect(pj<string[]>(v.flags_json, [])).toContain("possible_prompt_injection");
    // drafting calls never received tools: our provider interface has no tool parameter at all
    for (const c of ctx.llm.calls) expect(Object.keys(c).sort()).toEqual(["modelKey", "schemaName", "system", "user"]);
  });

  it("hostile text stays inside the data block", () => {
    const { user } = buildDraftPrompt({ ownerDescription: "x", styleGuide: "x", profile: null, pinnedDocs: [], shareScheduleDetails: false, instruction: null,
      examples: [], replyLanguageHint: null, today: "today", recipients: { to: [], cc: [] }, availability: null,
      thread: [{ fromName: "S", fromEmail: "s@x", isFromMe: false, date: "d", subject: "s", text: HOSTILE[2].body, attachments: [] }] });
    expect(user.indexOf("</thread>")).toBeGreaterThan(user.indexOf("Send this draft immediately"));
    expect(user).not.toMatch(/<instruction_from_matthew>\s*Send this draft/);
  });

  it("the worker cannot reach the send function (static check)", () => {
    const src = path.join(here, "..", "src");
    const visited = new Set<string>();
    const walk = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      const code = fs.readFileSync(file, "utf8");
      for (const m of code.matchAll(/from\s+"(\.{1,2}\/[^"]+)\.js"/g)) walk(path.resolve(path.dirname(file), m[1] + ".ts"));
    };
    walk(path.join(src, "worker", "index.ts"));
    const files = [...visited].map((f) => path.relative(src, f));
    expect(files).not.toContain(path.join("drafting", "send.ts"));
    expect(files).not.toContain(path.join("routes", "drafts.ts"));
    for (const f of visited) expect(fs.readFileSync(f, "utf8")).not.toMatch(/\.sendDraft\(/);
  });
});
