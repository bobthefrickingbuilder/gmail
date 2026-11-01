import { describe, it, expect } from "vitest";
import { parseGmailMessage, parseAddressList, decodeEncodedWords, b64urlEncode } from "../src/mail/parse.js";
import { makeGmailMessage, inboxFixtures } from "../src/providers/mail/fixtures.js";
import { stripQuotedText, stripSignature, cleanForModel } from "../src/mail/quotes.js";
import { buildReplyMime, buildReferences, computeRecipients, defaultReplyMode, replySubject } from "../src/mail/mime.js";
import { parseIcs } from "../src/mail/ics.js";

describe("address parsing", () => {
  it("handles quoted names with commas, encoded words and bare addresses", () => {
    const list = parseAddressList(`"Smith, Jane" <Jane@X.com>, bob@y.org, =?UTF-8?Q?Ren=C3=A9_Tr=C3=A9panier?= <rene@z.fr>, carl@q.ca (Carl)`);
    expect(list).toEqual([
      { name: "Smith, Jane", email: "jane@x.com" }, { name: null, email: "bob@y.org" },
      { name: "René Trépanier", email: "rene@z.fr" }, { name: "Carl", email: "carl@q.ca" }]);
  });
  it("decodes base64 and ISO-8859-1 encoded words", () => {
    expect(decodeEncodedWords("=?UTF-8?B?w4l0w6k=?=")).toBe("Été");
    expect(decodeEncodedWords("=?ISO-8859-1?Q?caf=E9?= =?ISO-8859-1?Q?_cr=E8me?=")).toBe("café crème");
  });
});

describe("Gmail message parsing", () => {
  it("extracts headers, body, attachments and threading ids", () => {
    const f = inboxFixtures().find((x) => x.id === "m2")!;
    const p = parseGmailMessage(makeGmailMessage(f));
    expect(p.from).toEqual({ name: "Daniel Okafor", email: "daniel@scores.example.com" });
    expect(p.subject).toBe("Contract for the new commission");
    expect(p.messageIdHeader).toBe("<m2@scores.example.com>");
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0].filename).toBe("contract-draft.txt");
    expect(p.text).toContain("clause 4");
  });
  it("decodes ISO-8859-1 bodies", () => {
    const p = parseGmailMessage(makeGmailMessage({ id: "x", threadId: "t", from: "a@b.c", subject: "s", date: new Date().toUTCString(), body: "Répétition à 19 h", charset: "ISO-8859-1" }));
    expect(p.text).toBe("Répétition à 19 h");
  });
  it("falls back to HTML when there is no plain part, and reads calendar invites", () => {
    const msg = makeGmailMessage({ id: "h", threadId: "t", from: "a@b.c", subject: "s", date: new Date().toUTCString(), body: "", html: "<p>Hello <b>there</b></p><img src=x>" });
    expect(parseGmailMessage(msg).text).toBe("Hello there");
    const inv = parseGmailMessage(makeGmailMessage(inboxFixtures().find((x) => x.id === "m9")!));
    expect(inv.calendarInvite).toContain("VEVENT");
    expect(parseIcs(inv.calendarInvite!)).toMatchObject({ summary: "Youth choir bass sectional", start: "2026-11-10T23:00:00Z", location: "St. Paul's Hall", method: "REQUEST" });
  });
  it("uses internalDate when the Date header is garbage", () => {
    const m = makeGmailMessage({ id: "d", threadId: "t", from: "a@b.c", subject: "s", date: "not a date", body: "x" });
    m.internalDate = String(Date.UTC(2026, 0, 2));
    expect(parseGmailMessage(m).date).toBe("2026-01-02T00:00:00.000Z");
  });
  it("b64url round-trips", () => { expect(Buffer.from(b64urlEncode("é?>"), "base64url").toString()).toBe("é?>"); });
});

describe("quote and signature stripping", () => {
  it("removes Gmail 'On … wrote:' blocks (EN + FR) and > lines", () => {
    expect(stripQuotedText("Yes, Tuesday works.\n\nOn Mon, Oct 12, 2026 at 9:00 AM Jane <j@x.com> wrote:\n> Can you?\n> Thanks")).toBe("Yes, Tuesday works.");
    expect(stripQuotedText("D'accord.\n\nLe lun. 12 oct. 2026 à 09 h 00, Jane <j@x.com> a écrit :\n> Bonjour")).toBe("D'accord.");
  });
  it("joins a wrapped quote header", () => {
    expect(stripQuotedText("Fine.\n\nOn Mon, Oct 12, 2026 at 9:00 AM Jane Doe <jane.doe@example.com>\nwrote:\n> old")).toBe("Fine.");
  });
  it("removes Outlook header blocks but not a lone 'From:' line in prose", () => {
    expect(stripQuotedText("See below.\n\nFrom: Jane\nSent: Monday\nTo: Matthew\nSubject: x\n\nold text")).toBe("See below.");
    expect(stripQuotedText("From: the conductor's notes, bar 12 needs work.")).toBe("From: the conductor's notes, bar 12 needs work.");
  });
  it("strips mobile signatures and -- delimiters near the end only", () => {
    expect(stripSignature("Merci,\nSophie\n\nEnvoyé de mon iPhone")).toBe("Merci,\nSophie");
    expect(stripSignature("Hi\n-- \nClaire Dubois\nArtistic Director")).toBe("Hi");
  });
  it("caps very long messages", () => { expect(cleanForModel("a".repeat(20000), 100)).toContain("truncated"); });
});

describe("reply building", () => {
  const orig = parseGmailMessage(makeGmailMessage({ ...inboxFixtures()[0], references: "<a@x> <b@x>" }));
  it("subject gets one Re:", () => {
    expect(replySubject("Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Hello")).toBe("RE: Hello");
    expect(replySubject("Ré : Bonjour")).toBe("Ré : Bonjour");
  });
  it("references append the original message-id", () => {
    expect(buildReferences(orig)).toBe("<a@x> <b@x> <m1@choir.example.org>");
  });
  it("reply vs reply-all recipients exclude me", () => {
    const me = ["matthew@example.com"];
    expect(computeRecipients(orig, me, "reply")).toEqual({ to: [{ name: "Claire Dubois", email: "claire.dubois@choir.example.org" }], cc: [] });
    expect(computeRecipients(orig, me, "reply_all").cc).toEqual([{ name: "Ana Lima", email: "ana.lima@choir.example.org" }]);
    expect(defaultReplyMode(orig, me, true)).toBe("reply_all");
    expect(defaultReplyMode(orig, me, false)).toBe("reply");
  });
  it("MIME has threading headers, encoded subject and signature", () => {
    const mime = buildReplyMime({ from: { name: "Matthew Menard", email: "matthew@example.com" }, to: [{ name: "Réne", email: "r@x.fr" }], cc: [],
      subject: "Re: Répétition", inReplyTo: "<m1@x>", references: "<a@x> <m1@x>", bodyText: "Bonjour", signatureText: "Matthew Menard\n613-863-9796", signatureHtml: null }, "seed");
    expect(mime).toContain("In-Reply-To: <m1@x>");
    expect(mime).toContain("References: <a@x> <m1@x>");
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/);
    const plain = Buffer.from(mime.split("Content-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, ""), "base64").toString();
    expect(plain).toBe("Bonjour\n\nMatthew Menard\n613-863-9796");
  });
});
