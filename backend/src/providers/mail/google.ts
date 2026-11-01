/**
 * GMAIL PROVIDER — the real Gmail API behind the MailProvider interface.
 * Every call goes through withRetry() (backoff on 429/5xx). Authorization
 * failures become AuthExpiredError so the app can ask you to reconnect.
 */
import { google, type gmail_v1 } from "googleapis";
import { authorizedClient, isAuthError } from "../../google/oauth.js";
import { withRetry } from "../../retry.js";
import { b64urlDecode, b64urlEncode } from "../../mail/parse.js";
import type { GmailMessage } from "../../mail/types.js";
import { AuthExpiredError, HistoryExpiredError, type MailProvider, type SendAs } from "./types.js";

export class GoogleMailProvider implements MailProvider {
  readonly kind = "google";
  private api: gmail_v1.Gmail | null = null;
  constructor(private accountId: string) {}

  private async gmail() {
    if (!this.api) this.api = google.gmail({ version: "v1", auth: await authorizedClient(this.accountId) });
    return this.api;
  }
  private async call<T>(fn: (g: gmail_v1.Gmail) => Promise<T>): Promise<T> {
    const g = await this.gmail();
    try { return await withRetry(() => fn(g)); } catch (e) {
      if (isAuthError(e)) throw new AuthExpiredError();
      throw e;
    }
  }

  async getProfile() {
    const r = await this.call((g) => g.users.getProfile({ userId: "me" }));
    return { email: (r.data.emailAddress ?? "").toLowerCase(), historyId: String(r.data.historyId) };
  }

  async listHistory(startHistoryId: string) {
    const ids = new Set<string>();
    let pageToken: string | undefined; let historyId = startHistoryId;
    try {
      do {
        const r = await this.call((g) => g.users.history.list({ userId: "me", startHistoryId, historyTypes: ["messageAdded"], pageToken, maxResults: 500 }));
        for (const h of r.data.history ?? []) for (const a of h.messagesAdded ?? []) if (a.message?.id) ids.add(a.message.id);
        historyId = String(r.data.historyId ?? historyId);
        pageToken = r.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (e) {
      const status = (e as { response?: { status?: number }; code?: number }).response?.status ?? (e as { code?: number }).code;
      if (status === 404) throw new HistoryExpiredError();
      throw e;
    }
    return { messageIds: [...ids], historyId };
  }

  async listMessageIds(query: string, maxResults: number, pageToken?: string) {
    const r = await this.call((g) => g.users.messages.list({ userId: "me", q: query, maxResults, pageToken }));
    return { ids: (r.data.messages ?? []).map((m) => m.id!).filter(Boolean), nextPageToken: r.data.nextPageToken ?? undefined };
  }

  async getMessage(id: string): Promise<GmailMessage> {
    const r = await this.call((g) => g.users.messages.get({ userId: "me", id, format: "full" }));
    return r.data as unknown as GmailMessage;
  }

  async getAttachment(messageId: string, attachmentId: string) {
    const r = await this.call((g) => g.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId }));
    return b64urlDecode(r.data.data ?? "");
  }

  async getSendAs(): Promise<SendAs[]> {
    const r = await this.call((g) => g.users.settings.sendAs.list({ userId: "me" }));
    return (r.data.sendAs ?? []).map((s) => ({
      email: (s.sendAsEmail ?? "").toLowerCase(), displayName: s.displayName ?? null, signature: s.signature || null,
      isDefault: Boolean(s.isDefault), isPrimary: Boolean(s.isPrimary),
    }));
  }

  async ensureLabels(names: string[]) {
    const existing = await this.call((g) => g.users.labels.list({ userId: "me" }));
    const map: Record<string, string> = {};
    for (const l of existing.data.labels ?? []) if (l.name && l.id) map[l.name] = l.id;
    for (const n of names) {
      if (map[n]) continue;
      const created = await this.call((g) => g.users.labels.create({ userId: "me", requestBody: { name: n, labelListVisibility: "labelShow", messageListVisibility: "show" } }));
      map[n] = created.data.id!;
    }
    return Object.fromEntries(names.map((n) => [n, map[n]]));
  }

  async modifyThreadLabels(threadId: string, add: string[], remove: string[]) {
    await this.call((g) => g.users.threads.modify({ userId: "me", id: threadId, requestBody: { addLabelIds: add, removeLabelIds: remove } }));
  }

  async createDraft(threadId: string, rawMime: string) {
    const r = await this.call((g) => g.users.drafts.create({ userId: "me", requestBody: { message: { raw: b64urlEncode(rawMime), threadId } } }));
    return { draftId: r.data.id!, messageId: r.data.message?.id ?? "" };
  }

  async updateDraft(draftId: string, threadId: string, rawMime: string) {
    const r = await this.call((g) => g.users.drafts.update({ userId: "me", id: draftId, requestBody: { id: draftId, message: { raw: b64urlEncode(rawMime), threadId } } }));
    return { draftId: r.data.id!, messageId: r.data.message?.id ?? "" };
  }

  async draftExists(draftId: string) {
    try { await this.call((g) => g.users.drafts.get({ userId: "me", id: draftId, format: "minimal" })); return true; }
    catch (e) { if ((e as { response?: { status?: number } }).response?.status === 404) return false; throw e; }
  }

  async deleteDraft(draftId: string) { await this.call((g) => g.users.drafts.delete({ userId: "me", id: draftId })); }

  /** ONLY called by the confirmed Send route. */
  async sendDraft(draftId: string) {
    const r = await this.call((g) => g.users.drafts.send({ userId: "me", requestBody: { id: draftId } }));
    return { messageId: r.data.id ?? "", threadId: r.data.threadId ?? "" };
  }
}
