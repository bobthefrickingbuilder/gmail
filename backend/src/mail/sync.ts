/**
 * GMAIL SYNC
 * ----------
 * First run: fetch recent inbox mail (last 14 days, up to 200 messages) and
 * remember Gmail's "historyId" bookmark. Every poll after that: ask Gmail
 * "what was added since bookmark X?" — cheap and incremental. If the
 * bookmark is too old (Gmail keeps about a week), fall back to a full sync.
 */
import { getDb, now, j, pj } from "../db/index.js";
import { mailFor } from "../providers/index.js";
import { HistoryExpiredError, type MailProvider, type SendAs } from "../providers/mail/types.js";
import { parseGmailMessage } from "./parse.js";
import { storeMessage } from "./store.js";
import { extractText, isExtractable, MAX_ATTACHMENT_BYTES } from "./attachments.js";
import type { AccountsTable } from "../db/schema.js";
import { log } from "../log.js";

export const FULL_SYNC_QUERY = "newer_than:14d -in:chats";
export const FULL_SYNC_MAX = 200;

export function myAddresses(acc: Pick<AccountsTable, "email" | "send_as_json">): string[] {
  return [acc.email, ...pj<SendAs[]>(acc.send_as_json, []).map((s) => s.email)].map((e) => e.toLowerCase());
}

async function fetchAndStore(acc: AccountsTable, mail: MailProvider, ids: string[]) {
  const stored: { messageId: string; threadId: string }[] = [];
  const mine = myAddresses(acc);
  const db = await getDb();
  for (const id of ids) {
    const exists = await db.selectFrom("messages").select("id").where("account_id", "=", acc.id).where("provider_message_id", "=", id).executeTakeFirst();
    if (exists) continue;
    let raw;
    try { raw = await mail.getMessage(id); } catch (e) {
      if ((e as { response?: { status?: number } }).response?.status === 404) continue; // deleted meanwhile
      throw e;
    }
    if (raw.labelIds?.includes("DRAFT")) continue; // our own drafts show up in history; ignore
    const parsed = parseGmailMessage(raw);
    for (const a of parsed.attachments) {
      if (a.attachmentId && isExtractable(a) && a.size <= MAX_ATTACHMENT_BYTES) {
        try { a.text = await extractText(a, await mail.getAttachment(id, a.attachmentId)); } catch { a.text = null; }
      }
    }
    const r = await storeMessage(acc.id, parsed, mine);
    if (r.isNew) stored.push(r);
  }
  return stored;
}

export async function refreshSendAs(acc: AccountsTable, mail: MailProvider) {
  const sendAs = await mail.getSendAs();
  const db = await getDb();
  await db.updateTable("accounts").set({ send_as_json: j(sendAs) }).where("id", "=", acc.id).execute();
  return sendAs;
}

/** Returns newly stored messages (oldest first) for triage. */
export async function syncAccount(acc: AccountsTable): Promise<{ messageId: string; threadId: string }[]> {
  const mail = mailFor(acc);
  const db = await getDb();
  if (pj<SendAs[]>(acc.send_as_json, []).length === 0) {
    const sa = await refreshSendAs(acc, mail);
    acc = { ...acc, send_as_json: j(sa) };
  }
  let ids: string[]; let historyId: string; let mode: "incremental" | "full" = "incremental";
  try {
    if (!acc.history_id) throw new HistoryExpiredError();
    ({ messageIds: ids, historyId } = await mail.listHistory(acc.history_id));
  } catch (e) {
    if (!(e instanceof HistoryExpiredError)) throw e;
    mode = "full";
    const profile = await mail.getProfile();
    historyId = profile.historyId;
    ids = [];
    let pageToken: string | undefined;
    do {
      const page = await mail.listMessageIds(FULL_SYNC_QUERY, 100, pageToken);
      ids.push(...page.ids); pageToken = page.nextPageToken;
    } while (pageToken && ids.length < FULL_SYNC_MAX);
    ids = ids.slice(0, FULL_SYNC_MAX).reverse();
  }
  const stored = await fetchAndStore(acc, mail, ids);
  await db.updateTable("accounts").set({ history_id: historyId, last_sync_at: now(), last_error: null, status: "ok" })
    .where("id", "=", acc.id).execute();
  log.info({ account: acc.id, mode, fetched: ids.length, stored: stored.length }, "sync complete");
  return stored;
}
