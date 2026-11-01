import { describe, it, expect } from "vitest";
import { applyRules, keywordUrgent, deadlineWithin, ruleMatches } from "../src/triage/rules.js";
import { loadTriageRules } from "../src/config.js";

const cfg = loadTriageRules();
const base = { fromEmail: "claire@choir.example.org", labels: ["INBOX"], headers: {}, isFromMe: false };

describe("triage stage 1 rules", () => {
  it("passes normal mail", () => expect(applyRules(base, cfg, []).skip).toBe(false));
  it("skips List-Unsubscribe / Precedence bulk / Auto-Submitted", () => {
    expect(applyRules({ ...base, headers: { "List-Unsubscribe": "<mailto:x>" } }, cfg, [])).toMatchObject({ skip: true, category: "newsletter" });
    expect(applyRules({ ...base, headers: { precedence: "bulk" } }, cfg, []).skip).toBe(true);
    expect(applyRules({ ...base, headers: { "auto-submitted": "auto-generated" } }, cfg, []).skip).toBe(true);
    expect(applyRules({ ...base, headers: { "auto-submitted": "no" } }, cfg, []).skip).toBe(false);
  });
  it("skips no-reply senders, bulk domains, promo labels and my own mail", () => {
    expect(applyRules({ ...base, fromEmail: "no-reply@x.com" }, cfg, []).skip).toBe(true);
    expect(applyRules({ ...base, fromEmail: "donotreply@x.com" }, cfg, []).skip).toBe(true);
    expect(applyRules({ ...base, fromEmail: "x@bounce.mailchimp.com" }, cfg, []).skip).toBe(true);
    expect(applyRules({ ...base, labels: ["CATEGORY_PROMOTIONS"] }, cfg, []).skip).toBe(true);
    expect(applyRules({ ...base, isFromMe: true }, cfg, []).reason).toBe("Sent by you");
  });
  it("user rules: skip, category, VIP bypasses automated skips, escalate", () => {
    expect(applyRules(base, cfg, [{ match: "@choir.example.org", action: "skip", value: null }]).skip).toBe(true);
    expect(applyRules(base, cfg, [{ match: "claire@choir.example.org", action: "category", value: "fyi" }]).category).toBe("fyi");
    const vip = applyRules({ ...base, headers: { "List-Unsubscribe": "x" } }, cfg, [{ match: "claire@choir.example.org", action: "vip", value: null }]);
    expect(vip).toMatchObject({ skip: false, vip: true });
    expect(applyRules(base, cfg, [{ match: "*@choir.example.org", action: "escalate", value: "sonnet" }]).escalateModel).toBe("sonnet");
  });
  it("rule matching", () => {
    expect(ruleMatches("@example.org", "a@sub.example.org", [])).toBe(true);
    expect(ruleMatches("@example.org", "a@badexample.org", [])).toBe(false);
    expect(ruleMatches("label:IMPORTANT", "a@b.c", ["IMPORTANT"])).toBe(true);
  });
  it("urgent keywords match whole words in EN/FR", () => {
    expect(keywordUrgent("Please reply ASAP", cfg.urgent_keywords)).toBe("asap");
    expect(keywordUrgent("C'est pour aujourd'hui", cfg.urgent_keywords)).toBe("aujourd'hui");
    expect(keywordUrgent("todays's weather is nice", ["today"])).toBeNull();
  });
  it("deadline within 48h", () => {
    const n = Date.UTC(2026, 10, 1, 12);
    expect(deadlineWithin("2026-11-02T17:00:00Z", 48, n)).toBe(true);
    expect(deadlineWithin("2026-11-05T17:00:00Z", 48, n)).toBe(false);
    expect(deadlineWithin(null, 48, n)).toBe(false);
  });
});
