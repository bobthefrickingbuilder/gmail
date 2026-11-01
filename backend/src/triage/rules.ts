/**
 * TRIAGE STAGE 1 — RULES (no model call, free)
 * Skips mail that should never get a drafted reply: newsletters and bulk
 * mail (List-Unsubscribe / Precedence headers), no-reply and automated
 * senders, spam/promotions labels, your own messages, and senders you've
 * told it to skip. Also applies your sender rules (VIP, escalate, category).
 */
import type { TriageRulesConfig } from "../config.js";

export interface RuleInput {
  fromEmail: string;
  labels: string[];
  headers: Record<string, string>;
  isFromMe: boolean;
}
export interface SenderRule { match: string; action: string; value: string | null }

export interface RuleResult {
  skip: boolean;
  reason: string | null;
  category: string | null; // set when a rule decides the category without the model
  vip: boolean;
  escalateModel: string | null;
}

/** Does a rule's `match` apply? Supports exact address, "@domain.com", "*@domain", or "label:NAME". */
export function ruleMatches(match: string, fromEmail: string, labels: string[]): boolean {
  const m = match.trim().toLowerCase();
  if (!m) return false;
  if (m.startsWith("label:")) return labels.map((l) => l.toLowerCase()).includes(m.slice(6));
  const email = fromEmail.toLowerCase();
  if (m.startsWith("@") || m.startsWith("*@")) {
    const dom = m.replace(/^\*?@/, "");
    const host = email.split("@")[1] ?? "";
    return host === dom || host.endsWith("." + dom);
  }
  return email === m;
}

export function applyRules(input: RuleInput, cfg: TriageRulesConfig, senderRules: SenderRule[], vipEmails: string[] = []): RuleResult {
  const res: RuleResult = { skip: false, reason: null, category: null, vip: false, escalateModel: null };
  const from = input.fromEmail.toLowerCase();
  const h = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]));

  for (const r of senderRules) {
    if (!ruleMatches(r.match, from, input.labels)) continue;
    if (r.action === "vip") res.vip = true;
    if (r.action === "escalate") res.escalateModel = r.value || "sonnet";
    if (r.action === "category" && r.value) res.category = r.value;
    if (r.action === "skip") return { ...res, skip: true, reason: `Sender rule: ${r.match}` };
  }
  if (vipEmails.map((v) => v.toLowerCase()).includes(from)) res.vip = true;
  // VIPs bypass the automatic skip rules below (but not "from yourself").
  if (input.isFromMe) return { ...res, skip: true, reason: "Sent by you" };
  if (res.vip) return res;

  const skipLabel = input.labels.find((l) => cfg.skip_labels.includes(l));
  if (skipLabel) return { ...res, skip: true, reason: `Gmail label ${skipLabel}`, category: skipLabel === "SPAM" ? "other" : "newsletter" };
  for (const name of cfg.skip_if_header_present) {
    if (h[name.toLowerCase()]) return { ...res, skip: true, reason: `Bulk mail (${name} header)`, category: "newsletter" };
  }
  const prec = (h["precedence"] ?? "").toLowerCase().trim();
  if (prec && cfg.skip_precedence_values.includes(prec)) return { ...res, skip: true, reason: `Precedence: ${prec}`, category: "newsletter" };
  const auto = (h["auto-submitted"] ?? "").toLowerCase().trim();
  if (cfg.skip_auto_submitted && auto && auto !== "no") return { ...res, skip: true, reason: "Automated message (Auto-Submitted)", category: "fyi" };
  if (h["x-spam-flag"]?.toLowerCase() === "yes") return { ...res, skip: true, reason: "Marked as spam", category: "other" };
  const local = from.split("@")[0] ?? "";
  for (const p of cfg.noreply_patterns) {
    if (new RegExp(p, "i").test(local) || new RegExp(p, "i").test(from)) return { ...res, skip: true, reason: `No-reply sender (${from})`, category: "fyi" };
  }
  const host = from.split("@")[1] ?? "";
  if (cfg.bulk_sender_domains.some((d) => host === d || host.endsWith("." + d))) return { ...res, skip: true, reason: `Known bulk sender (${host})`, category: "newsletter" };
  return res;
}

/** Keyword / deadline urgency check that does not need the model. */
export function keywordUrgent(text: string, keywords: string[]): string | null {
  const t = text.toLowerCase();
  for (const k of keywords) {
    const kw = k.toLowerCase().trim();
    if (!kw) continue;
    const re = new RegExp(`(^|[^\\p{L}])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "u");
    if (re.test(t)) return kw;
  }
  return null;
}

export function deadlineWithin(deadlineIso: string | null, hours: number, nowMs = Date.now()): boolean {
  if (!deadlineIso) return false;
  const t = new Date(deadlineIso).getTime();
  return !isNaN(t) && t >= nowMs - 3600_000 && t - nowMs <= hours * 3600_000;
}
