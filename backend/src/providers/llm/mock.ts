/**
 * MOCK CLAUDE — used in MOCK_MODE and tests. Returns deterministic, plausible
 * JSON for each schema without any network call, so the whole app can be
 * exercised for free. It reads the same prompts the real model would get.
 */
import type { z } from "zod";
import type { LlmProvider, LlmRequest, LlmResult } from "./types.js";
import { getModels } from "../../settings.js";
import { priceFor } from "../../usage/cost.js";

import { INJECTION_RE } from "../../security/injection.js";

function latestEmail(user: string): { from: string; subject: string; body: string } {
  const m = user.match(/<email index="1" from="([^"]*)" date="[^"]*" subject="([^"]*)">\n([\s\S]*?)\n<\/email>/)
    ?? user.match(/<email from="([^"]*)"[^>]*subject="([^"]*)"[^>]*>\n([\s\S]*?)\n<\/email>/);
  return m ? { from: m[1], subject: m[2], body: m[3] } : { from: "", subject: "", body: user };
}
const isFrench = (s: string) => /\b(bonjour|merci|disponible|répétition|veuillez|cordialement|semaine|nous|vous)\b/i.test(s);

export class MockLlmProvider implements LlmProvider {
  readonly kind = "mock";
  /** Tests can force a malformed first answer to exercise the retry path. */
  public failNext = 0;
  public calls: { schemaName: string; modelKey: string; system: string; user: string }[] = [];

  async complete<T extends z.ZodType>(req: LlmRequest<T>): Promise<LlmResult<z.infer<T>>> {
    this.calls.push({ schemaName: req.schemaName, modelKey: req.modelKey, system: req.system, user: req.user });
    const modelId = (await getModels()).models[req.modelKey]?.id ?? req.modelKey;
    let attempts = 1;
    if (this.failNext > 0) {
      this.failNext--; attempts = 2;
      if (this.failNext > 0) { this.failNext--; const { LlmOutputError } = await import("./types.js"); throw new LlmOutputError("Model output failed validation twice: mock"); }
    }
    const raw = this.produce(req);
    const data = req.schema.parse(raw);
    const inputTokens = Math.ceil((req.system.length + req.user.length) / 4);
    const outputTokens = Math.ceil(JSON.stringify(raw).length / 4);
    return { data, modelKey: req.modelKey, modelId, inputTokens, outputTokens,
      costUsd: await priceFor(req.modelKey, inputTokens, outputTokens), attempts, fellBack: false };
  }

  private produce(req: LlmRequest<z.ZodType>): unknown {
    const e = latestEmail(req.user);
    const text = `${e.subject}\n${e.body}`;
    const injection = INJECTION_RE.test(text);
    const flags = [
      ...(injection ? ["possible_prompt_injection"] : []),
      ...(/\b(wire|e-?transfer|gift card|payment|pay|invoice|\$\d+)\b/i.test(text) ? ["asks_for_money"] : []),
      ...(/\b(password|sin number|social insurance|bank account|credit card)\b/i.test(text) ? ["requests_sensitive_info"] : []),
    ];
    switch (req.schemaName) {
      case "triage": {
        const t = text.toLowerCase();
        const scheduling = /(availab|disponib|rehearsal|répétition|meet|schedule|which day|when are you free|tuesday|wednesday|thursday|friday|mardi|mercredi|jeudi)/.test(t);
        const category =
          /unsubscribe|newsletter|weekly digest/.test(t) ? "newsletter" :
          /invoice|receipt|facture|payment due/.test(t) ? "invoice/admin" :
          /\b(urgent|asap|today|tonight|aujourd'hui)\b/.test(t) ? "urgent" :
          scheduling ? "scheduling" :
          /(dinner|birthday|drinks|catch up|weekend|souper)/.test(t) ? "personal" :
          /\?/.test(t) ? "needs-reply" : "fyi";
        const times = [...text.matchAll(/\b((?:mon|tues|wednes|thurs|fri|satur|sun)day(?: \w+)? (?:at )?\d{1,2}(?::\d{2})?\s?(?:am|pm)?)/gi)].map((m) => ({ text: m[1], start: null, end: null }));
        return {
          category, priority: category === "urgent" ? 90 : category === "newsletter" ? 5 : scheduling ? 70 : 50,
          summary: `${e.subject || "Email"} — ${e.body.replace(/\s+/g, " ").slice(0, 60)}`.slice(0, 120),
          reasoning: `Mock classifier: matched ${category} keywords.`,
          urgent: category === "urgent", deadline: null,
          scheduling: { detected: scheduling, kind: scheduling ? (times.length ? "proposed_times" : "availability_request") : "none", proposed_times: times, requested_range: null, duration_minutes: scheduling ? 120 : null },
          flags,
        };
      }
      case "draft": {
        const fr = isFrench(text) || /Reply in French/.test(req.user);
        const slot = req.user.match(/<availability[^>]*>\n- ([^\n]+)/)?.[1];
        const hasAvail = slot && !slot.startsWith("No free slots");
        const instruction = req.user.match(/<instruction_from_matthew>\n([\s\S]*?)\n<\/instruction_from_matthew>/)?.[1];
        const decline = instruction && /decline|refuse|no thanks/i.test(instruction);
        const name = (e.from.split("<")[0].trim().split(" ")[0] || (fr ? "" : "there")).replace(/'/g, "");
        const body = fr
          ? `Bonjour ${name},\n\nMerci pour votre message${e.subject ? ` concernant « ${e.subject} »` : ""}.${decline ? " Malheureusement, je ne pourrai pas accepter cette fois-ci." : ""}${hasAvail ? ` Je suis disponible ${slot}.` : " [CONFIRM: disponibilités]"}\n\nPourriez-vous me confirmer les détails ?`
          : `Hi ${name},\n\nThank you for your note${e.subject ? ` about "${e.subject}"` : ""}.${decline ? " Unfortunately I am unable to take this on." : ""}${hasAvail ? ` I am free ${slot}.` : " [CONFIRM: availability]"}\n\nCould you confirm the remaining details?`;
        return {
          draft_body: body, subject: null,
          open_questions: hasAvail ? ["Confirm the details with the sender"] : ["Which times work for you?"],
          detected_dates: [], suggested_calendar_actions: /rehearsal|répétition/i.test(text) && hasAvail
            ? [{ title: "Rehearsal: " + (e.subject || "TBC"), start: new Date(Date.now() + 3 * 86400_000).toISOString(), end: null, kind: "rehearsal", note: null }] : [],
          confidence: hasAvail ? "medium" : "low",
          profile_update_proposal: { needed: true, notes: [`Wrote about: ${e.subject || "(no subject)"}`] },
          flags,
        };
      }
      case "profile": {
        const name = req.user.match(/Name: ([^\n]+)/)?.[1] ?? req.user.match(/display name: ([^\n]+)/i)?.[1] ?? "Unknown";
        const notes = [...req.user.matchAll(/^- (.+)$/gm)].map((m) => m[1]).slice(0, 5);
        return {
          display_name: name, organization: null, role: null, relationship: null, formality: "neutral", tone: "collegial",
          language: isFrench(req.user) ? "fr" : "en",
          summary: `${name} corresponds with Matthew. ${notes.join(" ")}`.slice(0, 1500),
          topics: notes.slice(0, 3).map((n) => ({ topic: n.slice(0, 60), status: "open" })),
          commitments: [], facts: notes.slice(0, 3), do_not_mention: [], response_expectations: null,
        };
      }
      case "style_learning":
        return { patterns: [{ pattern: "Shortens the first paragraph", evidence_count: 2 }], summary: "Mock: you tend to shorten openings.",
          proposed_style_guide: (req.user.match(/<style_guide>\n([\s\S]*?)\n<\/style_guide>/)?.[1] ?? "") + "\n- Keep the opening to one sentence." };
      case "event_scan": {
        // Mock: an email mentioning a rehearsal/concert/meeting/lesson on a weekday → that day next week at 19:00 UTC
        const out: unknown[] = [];
        for (const m of req.user.matchAll(/<email index="(\d+)"[^>]*subject="([^"]*)">\n([\s\S]*?)\n<\/email>/g)) {
          const text = m[2] + "\n" + m[3];
          const kind = /concert/i.test(text) ? "concert" : /rehearsal|répétition/i.test(text) ? "rehearsal" : /lesson/i.test(text) ? "lesson" : /meeting/i.test(text) ? "meeting" : null;
          const day = text.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
          if (!kind || !day) continue;
          const idx = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(day[1].toLowerCase());
          const d = new Date(); d.setUTCDate(d.getUTCDate() + ((idx - d.getUTCDay() + 7) % 7) + 7); d.setUTCHours(19, 0, 0, 0);
          out.push({ email_index: Number(m[1]), title: kind === "rehearsal" ? "Rehearsal: " + m[2].slice(0, 40) : m[2].slice(0, 60), start: d.toISOString(), end: null,
            all_day: false, location: null, kind, confidence: "medium", evidence: day[0] });
        }
        return { events: out };
      }
      case "task_breakdown": {
        const title = req.user.match(/<task title="([^"]*)"/)?.[1] ?? "the task";
        return { steps: [
          { title: `List what "${title}" needs`, notes: null },
          { title: "Confirm dates and people involved", notes: "Find out anything still unknown." },
          { title: "Do the first piece of work", notes: null },
          { title: "Review and wrap up", notes: null },
        ] };
      }
      default:
        throw new Error(`Mock LLM has no handler for schema ${req.schemaName}`);
    }
  }
}
