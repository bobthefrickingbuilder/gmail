/**
 * OUTPUT SCHEMAS — the exact JSON shapes the model must return.
 * Each one is checked by Zod after the call; anything that doesn't match is
 * retried once, then reported as an error (the email stays undrafted).
 */
import { z } from "zod";

export const CATEGORIES = ["needs-reply", "fyi", "scheduling", "invoice/admin", "newsletter", "personal", "urgent", "other"] as const;

export const TimeSpan = z.object({
  text: z.string().describe("The words in the email, e.g. 'Tuesday 7pm'"),
  start: z.string().nullable().describe("ISO 8601 local date-time if resolvable, else null"),
  end: z.string().nullable(),
});

export const TriageOutput = z.object({
  category: z.enum(CATEGORIES),
  priority: z.number().describe("0 (ignore) to 100 (drop everything)"),
  summary: z.string().describe("One line, max ~20 words"),
  reasoning: z.string().describe("One or two sentences explaining the category"),
  urgent: z.boolean(),
  deadline: z.string().nullable().describe("ISO date-time of any deadline mentioned, else null"),
  scheduling: z.object({
    detected: z.boolean(),
    kind: z.enum(["proposed_times", "availability_request", "invitation", "none"]),
    proposed_times: z.array(TimeSpan),
    requested_range: z.object({ from: z.string(), to: z.string() }).nullable()
      .describe("For 'which days are you free in the week of…' requests: local dates YYYY-MM-DD, else null"),
    duration_minutes: z.number().nullable(),
  }),
  flags: z.array(z.string()).describe("e.g. possible_prompt_injection, asks_for_money, requests_sensitive_info"),
});
export type TriageOutput = z.infer<typeof TriageOutput>;

export const DraftOutput = z.object({
  draft_body: z.string().describe("Reply body only, WITHOUT signature or sign-off name"),
  subject: z.string().nullable().describe("New subject only if it should change, else null"),
  open_questions: z.array(z.string()),
  detected_dates: z.array(TimeSpan.extend({ kind: z.enum(["proposed", "deadline", "mentioned"]) })),
  suggested_calendar_actions: z.array(z.object({
    title: z.string(), start: z.string(), end: z.string().nullable(),
    kind: z.enum(["concert", "rehearsal", "meeting", "lesson", "other"]), note: z.string().nullable(),
  })),
  confidence: z.enum(["low", "medium", "high"]),
  profile_update_proposal: z.object({
    needed: z.boolean(),
    notes: z.array(z.string()).describe("New facts, commitments or topic status changes learned from this exchange"),
  }),
  flags: z.array(z.string()),
});
export type DraftOutput = z.infer<typeof DraftOutput>;

export const ProfileOutput = z.object({
  display_name: z.string(),
  organization: z.string().nullable(),
  role: z.string().nullable(),
  relationship: z.string().nullable().describe("conductor, publisher, parent of a student, committee member, friend, vendor…"),
  formality: z.enum(["formal", "neutral", "casual"]).nullable(),
  tone: z.string().nullable(),
  language: z.enum(["en", "fr"]).nullable(),
  summary: z.string().describe("Rewritten profile, 150-300 words, no sensitive data"),
  topics: z.array(z.object({ topic: z.string(), status: z.enum(["open", "waiting_on_them", "waiting_on_me", "done"]) })),
  commitments: z.array(z.object({ who: z.enum(["matthew", "them"]), what: z.string(), due: z.string().nullable() })),
  facts: z.array(z.string()),
  do_not_mention: z.array(z.string()),
  response_expectations: z.string().nullable(),
});
export type ProfileOutput = z.infer<typeof ProfileOutput>;

export const StyleLearningOutput = z.object({
  patterns: z.array(z.object({ pattern: z.string(), evidence_count: z.number() })),
  summary: z.string(),
  proposed_style_guide: z.string().describe("The full style guide with the suggested edits applied"),
});
export type StyleLearningOutput = z.infer<typeof StyleLearningOutput>;
