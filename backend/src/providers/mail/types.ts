/**
 * MAIL PROVIDER INTERFACE
 * The rest of the app talks to "a mailbox" through this interface, so Gmail
 * can later be joined by other providers without rewriting the app.
 * NOTE: `sendDraft` exists here but is only ever called from the explicit,
 * confirmed Send route (routes/drafts.ts). The worker never calls it.
 */
import type { GmailMessage } from "../../mail/types.js";

export class HistoryExpiredError extends Error { constructor() { super("history id expired"); } }
export class AuthExpiredError extends Error { constructor(msg = "Google authorization expired or was revoked") { super(msg); } }

export interface SendAs { email: string; displayName: string | null; signature: string | null; isDefault: boolean; isPrimary: boolean }

export interface MailProvider {
  readonly kind: string;
  getProfile(): Promise<{ email: string; historyId: string }>;
  /** Message IDs added since `startHistoryId`, plus the current labels of messages whose
   *  labels changed (e.g. read/unread in Gmail). Throws HistoryExpiredError if too old. */
  listHistory(startHistoryId: string): Promise<{ messageIds: string[]; historyId: string; labelChanges: { messageId: string; labelIds: string[] }[] }>;
  listMessageIds(query: string, maxResults: number, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }>;
  getMessage(id: string): Promise<GmailMessage>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  getSendAs(): Promise<SendAs[]>;
  /** Create missing labels; returns name → id. */
  ensureLabels(names: string[]): Promise<Record<string, string>>;
  modifyThreadLabels(threadId: string, add: string[], remove: string[]): Promise<void>;
  /** threadId null = a new email (not a reply). */
  createDraft(threadId: string | null, rawMime: string): Promise<{ draftId: string; messageId: string }>;
  updateDraft(draftId: string, threadId: string | null, rawMime: string): Promise<{ draftId: string; messageId: string }>;
  draftExists(draftId: string): Promise<boolean>;
  deleteDraft(draftId: string): Promise<void>;
  sendDraft(draftId: string): Promise<{ messageId: string; threadId: string }>;
}
