/**
 * BUILDING A REPLY (MIME)
 * -----------------------
 * Gmail drafts are uploaded as a raw email. For the reply to land in the
 * right conversation we must set:
 *   - In-Reply-To: the Message-ID of the email we answer
 *   - References: the earlier References + that Message-ID
 *   - Subject: "Re: <original>" (not "Re: Re:")
 *   - threadId on the Gmail API call (done by the caller)
 * We send a plain-text part and a simple HTML part (so the Gmail HTML
 * signature renders properly).
 */
import type { Address, ParsedMessage } from "./types.js";
import { htmlToText } from "./parse.js";

export function replySubject(subject: string): string {
  const s = subject.trim();
  return /^(re|ré|aw|sv)\s*:/i.test(s) ? s : `Re: ${s || "(no subject)"}`;
}

export function buildReferences(orig: Pick<ParsedMessage, "references" | "messageIdHeader">): string | null {
  const ids = (orig.references ?? "").split(/\s+/).filter(Boolean);
  if (orig.messageIdHeader && !ids.includes(orig.messageIdHeader)) ids.push(orig.messageIdHeader);
  // Keep the header reasonable on giant threads: first id + last 20.
  const trimmed = ids.length > 21 ? [ids[0], ...ids.slice(-20)] : ids;
  return trimmed.length ? trimmed.join(" ") : null;
}

/**
 * Decide recipients. reply = the sender (or Reply-To). reply_all adds the
 * other To/Cc people, minus yourself and your aliases.
 */
export function computeRecipients(orig: ParsedMessage, myAddresses: string[], mode: "reply" | "reply_all") {
  const mine = new Set(myAddresses.map((a) => a.toLowerCase()));
  const primary = orig.replyTo.length ? orig.replyTo : [orig.from];
  // If I sent the last message, "reply" goes to its original To list.
  const base = mine.has(orig.from.email) ? orig.to : primary;
  const to = dedupe(base.filter((a) => !mine.has(a.email)));
  let cc: Address[] = [];
  if (mode === "reply_all") {
    const seen = new Set(to.map((a) => a.email));
    cc = dedupe([...orig.to, ...orig.cc].filter((a) => !mine.has(a.email) && !seen.has(a.email)));
  }
  return { to, cc };
}

/** Rule from DECISIONS.md #22: reply-all if others were on it and I was a direct (To) recipient. */
export function defaultReplyMode(orig: ParsedMessage, myAddresses: string[], replyAllDefault: boolean): "reply" | "reply_all" {
  if (!replyAllDefault) return "reply";
  const mine = new Set(myAddresses.map((a) => a.toLowerCase()));
  const others = [...orig.to, ...orig.cc].filter((a) => !mine.has(a.email) && a.email !== orig.from.email);
  const iWasInTo = orig.to.some((a) => mine.has(a.email));
  return others.length > 0 && iWasInTo ? "reply_all" : "reply";
}

function dedupe(list: Address[]): Address[] {
  const seen = new Set<string>();
  return list.filter((a) => (seen.has(a.email) ? false : (seen.add(a.email), true)));
}

const needsEncoding = (s: string) => /[^\x20-\x7e]/.test(s);
export function encodeHeaderWord(s: string): string {
  return needsEncoding(s) ? `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=` : s;
}
export function formatAddress(a: Address): string {
  if (!a.name) return a.email;
  const name = needsEncoding(a.name) ? encodeHeaderWord(a.name) : /[",;<>@()]/.test(a.name) ? `"${a.name.replace(/"/g, '\\"')}"` : a.name;
  return `${name} <${a.email}>`;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function textToHtml(text: string): string {
  return text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("\n");
}

const wrap76 = (b64: string) => b64.replace(/(.{76})/g, "$1\r\n");

export interface ReplyInput {
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  inReplyTo: string | null;
  references: string | null;
  bodyText: string;
  /** Signature: plain text, or HTML from Gmail. */
  signatureText: string | null;
  signatureHtml: string | null;
}

/** Returns the full RFC 2822 message as a string (caller base64url-encodes for Gmail). */
export function buildReplyMime(r: ReplyInput, boundarySeed: string = crypto.randomUUID()): string {
  const boundary = `=_assistant_${boundarySeed.replace(/-/g, "")}`;
  const sigText = r.signatureText ?? (r.signatureHtml ? htmlToText(r.signatureHtml) : null);
  const plain = sigText ? `${r.bodyText.trimEnd()}\n\n${sigText}` : r.bodyText;
  const html = `<div dir="ltr">${textToHtml(r.bodyText.trimEnd())}${
    r.signatureHtml ? `<br><div class="gmail_signature">${r.signatureHtml}</div>` : sigText ? `<br>${textToHtml(sigText)}` : ""}</div>`;
  const headers = [
    `From: ${formatAddress(r.from)}`,
    `To: ${r.to.map(formatAddress).join(", ")}`,
    ...(r.cc.length ? [`Cc: ${r.cc.map(formatAddress).join(", ")}`] : []),
    `Subject: ${encodeHeaderWord(r.subject)}`,
    ...(r.inReplyTo ? [`In-Reply-To: ${r.inReplyTo}`] : []),
    ...(r.references ? [`References: ${r.references}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, content: string) => [
    `--${boundary}`, `Content-Type: ${type}; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "",
    wrap76(Buffer.from(content, "utf8").toString("base64")),
  ].join("\r\n");
  return [...headers, "", part("text/plain", plain), part("text/html", html), `--${boundary}--`, ""].join("\r\n");
}
