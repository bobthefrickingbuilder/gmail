/**
 * MOCK GMAIL — an in-memory mailbox that behaves like the Gmail API for the
 * calls we use (history, messages, labels, drafts, send). Used in MOCK_MODE,
 * tests, and the evaluation harness demo.
 */
import { makeGmailMessage, inboxFixtures, sentFixtures, originalFixtures, MOCK_OWNER, type FixtureSpec } from "./fixtures.js";
import { HistoryExpiredError, type MailProvider, type SendAs } from "./types.js";
import type { GmailMessage } from "../../mail/types.js";


export class MockMailProvider implements MailProvider {
  readonly kind = "mock";
  messages = new Map<string, GmailMessage>();
  attachments = new Map<string, Buffer>();
  history: { id: number; messageId: string }[] = [];
  historyCounter = 1000;
  labels = new Map<string, string>([["INBOX", "INBOX"], ["SENT", "SENT"], ["UNREAD", "UNREAD"]]);
  threadLabels = new Map<string, Set<string>>();
  drafts = new Map<string, { threadId: string; raw: string; messageId: string }>();
  sent: { draftId: string; raw: string }[] = [];
  /** minimum history id still available (to simulate expiry) */
  minHistory = 0;
  private draftSeq = 0;

  constructor(seed = true) {
    if (seed) {
      for (const f of [...originalFixtures(), ...sentFixtures(), ...inboxFixtures()]) this.add(f, false);
    }
  }

  add(f: FixtureSpec, recordHistory = true) {
    const msg = makeGmailMessage(f);
    this.messages.set(msg.id, msg);
    (f.attachments ?? []).forEach((a, i) => this.attachments.set(`att-${f.id}-${i}`, Buffer.from(a.content)));
    if (recordHistory) this.history.push({ id: ++this.historyCounter, messageId: msg.id });
    return msg;
  }

  /** Simulate a new email arriving (used by the "simulate email" button in mock mode). */
  receive(f: FixtureSpec) { return this.add(f, true); }

  async getProfile() { return { email: MOCK_OWNER, historyId: String(this.historyCounter) }; }

  async listHistory(start: string) {
    const s = Number(start);
    if (s < this.minHistory) throw new HistoryExpiredError();
    const ids = this.history.filter((h) => h.id > s).map((h) => h.messageId);
    return { messageIds: [...new Set(ids)], historyId: String(this.historyCounter) };
  }

  async listMessageIds(query: string, maxResults: number, pageToken?: string) {
    let all = [...this.messages.values()].sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
    if (/in:sent|from:me/.test(query)) all = all.filter((m) => m.labelIds?.includes("SENT"));
    else if (/in:inbox/.test(query)) all = all.filter((m) => m.labelIds?.includes("INBOX"));
    const start = pageToken ? Number(pageToken) : 0;
    const page = all.slice(start, start + maxResults).map((m) => m.id);
    return { ids: page, nextPageToken: start + maxResults < all.length ? String(start + maxResults) : undefined };
  }

  async getMessage(id: string) {
    const m = this.messages.get(id);
    if (!m) throw new Error(`mock: message ${id} not found`);
    return structuredClone(m);
  }
  async getAttachment(_messageId: string, attachmentId: string) {
    const a = this.attachments.get(attachmentId);
    if (!a) throw new Error("mock: attachment not found");
    return a;
  }
  async getSendAs(): Promise<SendAs[]> {
    return [{ email: MOCK_OWNER, displayName: "Matthew Menard", isDefault: true, isPrimary: true,
      signature: "<div>Matthew Menard<br>613-863-9796<br>© 2026 Matthew Menard. All rights reserved.</div>" }];
  }
  async ensureLabels(names: string[]) {
    const out: Record<string, string> = {};
    for (const n of names) { if (!this.labels.has(n)) this.labels.set(n, `Label_${this.labels.size}`); out[n] = this.labels.get(n)!; }
    return out;
  }
  async modifyThreadLabels(threadId: string, add: string[], remove: string[]) {
    const set = this.threadLabels.get(threadId) ?? new Set<string>();
    add.forEach((l) => set.add(l)); remove.forEach((l) => set.delete(l));
    this.threadLabels.set(threadId, set);
  }
  async createDraft(threadId: string, raw: string) {
    const draftId = `d${++this.draftSeq}`;
    const messageId = `dm${this.draftSeq}`;
    this.drafts.set(draftId, { threadId, raw, messageId });
    return { draftId, messageId };
  }
  async updateDraft(draftId: string, threadId: string, raw: string) {
    const d = this.drafts.get(draftId);
    if (!d) throw Object.assign(new Error("mock: draft not found"), { code: 404 });
    this.drafts.set(draftId, { ...d, threadId, raw });
    return { draftId, messageId: d.messageId };
  }
  async draftExists(draftId: string) { return this.drafts.has(draftId); }
  async deleteDraft(draftId: string) { this.drafts.delete(draftId); }
  async sendDraft(draftId: string) {
    const d = this.drafts.get(draftId);
    if (!d) throw new Error("mock: draft not found");
    this.sent.push({ draftId, raw: d.raw });
    this.drafts.delete(draftId);
    return { messageId: `sent-${draftId}`, threadId: d.threadId };
  }
  /** Helper for tests: decoded MIME of a draft. */
  draftMime(draftId: string) { return this.drafts.get(draftId)?.raw ?? null; }
}
