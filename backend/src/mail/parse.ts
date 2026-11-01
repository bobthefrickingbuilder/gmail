/**
 * PARSING GMAIL MESSAGES
 * ----------------------
 * Gmail hands us a tree of MIME "parts" (plain text, HTML, attachments,
 * calendar invites…), each base64url-encoded in its original character set.
 * This module walks the tree and produces one tidy `ParsedMessage`:
 * who sent it, who received it, subject, date, the plain-text body (made
 * from the HTML if there is no plain part), attachment metadata, and the
 * threading headers we need to reply in the right thread.
 */
import { convert } from "html-to-text";
import type { Address, AttachmentMeta, GmailMessage, GmailPart, ParsedMessage } from "./types.js";

const KEPT_HEADERS = ["list-unsubscribe", "list-id", "precedence", "auto-submitted", "x-auto-response-suppress",
  "return-path", "x-mailer", "x-campaign", "feedback-id", "x-spam-flag", "content-language"];

export function b64urlDecode(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
export function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode bytes in a declared charset; fall back to UTF-8, then Latin-1. */
export function decodeCharset(buf: Buffer, charset?: string | null): string {
  const cs = (charset || "utf-8").toLowerCase().replace(/^"|"$/g, "");
  try {
    return new TextDecoder(cs === "us-ascii" ? "utf-8" : cs, { fatal: false }).decode(buf);
  } catch {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return buf.toString("latin1"); }
  }
}

/** RFC 2047 encoded-words, e.g. =?UTF-8?B?w6l0w6k=?= or =?ISO-8859-1?Q?caf=E9?= */
export function decodeEncodedWords(s: string): string {
  if (!s.includes("=?")) return s;
  return s
    .replace(/\?=\s+=\?/g, "?==?") // adjacent encoded words: whitespace between them is dropped
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc: string, text: string) => {
      const charset = cs.split("*")[0];
      if (enc.toUpperCase() === "B") return decodeCharset(Buffer.from(text, "base64"), charset);
      const bytes: number[] = [];
      const t = text.replace(/_/g, " ");
      for (let i = 0; i < t.length; i++) {
        if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
        else bytes.push(t.charCodeAt(i));
      }
      return decodeCharset(Buffer.from(bytes), charset);
    });
}

export function normalizeEmail(e: string): string {
  return e.trim().toLowerCase().replace(/^mailto:/, "");
}

/**
 * Parse an address list header: `"Smith, Jane" <jane@x.com>, bob@y.org, =?UTF-8?Q?Ren=C3=A9?= <r@z.fr>`
 * Commas inside quotes or angle brackets do not split.
 */
export function parseAddressList(value: string | undefined | null): Address[] {
  if (!value) return [];
  const out: Address[] = [];
  let cur = "", inQuote = false, inAngle = false;
  const items: string[] = [];
  for (const ch of value) {
    if (ch === '"' ) inQuote = !inQuote;
    else if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    if ((ch === "," || ch === ";") && !inQuote && !inAngle) { items.push(cur); cur = ""; continue; }
    cur += ch;
  }
  items.push(cur);
  for (const raw of items) {
    const item = raw.trim();
    if (!item) continue;
    const m = item.match(/^(.*?)<([^>]+)>\s*$/);
    if (m) {
      let name = decodeEncodedWords(m[1].trim()).replace(/^"|"$/g, "").replace(/\\"/g, '"').trim();
      out.push({ name: name || null, email: normalizeEmail(m[2]) });
    } else if (item.includes("@")) {
      // "bob@y.org (Bob)" legacy comment form
      const c = item.match(/^([^\s(]+)\s*\((.*)\)$/);
      if (c) out.push({ name: decodeEncodedWords(c[2]), email: normalizeEmail(c[1]) });
      else out.push({ name: null, email: normalizeEmail(item.replace(/^"|"$/g, "")) });
    }
  }
  return out;
}

function headerMap(part: GmailPart): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of part.headers ?? []) {
    const k = h.name.toLowerCase();
    // keep first occurrence, except join multiple "references"
    if (!m.has(k)) m.set(k, h.value);
  }
  return m;
}

function charsetOf(part: GmailPart): string | null {
  const ct = (part.headers ?? []).find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
  const m = ct.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return m ? m[1] : null;
}

function isAttachmentPart(part: GmailPart): boolean {
  const disp = (part.headers ?? []).find((h) => h.name.toLowerCase() === "content-disposition")?.value ?? "";
  return Boolean(part.filename) || /attachment/i.test(disp) || Boolean(part.body?.attachmentId && !part.mimeType?.startsWith("text/"));
}

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
    ],
  }).replace(/\n{3,}/g, "\n\n").trim();
}

export function parseGmailMessage(msg: GmailMessage): ParsedMessage {
  const top = headerMap(msg.payload);
  const texts: string[] = [];
  const htmls: string[] = [];
  const attachments: AttachmentMeta[] = [];
  let calendarInvite: string | null = null;

  const walk = (part: GmailPart) => {
    const mime = (part.mimeType ?? "").toLowerCase();
    if (part.parts?.length) { part.parts.forEach(walk); return; }
    const data = part.body?.data ? decodeCharset(b64urlDecode(part.body.data), charsetOf(part)) : null;
    if (mime === "text/calendar" && data) { calendarInvite = data; }
    if (isAttachmentPart(part)) {
      const disp = (part.headers ?? []).find((h) => h.name.toLowerCase() === "content-disposition")?.value ?? "";
      attachments.push({
        filename: decodeEncodedWords(part.filename || "unnamed"),
        mimeType: mime || "application/octet-stream",
        size: part.body?.size ?? 0,
        attachmentId: part.body?.attachmentId ?? null,
        partId: part.partId ?? null,
        inline: /inline/i.test(disp) || mime.startsWith("image/"),
        text: mime === "text/calendar" ? data : undefined,
      });
      return;
    }
    if (!data) return;
    if (mime === "text/plain") texts.push(data);
    else if (mime === "text/html") htmls.push(data);
  };
  walk(msg.payload);

  const html = htmls.length ? htmls.join("\n") : null;
  let text = texts.join("\n").replace(/\r\n/g, "\n");
  if (!text.trim() && html) text = htmlToText(html);

  const dateHeader = top.get("date");
  let date: string;
  const parsedDate = dateHeader ? new Date(dateHeader) : null;
  if (parsedDate && !isNaN(parsedDate.getTime())) date = parsedDate.toISOString();
  else if (msg.internalDate) date = new Date(Number(msg.internalDate)).toISOString();
  else date = new Date().toISOString();

  const headers: Record<string, string> = {};
  for (const k of KEPT_HEADERS) { const v = top.get(k); if (v) headers[k] = v; }

  const from = parseAddressList(top.get("from"))[0] ?? { name: null, email: "unknown@unknown" };
  return {
    providerMessageId: msg.id,
    providerThreadId: msg.threadId,
    labels: msg.labelIds ?? [],
    from,
    replyTo: parseAddressList(top.get("reply-to")),
    to: parseAddressList(top.get("to")),
    cc: parseAddressList(top.get("cc")),
    bcc: parseAddressList(top.get("bcc")),
    subject: decodeEncodedWords(top.get("subject") ?? "").trim(),
    date,
    messageIdHeader: top.get("message-id")?.trim() ?? null,
    inReplyTo: top.get("in-reply-to")?.trim() ?? null,
    references: top.get("references")?.replace(/\s+/g, " ").trim() ?? null,
    snippet: msg.snippet ?? text.slice(0, 160),
    text,
    html,
    attachments,
    headers,
    calendarInvite,
  };
}
