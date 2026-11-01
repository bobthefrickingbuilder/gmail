/**
 * MIGRATIONS — creates and evolves the tables.
 * Each migration runs once; Kysely records which ones ran in `kysely_migration`.
 * Add new migrations at the end with a new key; never edit an old one after release.
 */
import { Kysely, sql, CreateTableBuilder } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";

type T = CreateTableBuilder<any, any>;
const id = (t: T) => t.addColumn("id", "text", (c) => c.primaryKey());
const txt = (t: T, name: string, notNull = true, def?: string) =>
  t.addColumn(name, "text", (c) => {
    let col = notNull ? c.notNull() : c;
    if (def !== undefined) col = col.defaultTo(def);
    return col;
  });
const int = (t: T, name: string, def = 0) => t.addColumn(name, "integer", (c) => c.notNull().defaultTo(def));
const intNull = (t: T, name: string) => t.addColumn(name, "integer");
const real = (t: T, name: string) => t.addColumn(name, "real", (c) => c.notNull().defaultTo(0));

function chain(t: T, ...fns: ((t: T) => T)[]): T {
  return fns.reduce((acc, f) => f(acc), t);
}

const m001: Migration = {
  async up(db: Kysely<any>) {
    await chain(db.schema.createTable("accounts"), id,
      (t) => txt(t, "email"), (t) => txt(t, "provider"), (t) => txt(t, "display_name", false),
      (t) => int(t, "enabled", 1), (t) => txt(t, "tokens_enc", false), (t) => txt(t, "history_id", false),
      (t) => txt(t, "send_as_json", true, "[]"), (t) => txt(t, "status", true, "ok"),
      (t) => txt(t, "last_sync_at", false), (t) => txt(t, "last_error", false), (t) => txt(t, "created_at")).execute();

    await chain(db.schema.createTable("threads"), id,
      (t) => txt(t, "account_id"), (t) => txt(t, "provider_thread_id"), (t) => txt(t, "subject", true, ""),
      (t) => txt(t, "last_message_at"), (t) => txt(t, "state", true, "open"), (t) => txt(t, "snooze_until", false),
      (t) => txt(t, "category", false), (t) => intNull(t, "priority"), (t) => txt(t, "summary", false),
      (t) => int(t, "urgent"), (t) => int(t, "scheduling"), (t) => txt(t, "draft_status", true, "none"),
      (t) => txt(t, "person_id", false), (t) => txt(t, "last_drafted_message_id", false),
      (t) => int(t, "needs_attention"), (t) => txt(t, "created_at"), (t) => txt(t, "updated_at")).execute();
    await db.schema.createIndex("threads_provider_uq").on("threads").columns(["account_id", "provider_thread_id"]).unique().execute();
    await db.schema.createIndex("threads_last_idx").on("threads").column("last_message_at").execute();

    await chain(db.schema.createTable("messages"), id,
      (t) => txt(t, "account_id"), (t) => txt(t, "thread_id"), (t) => txt(t, "provider_message_id"),
      (t) => txt(t, "rfc_message_id", false), (t) => txt(t, "in_reply_to", false), (t) => txt(t, "references_hdr", false),
      (t) => txt(t, "from_email"), (t) => txt(t, "from_name", false), (t) => txt(t, "reply_to", false),
      (t) => txt(t, "to_json", true, "[]"), (t) => txt(t, "cc_json", true, "[]"), (t) => txt(t, "bcc_json", true, "[]"),
      (t) => txt(t, "subject", true, ""), (t) => txt(t, "date"), (t) => txt(t, "snippet", false),
      (t) => txt(t, "body_text", false), (t) => txt(t, "body_html", false), (t) => txt(t, "stripped_text", false),
      (t) => txt(t, "attachments_json", true, "[]"), (t) => txt(t, "labels_json", true, "[]"),
      (t) => txt(t, "headers_json", true, "{}"), (t) => int(t, "list_unsubscribe"), (t) => int(t, "is_from_me"),
      (t) => txt(t, "body_purged_at", false), (t) => txt(t, "created_at")).execute();
    await db.schema.createIndex("messages_provider_uq").on("messages").columns(["account_id", "provider_message_id"]).unique().execute();
    await db.schema.createIndex("messages_thread_idx").on("messages").columns(["thread_id", "date"]).execute();
    await db.schema.createIndex("messages_from_idx").on("messages").column("from_email").execute();

    await chain(db.schema.createTable("triage"), id,
      (t) => txt(t, "message_id"), (t) => txt(t, "thread_id"), (t) => txt(t, "stage"), (t) => txt(t, "category"),
      (t) => int(t, "priority"), (t) => txt(t, "summary", true, ""), (t) => txt(t, "reasoning", true, ""),
      (t) => int(t, "urgent"), (t) => txt(t, "scheduling_json", true, "{}"), (t) => txt(t, "flags_json", true, "[]"),
      (t) => txt(t, "model_key", false), (t) => txt(t, "corrected_category", false), (t) => txt(t, "created_at")).execute();
    await db.schema.createIndex("triage_msg_idx").on("triage").column("message_id").execute();

    await chain(db.schema.createTable("triage_corrections"), id,
      (t) => txt(t, "message_id"), (t) => txt(t, "from_category"), (t) => txt(t, "to_category"),
      (t) => txt(t, "from_email"), (t) => txt(t, "subject"), (t) => txt(t, "summary"), (t) => txt(t, "created_at")).execute();

    await chain(db.schema.createTable("drafts"), id,
      (t) => txt(t, "thread_id"), (t) => txt(t, "account_id"), (t) => txt(t, "reply_to_message_id"),
      (t) => txt(t, "provider_draft_id", false), (t) => txt(t, "current_version_id", false),
      (t) => txt(t, "status", true, "active"), (t) => txt(t, "reply_mode", true, "reply"),
      (t) => txt(t, "to_json", true, "[]"), (t) => txt(t, "cc_json", true, "[]"), (t) => txt(t, "from_email"),
      (t) => txt(t, "signature_key", false), (t) => int(t, "share_schedule_details"),
      (t) => txt(t, "original_version_id", false), (t) => txt(t, "final_body", false), (t) => txt(t, "edit_class", false),
      (t) => txt(t, "created_at"), (t) => txt(t, "updated_at")).execute();
    await db.schema.createIndex("drafts_thread_idx").on("drafts").columns(["thread_id", "status"]).execute();

    await chain(db.schema.createTable("draft_versions"), id,
      (t) => txt(t, "draft_id"), (t) => int(t, "version"), (t) => txt(t, "origin"), (t) => txt(t, "model_key", false),
      (t) => txt(t, "model_id", false), (t) => txt(t, "body"), (t) => txt(t, "subject"),
      (t) => txt(t, "open_questions_json", true, "[]"), (t) => txt(t, "detected_dates_json", true, "[]"),
      (t) => txt(t, "calendar_actions_json", true, "[]"), (t) => txt(t, "confidence", false),
      (t) => txt(t, "flags_json", true, "[]"), (t) => txt(t, "instruction", false), (t) => int(t, "input_tokens"),
      (t) => int(t, "output_tokens"), (t) => real(t, "cost_usd"), (t) => txt(t, "created_at")).execute();
    await db.schema.createIndex("draft_versions_draft_idx").on("draft_versions").columns(["draft_id", "version"]).unique().execute();

    await chain(db.schema.createTable("people"), id,
      (t) => txt(t, "display_name"), (t) => txt(t, "organization", false), (t) => txt(t, "role", false),
      (t) => txt(t, "relationship", false), (t) => txt(t, "formality", false), (t) => txt(t, "tone", false),
      (t) => txt(t, "language", false), (t) => txt(t, "summary", true, ""), (t) => txt(t, "data_json", true, "{}"),
      (t) => txt(t, "notes_to_assistant", true, ""), (t) => int(t, "vip"), (t) => txt(t, "escalate_model", false),
      (t) => txt(t, "signature_key", false), (t) => txt(t, "last_contact_at", false), (t) => intNull(t, "auto_apply_updates"),
      (t) => txt(t, "created_at"), (t) => txt(t, "updated_at")).execute();

    await chain(db.schema.createTable("person_addresses"),
      (t) => t.addColumn("email", "text", (c) => c.primaryKey()), (t) => txt(t, "person_id")).execute();
    await db.schema.createIndex("person_addresses_person_idx").on("person_addresses").column("person_id").execute();

    await chain(db.schema.createTable("profile_versions"), id,
      (t) => txt(t, "person_id"), (t) => int(t, "version"), (t) => txt(t, "snapshot_json"), (t) => txt(t, "source"),
      (t) => txt(t, "status"), (t) => txt(t, "note", false), (t) => txt(t, "created_at")).execute();
    await db.schema.createIndex("profile_versions_person_idx").on("profile_versions").columns(["person_id", "version"]).execute();

    await chain(db.schema.createTable("pinned_docs"), id,
      (t) => txt(t, "person_id"), (t) => txt(t, "title"), (t) => txt(t, "content"), (t) => txt(t, "created_at")).execute();

    await chain(db.schema.createTable("sender_rules"), id,
      (t) => txt(t, "match"), (t) => txt(t, "action"), (t) => txt(t, "value", false), (t) => txt(t, "created_at")).execute();

    await chain(db.schema.createTable("usage"), id,
      (t) => txt(t, "ts"), (t) => txt(t, "purpose"), (t) => txt(t, "model_key"), (t) => txt(t, "model_id"),
      (t) => int(t, "input_tokens"), (t) => int(t, "output_tokens"), (t) => real(t, "cost_usd"),
      (t) => txt(t, "thread_id", false), (t) => txt(t, "draft_id", false)).execute();
    await db.schema.createIndex("usage_ts_idx").on("usage").column("ts").execute();

    await chain(db.schema.createTable("settings"),
      (t) => t.addColumn("key", "text", (c) => c.primaryKey()), (t) => txt(t, "value_json"), (t) => txt(t, "updated_at")).execute();

    await chain(db.schema.createTable("audit_log"), id,
      (t) => txt(t, "ts"), (t) => txt(t, "actor"), (t) => txt(t, "action"), (t) => txt(t, "target_type", false),
      (t) => txt(t, "target_id", false), (t) => txt(t, "meta_json", true, "{}")).execute();
    await db.schema.createIndex("audit_ts_idx").on("audit_log").column("ts").execute();

    await chain(db.schema.createTable("dead_letters"), id,
      (t) => txt(t, "kind"), (t) => txt(t, "ref_id", false), (t) => txt(t, "error"), (t) => int(t, "attempts", 1),
      (t) => txt(t, "created_at"), (t) => txt(t, "updated_at"), (t) => txt(t, "resolved_at", false)).execute();

    await chain(db.schema.createTable("jobs"), id,
      (t) => txt(t, "kind"), (t) => txt(t, "status"), (t) => txt(t, "cursor", false), (t) => txt(t, "progress_json", true, "{}"),
      (t) => txt(t, "error", false), (t) => txt(t, "created_at"), (t) => txt(t, "updated_at")).execute();

    await chain(db.schema.createTable("style_proposals"), id,
      (t) => txt(t, "summary"), (t) => txt(t, "proposed_text"), (t) => txt(t, "status", true, "pending"), (t) => txt(t, "created_at")).execute();

    await chain(db.schema.createTable("auth_user"), id,
      (t) => txt(t, "password_hash", false), (t) => txt(t, "totp_secret_enc", false), (t) => int(t, "totp_enabled"), (t) => txt(t, "created_at")).execute();

    await chain(db.schema.createTable("webauthn_credentials"), id,
      (t) => txt(t, "credential_id"), (t) => txt(t, "public_key"), (t) => int(t, "counter"), (t) => txt(t, "transports", false),
      (t) => txt(t, "label", false), (t) => txt(t, "created_at")).execute();

    await chain(db.schema.createTable("sessions"), id,
      (t) => txt(t, "refresh_hash"), (t) => txt(t, "expires_at"), (t) => txt(t, "device", false), (t) => txt(t, "created_at"),
      (t) => txt(t, "last_used_at"), (t) => txt(t, "revoked_at", false)).execute();
    await db.schema.createIndex("sessions_refresh_idx").on("sessions").column("refresh_hash").execute();

    await chain(db.schema.createTable("push_subscriptions"), id,
      (t) => txt(t, "kind"), (t) => txt(t, "endpoint"), (t) => txt(t, "keys_json", true, "{}"), (t) => txt(t, "created_at")).execute();

    await chain(db.schema.createTable("send_confirmations"), id,
      (t) => txt(t, "draft_id"), (t) => txt(t, "version_id"), (t) => txt(t, "token_hash"), (t) => txt(t, "expires_at"),
      (t) => txt(t, "used_at", false), (t) => txt(t, "created_at")).execute();
  },
  async down(db: Kysely<any>) {
    for (const t of ["send_confirmations", "push_subscriptions", "sessions", "webauthn_credentials", "auth_user",
      "style_proposals", "jobs", "dead_letters", "audit_log", "settings", "usage", "sender_rules", "pinned_docs",
      "profile_versions", "person_addresses", "people", "draft_versions", "drafts", "triage_corrections", "triage",
      "messages", "threads", "accounts"]) await db.schema.dropTable(t).ifExists().execute();
  },
};

export const migrations: Record<string, Migration> = { "001_initial": m001 };

export class StaticMigrationProvider implements MigrationProvider {
  async getMigrations() { return migrations; }
}
export { sql };
