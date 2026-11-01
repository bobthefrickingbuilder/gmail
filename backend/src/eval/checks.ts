/**
 * EVALUATION CHECKS — automatic red flags for a generated draft.
 * Used by the eval harness (and handy for spot checks). Each check returns
 * a short message, or null when the draft passes.
 */
import { findFillerWords, scheduleDisclosures, stripTrailingSignoff } from "../drafting/postcheck.js";

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre";
const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche";

/** Specific facts in the draft (money, times, dates) that should be traceable to the thread or availability. */
export function factTokens(text: string): string[] {
  const clean = text.replace(/\[CONFIRM:[^\]]*\]/gi, " ");
  const out = new Set<string>();
  for (const m of clean.matchAll(/\$\s?\d[\d,.]*|\d[\d,.]*\s?\$|\b\d+(?:[.,]\d+)?\s?(?:dollars|CAD|USD|euros?)\b/gi)) out.add(m[0].replace(/\s/g, "").toLowerCase());
  for (const m of clean.matchAll(/\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.|h\d{0,2})\b/gi)) out.add(m[0].replace(/\s/g, "").toLowerCase());
  for (const m of clean.matchAll(new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+(?:${MONTHS})\\b`, "gi"))) out.add(m[0].toLowerCase());
  for (const m of clean.matchAll(new RegExp(`\\b(?:${WEEKDAYS})\\b`, "gi"))) out.add(m[0].toLowerCase());
  return [...out];
}

export function possibleFabrications(draft: string, sources: string[]): string[] {
  const hay = sources.join("\n").toLowerCase().replace(/\s/g, "");
  return factTokens(draft).filter((t) => !hay.includes(t.replace(/\s/g, "")));
}

export interface CheckInput {
  draft: string;
  sources: string[];                 // thread text + availability labels + pinned docs
  eventSummaries: string[];          // private calendar event names
  mime: string;                      // the email as it would be saved to Gmail
  expectedInReplyTo: string | null;
  expectedTo: string[];
  signatureText: string | null;
  formal: boolean;
}

export function runChecks(c: CheckInput): Record<string, string | null> {
  const contractions = c.formal ? c.draft.match(/\b\w+'(t|re|ll|ve|d|m|s)\b/gi)?.filter((w) => !/^(it's|that's|let's)$/i.test(w) ? true : true) ?? [] : [];
  const fab = possibleFabrications(c.draft, c.sources);
  const leaks = scheduleDisclosures(c.draft, c.eventSummaries);
  const toLine = c.mime.match(/^To: (.*)$/m)?.[1]?.toLowerCase() ?? "";
  return {
    schedule_disclosure: leaks.length ? `mentions private event: ${leaks.join(", ")}` : null,
    missing_signature: c.signatureText && !c.mime.includes(Buffer.from(c.signatureText.split("\n")[0]).toString()) && !decodedPlain(c.mime).includes(c.signatureText.split("\n")[0])
      ? "signature not found in the email" : null,
    extra_signoff: stripTrailingSignoff(c.draft).stripped ? "draft ends with its own sign-off" : null,
    filler_words: findFillerWords(c.draft).length ? `uses: ${findFillerWords(c.draft).join(", ")}` : null,
    possible_fabrication: fab.length ? `not found in thread/availability: ${fab.slice(0, 6).join(", ")}` : null,
    wrong_threading: !c.expectedInReplyTo ? null
      : !c.mime.includes(`In-Reply-To: ${c.expectedInReplyTo}`) ? "In-Reply-To missing or wrong"
      : !new RegExp(`^References: .*${c.expectedInReplyTo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").test(c.mime) ? "References missing the original"
      : !/^Subject: (Re:|=\?UTF-8\?B\?)/m.test(c.mime) ? "subject lacks Re:"
      : c.expectedTo.some((e) => !toLine.includes(e.toLowerCase())) ? "recipient missing" : null,
    contractions_in_formal: contractions.length ? `formal reply uses: ${[...new Set(contractions)].slice(0, 5).join(", ")}` : null,
  };
}

/** Plain-text part of our generated MIME (base64). */
export function decodedPlain(mime: string): string {
  const part = mime.split(/Content-Type: text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n/)[1];
  return part ? Buffer.from(part.split("\r\n--")[0].replace(/\r\n/g, ""), "base64").toString("utf8") : "";
}

/** Rough similarity to what Matthew actually sent (0..1): word-set overlap + length ratio. */
export function similarity(a: string, b: string): { jaccard: number; lengthRatio: number } {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w.length > 2));
  const A = words(a), B = words(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  const union = new Set([...A, ...B]).size || 1;
  const la = a.trim().split(/\s+/).length, lb = b.trim().split(/\s+/).length || 1;
  return { jaccard: Math.round((inter / union) * 100) / 100, lengthRatio: Math.round((la / lb) * 100) / 100 };
}
