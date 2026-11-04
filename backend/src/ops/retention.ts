/**
 * DATA RETENTION
 * After N days (Settings → Data retention), stored email bodies and
 * attachment text are deleted from the database. Metadata (who, when,
 * subject), triage results, drafts you wrote and profiles are kept, and the
 * cleaned text of YOUR OWN sent replies is kept (used as examples of your voice).
 * The mail itself always stays in Gmail.
 */
import { getDb, now, pj, j } from "../db/index.js";
import { getSettings } from "../settings.js";
import { audit } from "../audit.js";

export async function purgeOldBodies(days?: number) {
  const db = await getDb();
  const keep = days ?? (await getSettings()).retention_days;
  if (!keep || keep <= 0) return 0;
  const cutoff = new Date(Date.now() - keep * 86400_000).toISOString();
  const rows = await db.selectFrom("messages").select(["id", "attachments_json", "is_from_me"]).where("date", "<", cutoff).where("body_purged_at", "is", null).execute();
  for (const r of rows) {
    const atts = pj<Record<string, unknown>[]>(r.attachments_json, []).map((a) => ({ ...a, text: null }));
    await db.updateTable("messages").set({ body_text: null, body_html: null, // your own replies keep their cleaned text: they are your words and serve as voice examples
      stripped_text: r.is_from_me ? undefined : null, snippet: null, attachments_json: j(atts), body_purged_at: now() })
      .where("id", "=", r.id).execute();
  }
  await db.deleteFrom("send_confirmations").where("expires_at", "<", new Date(Date.now() - 86400_000).toISOString()).execute();
  // Chats quote email text, so a chat untouched for the same N days is deleted too.
  const oldChats = db.selectFrom("chat_conversations").select("id").where("updated_at", "<", cutoff);
  await db.deleteFrom("chat_actions").where("conversation_id", "in", oldChats).execute();
  await db.deleteFrom("chat_messages").where("conversation_id", "in", oldChats).execute();
  const chats = await db.deleteFrom("chat_conversations").where("updated_at", "<", cutoff).executeTakeFirst();
  if (rows.length || Number(chats.numDeletedRows)) await audit("system", "retention.purge", null, null, { messages: rows.length, chats: Number(chats.numDeletedRows), days: keep });
  return rows.length;
}
