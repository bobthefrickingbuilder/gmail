/**
 * ATTACHMENT TEXT EXTRACTION
 * PDFs and Word (.docx) attachments are turned into plain text so the model
 * can read e.g. a contract or a rehearsal schedule. Limits keep it cheap:
 * files over 5 MB are skipped, and only the first 20,000 characters are kept.
 */
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import type { AttachmentMeta } from "./types.js";

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_CHARS = 20000;

export function isExtractable(a: AttachmentMeta): boolean {
  const n = a.filename.toLowerCase();
  return a.mimeType === "application/pdf" || n.endsWith(".pdf") ||
    a.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || n.endsWith(".docx") ||
    a.mimeType === "text/plain" || n.endsWith(".txt");
}

export async function extractText(a: AttachmentMeta, data: Buffer): Promise<string | null> {
  if (data.length > MAX_ATTACHMENT_BYTES) return null;
  const n = a.filename.toLowerCase();
  let text: string | null = null;
  try {
    if (a.mimeType === "application/pdf" || n.endsWith(".pdf")) {
      const parser = new PDFParse({ data: new Uint8Array(data) });
      try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
    } else if (n.endsWith(".docx") || a.mimeType.includes("wordprocessingml")) {
      text = (await mammoth.extractRawText({ buffer: data })).value;
    } else if (a.mimeType === "text/plain" || n.endsWith(".txt")) {
      text = data.toString("utf8");
    }
  } catch {
    return null; // corrupt or encrypted file: keep metadata only
  }
  if (!text) return null;
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text.length > MAX_ATTACHMENT_CHARS ? text.slice(0, MAX_ATTACHMENT_CHARS) + "\n[…truncated…]" : text;
}
