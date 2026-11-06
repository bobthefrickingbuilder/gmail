/**
 * ATTACHMENTS ON YOUR DRAFTS
 * --------------------------
 * Files (PDFs, documents, images…) you add to a reply draft or a new email.
 * They are stored on your server until the email is sent or discarded, and
 * included in the Gmail draft every time it is saved, so Gmail's Drafts
 * folder shows them too.
 *
 * You can add a file from your device, or re-attach a file someone sent you
 * in this conversation (for example to pass a PDF on).
 *
 * Limits follow Gmail: 25 MB in total per email. Gmail refuses some file
 * types (programs and scripts), so we reject those up front with a clear
 * message instead of a confusing error when saving.
 *
 * Attachments are never sent to Claude. They only go into the email.
 *
 * The send confirmation is bound to a fingerprint of the attachments, so
 * adding or removing a file after you reviewed the email needs a fresh
 * review.
 */
import { getDb, now, uid } from "../db/index.js";
import { sha256 } from "../crypto.js";
import { HttpError } from "../http.js";
import { audit } from "../audit.js";
import type { MimeAttachment } from "../mail/mime.js";

export type OwnerKind = "reply" | "compose";

/** Gmail's limit for everything attached to one email. */
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 20;

/** Extensions Gmail blocks for security (https://support.google.com/mail/answer/6590). */
const BLOCKED_EXT = new Set(["ade", "adp", "apk", "appx", "appxbundle", "bat", "cab", "chm", "cmd", "com", "cpl", "diagcab", "diagcfg", "diagpack",
  "dll", "dmg", "ex", "ex_", "exe", "hta", "img", "ins", "iso", "isp", "jar", "jnlp", "js", "jse", "lib", "lnk", "mde", "mjs", "msc", "msi", "msix",
  "msixbundle", "msp", "mst", "nsh", "pif", "ps1", "scr", "sct", "shb", "sys", "vb", "vbe", "vbs", "vhd", "vxd", "wsc", "wsf", "wsh", "xll"]);

/** Common types by extension, for when the device doesn't say. */
const TYPE_BY_EXT: Record<string, string> = {
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", csv: "text/csv", rtf: "application/rtf", odt: "application/vnd.oasis.opendocument.text",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", mp4: "video/mp4", mov: "video/quicktime",
  mid: "audio/midi", midi: "audio/midi", mscz: "application/octet-stream", musicxml: "application/vnd.recordare.musicxml+xml",
  zip: "application/zip",
};

const ext = (name: string) => (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();

/** Keep the name readable but safe: no paths, no control characters, sensible length. */
export function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "_").replace(/^\.+/, "").trim().slice(-180);
  return cleaned || "attachment";
}

export function guessType(filename: string, given?: string | null): string {
  const g = (given ?? "").toLowerCase().split(";")[0].trim();
  if (g && g !== "application/octet-stream" && /^[\w.+-]+\/[\w.+-]+$/.test(g)) return g;
  return TYPE_BY_EXT[ext(filename)] ?? "application/octet-stream";
}

export interface AttachmentInfo { id: string; filename: string; mime_type: string; size: number; created_at: string }

async function assertOwner(kind: OwnerKind, ownerId: string) {
  const db = await getDb();
  if (kind === "reply") {
    const d = await db.selectFrom("drafts").select(["status"]).where("id", "=", ownerId).executeTakeFirst();
    if (!d || !["active", "saved"].includes(d.status)) throw new HttpError(404, "Draft not found");
  } else {
    const c = await db.selectFrom("compose_drafts").select(["status"]).where("id", "=", ownerId).executeTakeFirst();
    if (!c || !["open", "saved"].includes(c.status)) throw new HttpError(404, "Email not found");
  }
}

export async function listAttachments(kind: OwnerKind, ownerId: string): Promise<AttachmentInfo[]> {
  const db = await getDb();
  return db.selectFrom("draft_attachments").select(["id", "filename", "mime_type", "size", "created_at"])
    .where("owner_kind", "=", kind).where("owner_id", "=", ownerId).orderBy("created_at").orderBy("id").execute();
}

export async function addAttachment(kind: OwnerKind, ownerId: string, file: { filename: string; mimeType?: string | null; data: Buffer }): Promise<AttachmentInfo> {
  await assertOwner(kind, ownerId);
  const filename = cleanFilename(file.filename);
  if (BLOCKED_EXT.has(ext(filename))) throw new HttpError(400, `Gmail doesn't allow .${ext(filename)} files to be attached`);
  if (!file.data.length) throw new HttpError(400, "That file is empty");
  const existing = await listAttachments(kind, ownerId);
  if (existing.length >= MAX_FILES) throw new HttpError(400, `At most ${MAX_FILES} files per email`);
  const total = existing.reduce((n, a) => n + a.size, 0) + file.data.length;
  if (total > MAX_TOTAL_BYTES) {
    throw new HttpError(413, `Attachments would total ${(total / 1048576).toFixed(1)} MB; Gmail allows 25 MB per email. Share large files as a Google Drive link instead.`);
  }
  const row = { id: uid(), owner_kind: kind, owner_id: ownerId, filename, mime_type: guessType(filename, file.mimeType), size: file.data.length,
    sha256: sha256(file.data.toString("base64")), data_b64: file.data.toString("base64"), created_at: now() };
  const db = await getDb();
  await db.insertInto("draft_attachments").values(row).execute();
  await audit("user", "attachment.add", kind, ownerId, { attachment_id: row.id, size: row.size, mime_type: row.mime_type });
  return { id: row.id, filename: row.filename, mime_type: row.mime_type, size: row.size, created_at: row.created_at };
}

export async function getAttachment(id: string) {
  const db = await getDb();
  const a = await db.selectFrom("draft_attachments").selectAll().where("id", "=", id).executeTakeFirst();
  if (!a) throw new HttpError(404, "Attachment not found");
  return a;
}

export async function removeAttachment(id: string) {
  const a = await getAttachment(id);
  await assertOwner(a.owner_kind as OwnerKind, a.owner_id);
  const db = await getDb();
  await db.deleteFrom("draft_attachments").where("id", "=", id).execute();
  await audit("user", "attachment.remove", a.owner_kind, a.owner_id, { attachment_id: id });
  return a;
}

/** Remove every file of a draft (after it is sent or discarded). */
export async function clearAttachments(kind: OwnerKind, ownerId: string) {
  const db = await getDb();
  await db.deleteFrom("draft_attachments").where("owner_kind", "=", kind).where("owner_id", "=", ownerId).execute();
}

/** The files, ready to go into the email. */
export async function attachmentsForMime(kind: OwnerKind, ownerId: string): Promise<MimeAttachment[]> {
  const db = await getDb();
  const rows = await db.selectFrom("draft_attachments").select(["filename", "mime_type", "data_b64"])
    .where("owner_kind", "=", kind).where("owner_id", "=", ownerId).orderBy("created_at").orderBy("id").execute();
  return rows.map((r) => ({ filename: r.filename, mimeType: r.mime_type, data: Buffer.from(r.data_b64, "base64") }));
}

/** Changes whenever a file is added or removed; part of the send confirmation. */
export async function attachmentFingerprint(kind: OwnerKind, ownerId: string): Promise<string> {
  const db = await getDb();
  const rows = await db.selectFrom("draft_attachments").select(["id", "sha256"])
    .where("owner_kind", "=", kind).where("owner_id", "=", ownerId).orderBy("id").execute();
  return rows.length ? sha256(rows.map((r) => `${r.id}:${r.sha256}`).join(",")) : "";
}
