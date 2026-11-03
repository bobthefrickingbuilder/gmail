/** Shapes of the data the backend returns (kept in sync with backend routes). */
export interface Address { name: string | null; email: string }
export interface ThreadRow {
  id: string; subject: string; last_message_at: string; state: string; category: string | null; priority: number | null; summary: string | null;
  urgent: boolean; scheduling: boolean; draft_status: string; needs_attention: boolean; person_id: string | null; person_name: string | null; person_vip: boolean;
  draft_id: string | null; draft_state: string | null; confidence: string | null; flags: string[]; open_questions: number; unread: boolean;
  latest: { from_name: string | null; from_email: string; snippet: string | null; date: string; is_from_me: number } | null;
}
export interface Message {
  id: string; from_name: string | null; from_email: string; to: Address[]; cc: Address[]; subject: string; date: string; is_from_me: boolean;
  body_text: string | null; new_text: string | null; purged: boolean; labels: string[];
  attachments: { index: number; filename: string; mimeType: string; size: number; inline: boolean; preview: string | null }[];
  invite: { summary: string | null; start: string | null; end: string | null; location: string | null } | null;
}
export interface Version {
  id: string; version: number; origin: string; model_key: string | null; model_id: string | null; body: string; subject: string; confidence: string | null;
  open_questions: string[]; detected_dates: { text: string; start: string | null; kind: string }[];
  calendar_actions: { title: string; start: string; end: string | null; kind: string; note: string | null }[]; flags: string[]; instruction: string | null;
  input_tokens: number; output_tokens: number; cost_usd: number; created_at: string;
}
export interface Slot { start: string; end: string; label: string }
export interface ButtonState { primary: { action: string; model: string; label: string }; toggle: { model: string; label: string } | null; secondary: { action: string; model: string; label: string } | null }
export interface ThreadDetail {
  thread: { id: string; provider_thread_id: string; subject: string; state: string; category: string | null; priority: number | null; summary: string | null; urgent: boolean; scheduling: boolean; draft_status: string; person_id: string | null; unread: boolean };
  messages: Message[];
  triage: { category: string; corrected_category: string | null; priority: number; summary: string; reasoning: string; stage: string; urgent: boolean; flags: string[] } | null;
  draft: { id: string; status: string; reply_mode: "reply" | "reply_all"; to: Address[]; cc: Address[]; from_email: string; signature_key: string | null; current_version_id: string; provider_draft_id: string | null; share_schedule_details: boolean } | null;
  versions: Version[];
  buttons: ButtonState;
  scheduling: { kind: string; durationMinutes: number; timezone: string; suggestions: Slot[]; proposed: { text: string; start: string | null; end: string | null; status: string }[] } | null;
  person: { id: string; display_name: string; organization: string | null; relationship: string | null; vip: number; language: string | null; summary: string } | null;
  signatures: { key: string; label: string }[];
  categories: string[];
}
export interface ComposeDraft {
  id: string; from_email: string; to: Address[]; cc: Address[]; bcc: Address[]; subject: string; body: string; status: string; saved: boolean;
  provider_draft_id: string | null; created_at: string; updated_at: string;
}
export interface Project { id: string; name: string; color: string; notes: string; position: number; archived: boolean; created_at: string }
export interface Task {
  id: string; project_id: string | null; parent_id: string | null; title: string; notes: string; status: "open" | "done"; priority: number;
  due_date: string | null; position: number; thread_id: string | null; created_at: string; updated_at: string; completed_at: string | null;
}
export interface EventCandidate {
  key: string; title: string; start: string; end: string | null; allDay: boolean; location: string | null; kind: string; confidence: string;
  evidence: string; source: "invite" | "claude"; threadId: string; subject: string; from: string; alreadyOnCalendar: boolean;
}

/** A to-do or calendar suggestion found in an email (backend analysis/service.ts). */
export type AnalysisItem =
  | { key: string; type: "todo"; title: string; due_date: string | null; notes: string | null; evidence: string; added: string | null; dismissed?: boolean }
  | { key: string; type: "event"; title: string; start: string; end: string | null; allDay: boolean; location: string | null; kind: string;
      evidence: string; source: "invite" | "ai"; added: string | null; dismissed?: boolean; alreadyOnCalendar: boolean };
