# Data model

Plain language: every table below lives in one database (a SQLite file by
default). Migrations in `backend/src/db/migrations.ts` create them. JSON columns
are stored as text so the same schema works in SQLite and Postgres.

| Table | What it holds | Key columns |
|---|---|---|
| `accounts` | Each connected mailbox (one enabled in v1) | `email`, `provider` (`google`/`mock`), `tokens_enc` (encrypted refresh token), `history_id`, `send_as_json` (aliases + signatures), `status` (`ok`/`reauth_required`) |
| `threads` | One row per conversation | `provider_thread_id`, `subject`, `last_message_at`, `state` (`open`/`done`/`snoozed`/`skipped`), `snooze_until`, `category`, `priority`, `summary`, `urgent`, `draft_status` (`none`/`drafted:haiku`/...), `person_id` |
| `messages` | Every message, full thread kept | `provider_message_id` (unique per account), `rfc_message_id`, `in_reply_to`, `references_hdr`, `from_email`, `from_name`, `reply_to`, `to_json`, `cc_json`, `subject`, `date`, `body_text`, `body_html`, `stripped_text`, `attachments_json`, `labels_json`, `list_unsubscribe`, `is_from_me`, `body_purged_at` |
| `triage` | Classification per message | `stage` (`rules`/`model`), `category`, `priority`, `summary`, `reasoning`, `urgent`, `flags_json`, `corrected_category` |
| `triage_corrections` | Your one-tap fixes, reused as few-shot examples | `from_category`, `to_category`, `from_email`, `subject`, `summary` |
| `drafts` | One active draft per thread | `thread_id`, `reply_to_message_id`, `provider_draft_id`, `current_version_id`, `status` (`active`/`saved`/`sent`/`discarded`), `reply_mode`, `to_json`, `cc_json`, `signature_key`, `share_schedule_details` |
| `draft_versions` | Every draft version (model or your edit) | `version`, `origin` (`model`/`user`), `model_key`, `model_id`, `body`, `subject`, `open_questions_json`, `detected_dates_json`, `calendar_actions_json`, `confidence`, `flags_json`, `instruction`, tokens, `cost_usd` |
| `people` | Correspondent profiles | `display_name`, `organization`, `role`, `relationship`, `formality`, `tone`, `language`, `summary` (≤300 words), `data_json` (topics, commitments, facts, do-not-mention), `notes_to_assistant` (never model-written), `vip`, `escalate_model`, `signature_key`, `last_contact_at` |
| `person_addresses` | Many addresses → one person | `email` (normalized, unique), `person_id` |
| `profile_versions` | History of every profile change | `person_id`, `version`, `snapshot_json`, `source` (`model`/`user`/`seed`/`merge`), `status` (`applied`/`proposed`/`rejected`/`reverted`) |
| `pinned_docs` | Per-person context documents | `person_id`, `title`, `content` |
| `sender_rules` | Your skip/VIP/escalate rules | `match` (address, `@domain`, or label), `action` (`skip`/`vip`/`escalate`/`category`), `value` |
| `usage` | Every model call | `purpose` (`triage`/`draft`/`profile`/`seed`/`learn`/`eval`/`task`/`chat`), `model_key`, tokens, `cost_usd`, `thread_id` |
| `settings` | Key/value app settings | `key`, `value_json` |
| `audit_log` | Every action, no email content | `actor`, `action`, `target_type`, `target_id`, `meta_json` |
| `dead_letters` | Failures needing attention | `kind`, `ref_id`, `error`, `attempts`, `resolved_at` |
| `jobs` | Resumable background jobs (seed import, learning) | `kind`, `status`, `cursor`, `progress_json` |
| `style_proposals` | Suggested style-guide changes from edit learning | `summary`, `proposed_text`, `status` |
| `auth_user` | The single login | `password_hash`, `totp_secret_enc`, `totp_enabled` |
| `webauthn_credentials` | Passkeys | `credential_id`, `public_key`, `counter`, `transports` |
| `sessions` | App sessions | `refresh_hash`, `expires_at`, `device`, `last_used_at` |
| `push_subscriptions` | Web Push / FCM endpoints | `kind`, `endpoint`, `keys_json` |
| `send_confirmations` | One-time send tokens (2-minute life) | `draft_id`, `token_hash`, `version_id`, `expires_at`, `used_at` |
| `compose_drafts` | New emails you start yourself (not replies) | `from_email`, `to_json`, `cc_json`, `bcc_json`, `subject`, `body`, `provider_draft_id`, `status` |
| `contacts` | Addresses for To: autocomplete (Google contacts + your mail) | `email`, `name`, `source`, `times_contacted`, `last_contacted_at` |
| `projects` | To-do projects | `name`, `color`, `notes`, `position`, `archived` |
| `tasks` | To-do tasks; `parent_id` makes a task a step of another | `project_id`, `parent_id`, `title`, `status`, `priority`, `due_date`, `thread_id`, `completed_at` |
| `thread_analysis` | To-do / calendar suggestions found in an email (one row per thread) | `message_id` (the message analysed), `items_json` (suggestions and which you added or hid), `model` |
| `chat_conversations` | Chats with Claude (Chat tab) | `title`, `model_key`, `context_thread_id` (chat started from an email), `tainted` (1 once suspicious email text was seen: every change then asks first) |
| `chat_messages` | Each chat message in order, append-only | `conversation_id`, `seq`, `role`, `content_json` (exactly what was sent to / received from the model), `ui_json` (what the screen shows) |
| `chat_actions` | Changes the chat proposed that wait for your Confirm tap | `tool`, `input_json` (runs exactly this on Confirm), `summary`, `status` (`pending`/`done`/`cancelled`/`failed`), `reported` |
| `draft_attachments` | Files you attach to a reply draft or a new email, kept until it is sent or discarded | `owner_kind` (`reply`/`compose`), `owner_id`, `filename`, `mime_type`, `size`, `sha256`, `data_b64` |

Chats quote email text, so they follow the retention setting (a chat untouched for N days is deleted), are included in **Export**, and are deleted by **Wipe**.

**Idempotency:** `messages` has a unique index on `(account_id, provider_message_id)`;
drafting checks `drafts` for an active draft on the thread and *updates* it
rather than creating a second one; `threads.last_drafted_message_id` stops the
worker drafting the same incoming message twice.

**Deleting a person** deletes their addresses, versions, pinned docs, and clears
`person_id` on their threads (the mail itself stays in Gmail).
