/** Files on drafts: upload, limits, re-attach from the conversation, MIME, send binding, cleanup. */
import { describe, it, expect, beforeEach } from "vitest";
import { setup, authedServer } from "./helpers.js";
import { pollOnce } from "../src/worker/index.js";
import { getDb } from "../src/db/index.js";
import { buildReplyMime } from "../src/mail/mime.js";
import { cleanFilename, guessType } from "../src/drafting/attachments.js";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { ctx = await setup(); });

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function threadBySubject(s: string) {
  const db = await getDb();
  return db.selectFrom("threads").selectAll().where("subject", "like", `%${s}%`).executeTakeFirstOrThrow();
}

async function upload(app: Awaited<ReturnType<typeof authedServer>>, kind: string, owner: string, name: string, data: Buffer, type = "application/pdf") {
  return app.app.inject({ method: "POST", url: `/api/attachments?kind=${kind}&owner=${owner}&name=${encodeURIComponent(name)}`, payload: data,
    headers: { authorization: `Bearer ${app.accessToken}`, "content-type": type } });
}

describe("MIME with attachments", () => {
  it("wraps text + html in multipart/mixed with base64 file parts and safe names", () => {
    const mime = buildReplyMime({ from: { name: "M", email: "m@x.org" }, to: [{ name: null, email: "a@x.org" }], cc: [], subject: "Re: Hi",
      inReplyTo: "<1@x>", references: "<1@x>", bodyText: "Hello", signatureText: null, signatureHtml: null,
      attachments: [{ filename: "Programme notes.pdf", mimeType: "application/pdf", data: PDF }, { filename: "Été « choral ».docx", mimeType: "bad type", data: Buffer.from("x") }] }, "seed");
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="=_assistant_seed_mixed"/);
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="=_assistant_seed"');
    expect(mime).toContain('Content-Disposition: attachment; filename="Programme notes.pdf"');
    expect(mime).toContain(PDF.toString("base64").slice(0, 40));
    expect(mime).toContain("filename*=UTF-8''%C3%89t%C3%A9");
    expect(mime).toContain("Content-Type: application/octet-stream; name=\"=?UTF-8?B?");
    expect(mime.trimEnd().endsWith("--=_assistant_seed_mixed--")).toBe(true);
    // without files the message is unchanged (multipart/alternative only)
    const plain = buildReplyMime({ from: { name: null, email: "m@x.org" }, to: [], cc: [], subject: "s", inReplyTo: null, references: null, bodyText: "b", signatureText: null, signatureHtml: null }, "seed");
    expect(plain).not.toContain("multipart/mixed");
  });

  it("cleans names and guesses types", () => {
    expect(cleanFilename("../../etc/passwd")).toBe("passwd");
    expect(cleanFilename("C:\\Users\\me\\score.pdf")).toBe("score.pdf");
    expect(cleanFilename('a"b<c>.pdf')).toBe("a_b_c_.pdf");
    expect(guessType("x.pdf", "application/octet-stream")).toBe("application/pdf");
    expect(guessType("x.docx", "")).toContain("wordprocessingml");
    expect(guessType("photo.jpg", "image/jpeg")).toBe("image/jpeg");
  });
});

describe("attachments on reply drafts", () => {
  it("upload → in Gmail draft → shown at send review → change invalidates review → sent with file → cleared", async () => {
    await pollOnce();
    const s = await authedServer();
    const t = await threadBySubject("Messiah");
    const d = (await s.call("GET", `/api/threads/${t.id}`)).json();
    const draftId = d.draft.id;
    await s.call("POST", `/api/drafts/${draftId}/save`);

    const up = await upload(s, "reply", draftId, "Bass part.pdf", PDF);
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ filename: "Bass part.pdf", mime_type: "application/pdf", size: PDF.length });
    const list = (await s.call("GET", `/api/attachments?kind=reply&owner=${draftId}`)).json();
    expect(list).toHaveLength(1);
    // the Gmail draft was updated with the file straight away
    const pid = (await (await getDb()).selectFrom("drafts").select("provider_draft_id").where("id", "=", draftId).executeTakeFirstOrThrow()).provider_draft_id!;
    expect(ctx.mail.draftMime(pid)).toContain('filename="Bass part.pdf"');
    // download returns the same bytes, as a download
    const dl = await s.call("GET", `/api/attachments/${up.json().id}/download`);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(dl.rawPayload.equals(PDF)).toBe(true);

    const prep = (await s.call("POST", `/api/drafts/${draftId}/send/prepare`)).json();
    expect(prep.attachments).toEqual([{ filename: "Bass part.pdf", size: PDF.length, mime_type: "application/pdf" }]);
    // adding a file after review → that confirmation no longer works
    await upload(s, "reply", draftId, "notes.txt", Buffer.from("hello"), "text/plain");
    const stale = await s.call("POST", `/api/drafts/${draftId}/send`, { token: prep.token, confirm: true });
    expect(stale.body).toContain("changed after you reviewed");
    // remove it again, review, send
    const notes = (await s.call("GET", `/api/attachments?kind=reply&owner=${draftId}`)).json().find((a: { filename: string }) => a.filename === "notes.txt");
    expect((await s.call("DELETE", `/api/attachments/${notes.id}`)).statusCode).toBe(200);
    const prep2 = (await s.call("POST", `/api/drafts/${draftId}/send/prepare`)).json();
    expect((await s.call("POST", `/api/drafts/${draftId}/send`, { token: prep2.token, confirm: true })).statusCode).toBe(200);
    expect(ctx.mail.sent).toHaveLength(1);
    expect(ctx.mail.sent[0].raw).toContain('filename="Bass part.pdf"');
    expect(ctx.mail.sent[0].raw).not.toContain("notes.txt");
    const db = await getDb();
    expect(await db.selectFrom("draft_attachments").selectAll().execute()).toHaveLength(0);
  });

  it("re-attaches a file from the conversation; refuses blocked types, empty files and over 25 MB", async () => {
    await pollOnce();
    const s = await authedServer();
    const t = await threadBySubject("Contract for the new commission");
    let d = (await s.call("GET", `/api/threads/${t.id}`)).json();
    if (!d.draft) { await s.call("POST", `/api/threads/${t.id}/draft`, {}); d = (await s.call("GET", `/api/threads/${t.id}`)).json(); }
    const draftId = d.draft.id;
    const msg = d.messages.find((m: { attachments: unknown[] }) => m.attachments.length);
    const r = await s.call("POST", "/api/attachments/from-message", { kind: "reply", owner: draftId, messageId: msg.id, index: 0 });
    expect(r.statusCode).toBe(200);
    expect(r.json().filename).toBe("contract-draft.txt");

    expect((await upload(s, "reply", draftId, "setup.exe", Buffer.from("MZ"), "application/octet-stream")).json().error).toContain(".exe");
    expect((await upload(s, "reply", draftId, "empty.pdf", Buffer.alloc(0))).statusCode).toBe(400);
    const big = Buffer.alloc(24 * 1024 * 1024, 1);
    expect((await upload(s, "reply", draftId, "big1.pdf", big)).statusCode).toBe(200);
    const tooMuch = await upload(s, "reply", draftId, "big2.pdf", Buffer.alloc(2 * 1024 * 1024, 1));
    expect(tooMuch.statusCode).toBe(413);
    expect(tooMuch.json().error).toContain("25 MB");
    // unknown draft
    expect((await upload(s, "reply", "nope", "a.pdf", PDF)).statusCode).toBe(404);
  });

  it("discarding a draft removes its files", async () => {
    await pollOnce();
    const s = await authedServer();
    const t = await threadBySubject("Messiah");
    const draftId = (await s.call("GET", `/api/threads/${t.id}`)).json().draft.id;
    await upload(s, "reply", draftId, "a.pdf", PDF);
    await s.call("DELETE", `/api/drafts/${draftId}`);
    expect(await (await getDb()).selectFrom("draft_attachments").selectAll().execute()).toHaveLength(0);
  });
});

describe("attachments on new emails", () => {
  it("attaches, saves to Gmail with the file, shows it at review, sends", async () => {
    const s = await authedServer();
    const c = (await s.call("POST", "/api/compose", { to: [{ name: null, email: "friend@example.org" }], subject: "Scores", body: "Here they are." })).json();
    await s.call("POST", `/api/compose/${c.id}/save`);
    expect((await s.call("GET", `/api/compose/${c.id}`)).json().saved).toBe(true);
    expect((await upload(s, "compose", c.id, "Ave verum.pdf", PDF)).statusCode).toBe(200);
    expect((await s.call("GET", `/api/compose/${c.id}`)).json().saved).toBe(false); // Gmail copy is now older
    await s.call("POST", `/api/compose/${c.id}/save`);
    const pid = (await s.call("GET", `/api/compose/${c.id}`)).json().provider_draft_id;
    expect(ctx.mail.draftMime(pid)).toContain('filename="Ave verum.pdf"');
    const prep = (await s.call("POST", `/api/compose/${c.id}/send/prepare`)).json();
    expect(prep.attachments[0].filename).toBe("Ave verum.pdf");
    expect((await s.call("POST", `/api/compose/${c.id}/send`, { token: prep.token, confirm: true })).statusCode).toBe(200);
    expect(ctx.mail.sent.at(-1)!.raw).toContain('filename="Ave verum.pdf"');
  });
});
