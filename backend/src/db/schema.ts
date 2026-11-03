/**
 * DATABASE SCHEMA (TypeScript view)
 * ---------------------------------
 * These interfaces describe each table so the compiler can check every query.
 * Conventions that keep SQLite and Postgres interchangeable:
 *   - ids are text UUIDs
 *   - timestamps are ISO-8601 text ("2026-11-01T14:03:00.000Z")
 *   - booleans are integers 0/1
 *   - JSON is stored as text in columns ending in _json
 * See docs/DATA-MODEL.md for the plain-language description.
 */
export interface AccountsTable {
  id: string;
  email: string;
  provider: string; // google | mock
  display_name: string | null;
  enabled: number;
  tokens_enc: string | null;
  history_id: string | null;
  send_as_json: string; // [{email, displayName, signature, isDefault}]
  status: string; // ok | reauth_required | disconnected
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface ThreadsTable {
  id: string;
  account_id: string;
  provider_thread_id: string;
  subject: string;
  last_message_at: string;
  state: string; // open | done | snoozed | skipped
  snooze_until: string | null;
  category: string | null;
  priority: number | null;
  summary: string | null;
  urgent: number;
  scheduling: number;
  draft_status: string; // none | drafted:haiku | drafted:sonnet | drafted:opus
  person_id: string | null;
  last_drafted_message_id: string | null;
  needs_attention: number;
  created_at: string;
  updated_at: string;
}

export interface MessagesTable {
  id: string;
  account_id: string;
  thread_id: string;
  provider_message_id: string;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references_hdr: string | null;
  from_email: string;
  from_name: string | null;
  reply_to: string | null;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  date: string;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  stripped_text: string | null;
  attachments_json: string;
  labels_json: string;
  headers_json: string; // selected headers only
  list_unsubscribe: number;
  is_from_me: number;
  body_purged_at: string | null;
  created_at: string;
}

export interface TriageTable {
  id: string;
  message_id: string;
  thread_id: string;
  stage: string; // rules | model
  category: string;
  priority: number;
  summary: string;
  reasoning: string;
  urgent: number;
  scheduling_json: string; // detected scheduling intent
  flags_json: string;
  model_key: string | null;
  corrected_category: string | null;
  created_at: string;
}

export interface TriageCorrectionsTable {
  id: string;
  message_id: string;
  from_category: string;
  to_category: string;
  from_email: string;
  subject: string;
  summary: string;
  created_at: string;
}

export interface DraftsTable {
  id: string;
  thread_id: string;
  account_id: string;
  reply_to_message_id: string;
  provider_draft_id: string | null;
  current_version_id: string | null;
  status: string; // active | saved | sent | discarded
  reply_mode: string; // reply | reply_all
  to_json: string;
  cc_json: string;
  from_email: string;
  signature_key: string | null;
  share_schedule_details: number;
  original_version_id: string | null; // first model version, for learning
  final_body: string | null; // what was saved/sent, for learning
  edit_class: string | null; // unedited | edited | discarded
  created_at: string;
  updated_at: string;
}

export interface DraftVersionsTable {
  id: string;
  draft_id: string;
  version: number;
  origin: string; // model | user
  model_key: string | null;
  model_id: string | null;
  body: string;
  subject: string;
  open_questions_json: string;
  detected_dates_json: string;
  calendar_actions_json: string;
  confidence: string | null;
  flags_json: string;
  instruction: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  created_at: string;
}

export interface PeopleTable {
  id: string;
  display_name: string;
  organization: string | null;
  role: string | null;
  relationship: string | null;
  formality: string | null;
  tone: string | null;
  language: string | null;
  summary: string;
  data_json: string; // {topics:[], commitments:[], facts:[], do_not_mention:[], response_expectations}
  notes_to_assistant: string;
  vip: number;
  escalate_model: string | null;
  signature_key: string | null;
  last_contact_at: string | null;
  auto_apply_updates: number | null; // null = use global setting
  created_at: string;
  updated_at: string;
}

export interface PersonAddressesTable {
  email: string;
  person_id: string;
}

export interface ProfileVersionsTable {
  id: string;
  person_id: string;
  version: number;
  snapshot_json: string;
  source: string; // model | user | seed | merge | revert
  status: string; // applied | proposed | rejected | superseded
  note: string | null;
  created_at: string;
}

export interface PinnedDocsTable {
  id: string;
  person_id: string;
  title: string;
  content: string;
  created_at: string;
}

export interface SenderRulesTable {
  id: string;
  match: string;
  action: string; // skip | vip | escalate | category
  value: string | null;
  created_at: string;
}

export interface UsageTable {
  id: string;
  ts: string;
  purpose: string;
  model_key: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  thread_id: string | null;
  draft_id: string | null;
}

export interface SettingsTable {
  key: string;
  value_json: string;
  updated_at: string;
}

export interface AuditLogTable {
  id: string;
  ts: string;
  actor: string; // user | worker | system
  action: string;
  target_type: string | null;
  target_id: string | null;
  meta_json: string;
}

export interface DeadLettersTable {
  id: string;
  kind: string;
  ref_id: string | null;
  error: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface JobsTable {
  id: string;
  kind: string;
  status: string; // pending | running | paused | done | failed
  cursor: string | null;
  progress_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface StyleProposalsTable {
  id: string;
  summary: string;
  proposed_text: string;
  status: string; // pending | accepted | rejected
  created_at: string;
}

export interface AuthUserTable {
  id: string;
  password_hash: string | null;
  totp_secret_enc: string | null;
  totp_enabled: number;
  created_at: string;
}

export interface WebauthnCredentialsTable {
  id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  label: string | null;
  created_at: string;
}

export interface SessionsTable {
  id: string;
  refresh_hash: string;
  expires_at: string;
  device: string | null;
  created_at: string;
  last_used_at: string;
  revoked_at: string | null;
}

export interface PushSubscriptionsTable {
  id: string;
  kind: string; // webpush | fcm
  endpoint: string;
  keys_json: string;
  created_at: string;
}

export interface SendConfirmationsTable {
  id: string;
  draft_id: string;
  version_id: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface ComposeDraftsTable {
  id: string;
  account_id: string;
  from_email: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  body: string;
  provider_draft_id: string | null;
  status: string; // open | saved | sent | discarded
  created_at: string;
  updated_at: string;
}

export interface ContactsTable {
  id: string;
  account_id: string;
  email: string;
  name: string | null;
  source: string; // google (saved contact) | other (Gmail "other contacts") | mail (seen in synced mail)
  times_contacted: number;
  last_contacted_at: string | null;
  updated_at: string;
}

export interface ProjectsTable {
  id: string;
  name: string;
  color: string; // a palette name (teal, blue, violet, pink, orange, amber, green, slate)
  notes: string;
  position: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface TasksTable {
  id: string;
  project_id: string | null; // null = no project ("Inbox")
  parent_id: string | null; // set = a subtask (steps can nest)
  title: string;
  notes: string;
  status: string; // open | done
  priority: number; // 0 none, 1 low, 2 medium, 3 high
  due_date: string | null; // YYYY-MM-DD
  position: number;
  thread_id: string | null; // the email this task came from
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ThreadAnalysisTable {
  id: string; // = thread id
  message_id: string; // the latest incoming message that was analysed; a newer one triggers a fresh analysis
  items_json: string; // AnalysisItem[] (see analysis/service.ts), including which ones you added
  model: string | null; // null when nothing was sent to the AI (e.g. a calendar invitation)
  created_at: string;
}

export interface DB {
  accounts: AccountsTable;
  threads: ThreadsTable;
  messages: MessagesTable;
  triage: TriageTable;
  triage_corrections: TriageCorrectionsTable;
  drafts: DraftsTable;
  draft_versions: DraftVersionsTable;
  people: PeopleTable;
  person_addresses: PersonAddressesTable;
  profile_versions: ProfileVersionsTable;
  pinned_docs: PinnedDocsTable;
  sender_rules: SenderRulesTable;
  usage: UsageTable;
  settings: SettingsTable;
  audit_log: AuditLogTable;
  dead_letters: DeadLettersTable;
  jobs: JobsTable;
  style_proposals: StyleProposalsTable;
  auth_user: AuthUserTable;
  webauthn_credentials: WebauthnCredentialsTable;
  sessions: SessionsTable;
  push_subscriptions: PushSubscriptionsTable;
  send_confirmations: SendConfirmationsTable;
  compose_drafts: ComposeDraftsTable;
  contacts: ContactsTable;
  projects: ProjectsTable;
  tasks: TasksTable;
  thread_analysis: ThreadAnalysisTable;
}
