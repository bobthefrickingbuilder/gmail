/**
 * DRAFT POST-CHECKS
 * After the model answers, the backend double-checks the draft with simple
 * rules that don't trust the model:
 *  - removes a trailing sign-off/name (the signature is the sign-off)
 *  - flags filler words from the style guide
 *  - flags possible schedule disclosure (an event name from your calendar
 *    appearing in the draft when you did not allow sharing details)
 *  - makes sure every [CONFIRM: …] placeholder is listed as an open question
 *  - applies the concert/rehearsal title rule to calendar suggestions
 * The same checks power the evaluation harness.
 */
import { normalizeEventTitle } from "../calendar/availability.js";
import type { DraftOutput } from "../providers/llm/schemas.js";

export const FILLER_WORDS = ["genuinely", "really", "simply", "beautifully"];
const SIGNOFF_RE = /^(best( regards| wishes)?|kind regards|regards|warm(est)? regards|all the best|cheers|thanks( again| so much)?|thank you|many thanks|sincerely|yours( truly| sincerely)?|cordialement|bien (à vous|cordialement)|merci( beaucoup| encore)?|amitiés|salutations( distinguées)?|à bientôt|au plaisir)[,.!]?$/i;
const NAME_RE = /^[-–—\s]*(matthew( menard)?|matt|m\.?)\s*$/i;

export function stripTrailingSignoff(body: string): { body: string; stripped: boolean } {
  const lines = body.replace(/\s+$/, "").split("\n");
  let stripped = false;
  for (let k = 0; k < 3 && lines.length > 1; k++) {
    const last = lines[lines.length - 1].trim();
    if (last === "" || SIGNOFF_RE.test(last) || NAME_RE.test(last)) { lines.pop(); if (last) stripped = true; }
    else break;
  }
  return { body: lines.join("\n").replace(/\s+$/, ""), stripped };
}

export function findFillerWords(body: string): string[] {
  return FILLER_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(body));
}

/** Words that would reveal a private event: multi-word summaries or distinctive single words. */
export function scheduleDisclosures(body: string, eventSummaries: string[]): string[] {
  const text = body.toLowerCase();
  const hits: string[] = [];
  const stop = new Set(["meeting", "call", "busy", "lunch", "free", "event", "appointment", "the", "and", "with", "for", "rehearsal", "concert"]);
  for (const s of eventSummaries) {
    const name = s.split(" — ")[0].toLowerCase().trim();
    if (!name) continue;
    if (name.length >= 8 && text.includes(name)) { hits.push(s.split(" — ")[0]); continue; }
    const words = name.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5 && !stop.has(w));
    if (words.length && words.every((w) => text.includes(w))) hits.push(s.split(" — ")[0]);
  }
  return [...new Set(hits)];
}

export function placeholders(body: string): string[] {
  return [...body.matchAll(/\[CONFIRM:\s*([^\]]+)\]/gi)].map((m) => m[1].trim());
}

export interface PostCheckResult { output: DraftOutput; notes: string[] }

export function postCheck(out: DraftOutput, ctx: { eventSummaries: string[]; shareScheduleDetails: boolean; injectionSuspected: boolean }): PostCheckResult {
  const notes: string[] = [];
  const flags = new Set(out.flags);
  const s = stripTrailingSignoff(out.draft_body);
  if (s.stripped) notes.push("Removed a sign-off line; the signature is the sign-off.");
  const filler = findFillerWords(s.body);
  if (filler.length) { flags.add("filler_words"); notes.push(`Filler words: ${filler.join(", ")}`); }
  if (!ctx.shareScheduleDetails) {
    const leaks = scheduleDisclosures(s.body, ctx.eventSummaries);
    if (leaks.length) { flags.add("possible_schedule_disclosure"); notes.push("Draft may mention a private calendar event."); }
  }
  if (ctx.injectionSuspected) flags.add("possible_prompt_injection");
  const open = [...out.open_questions];
  for (const p of placeholders(s.body)) if (!open.some((q) => q.toLowerCase().includes(p.toLowerCase()))) open.push(`Confirm: ${p}`);
  const actions = out.suggested_calendar_actions.map((a) => ({ ...a, title: normalizeEventTitle(a.title, a.kind) }));
  return { output: { ...out, draft_body: s.body, open_questions: open, suggested_calendar_actions: actions, flags: [...flags] }, notes };
}
