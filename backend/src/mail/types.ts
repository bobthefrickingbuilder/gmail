/** Shapes shared by the mail code. `GmailMessage` mirrors the Gmail API "full" format. */
export interface GmailHeader { name: string; value: string }
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload: GmailPart;
}

export interface Address { name: string | null; email: string }

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string | null;
  partId: string | null;
  inline: boolean;
  /** Extracted text (PDF/DOCX/TXT/ICS), capped. Filled in later by attachments.ts. */
  text?: string | null;
}

export interface ParsedMessage {
  providerMessageId: string;
  providerThreadId: string;
  labels: string[];
  from: Address;
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  date: string; // ISO
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string | null;
  snippet: string;
  text: string;
  html: string | null;
  attachments: AttachmentMeta[];
  /** Selected headers used by triage: List-Unsubscribe, Precedence, Auto-Submitted, etc. */
  headers: Record<string, string>;
  /** Raw text/calendar content if the mail carries an invite. */
  calendarInvite: string | null;
}
