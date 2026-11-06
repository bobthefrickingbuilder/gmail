/**
 * ATTACHMENTS ON A DRAFT
 * "Attach files" opens the device's file picker (Files / Drive / Photos on
 * iPad and Android, the file browser on desktop); you can also drag files
 * onto the box on desktop. Files sent to you in this conversation can be
 * re-attached with one tap. Each file shows its size; tap × to remove it.
 * Gmail allows 25 MB in total per email.
 */
import { useEffect, useRef, useState } from "react";
import { api, uploadFile } from "../api";
import { apiUrl, api as apiDownload } from "../apiUrl";
import { useLive, toast } from "../hooks";
import type { Message } from "../types";

export interface DraftFile { id: string; filename: string; mime_type: string; size: number; created_at: string }
const LIMIT = 25 * 1024 * 1024;

export function fileSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
const icon = (type: string, name: string) =>
  type === "application/pdf" || /\.pdf$/i.test(name) ? "📄" : type.startsWith("image/") ? "🖼️" : type.startsWith("audio/") ? "🎵" : type.startsWith("video/") ? "🎬" : "📎";

export function Attachments({ kind, owner, sources = [], onChange }: { kind: "reply" | "compose"; owner: string; sources?: Message[]; onChange?: () => void }) {
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const q = `kind=${kind}&owner=${encodeURIComponent(owner)}`;
  const load = () => api<DraftFile[]>(`/api/attachments?${q}`).then(setFiles).catch(() => undefined);
  useEffect(() => { void load(); }, [q]);
  useLive([kind === "reply" ? "draft" : "compose"], () => void load());

  const total = files.reduce((n, f) => n + f.size, 0);
  const add = async (list: FileList | File[]) => {
    for (const f of Array.from(list)) {
      if (total + f.size > LIMIT) { toast(`${f.name} is too big: Gmail allows 25 MB in total per email. Share it as a Google Drive link instead.`, "error"); continue; }
      setUploading(f.name);
      try { await uploadFile(`/api/attachments?${q}&name=${encodeURIComponent(f.name)}`, f); }
      catch (e) { toast(`${f.name}: ${(e as Error).message}`, "error"); }
    }
    setUploading(null);
    if (input.current) input.current.value = "";
    await load(); onChange?.();
  };
  const remove = async (f: DraftFile) => {
    try { await api(`/api/attachments/${f.id}`, { method: "DELETE" }); await load(); onChange?.(); } catch (e) { toast((e as Error).message, "error"); }
  };
  const fromMessage = async (messageId: string, index: number, name: string) => {
    setUploading(name);
    try { await api("/api/attachments/from-message", { method: "POST", body: { kind, owner, messageId, index } }); await load(); onChange?.(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setUploading(null); }
  };
  const download = async (f: DraftFile) => {
    const blob = await apiDownload<Blob>(`/api/attachments/${f.id}/download`, { blob: true });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = f.filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const attachedNames = new Set(files.map((f) => f.filename));
  const received = sources.filter((m) => !m.is_from_me).flatMap((m) => m.attachments.filter((a) => !a.inline || a.mimeType === "application/pdf").map((a) => ({ m, a })))
    .filter(({ a }) => !attachedNames.has(a.filename));

  return (
    <div className={`attach-box${drag ? " drag" : ""}`} aria-label="Attachments"
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void add(e.dataTransfer.files); }}>
      {files.length > 0 && (
        <ul className="attach-list">
          {files.map((f) => (
            <li key={f.id} className="attach-chip">
              <span aria-hidden>{icon(f.mime_type, f.filename)}</span>
              <a href={apiUrl(`/api/attachments/${f.id}/download`)} onClick={(e) => { e.preventDefault(); void download(f).catch((er) => toast((er as Error).message, "error")); }}>{f.filename}</a>
              <span className="muted small">{fileSize(f.size)}</span>
              <button className="btn ghost small" aria-label={`Remove ${f.filename}`} onClick={() => void remove(f)}>×</button>
            </li>))}
        </ul>)}
      <div className="row">
        <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && void add(e.target.files)} />
        <button type="button" className="btn small" disabled={!!uploading} onClick={() => input.current?.click()}>
          {uploading ? <><span className="spinner" /> Adding {uploading}…</> : "📎 Attach files"}</button>
        {files.length > 0 && <span className={`small ${total > LIMIT * 0.9 ? "error-text" : "muted"}`}>{fileSize(total)} of 25 MB</span>}
      </div>
      {received.length > 0 && (
        <div className="small" style={{ marginTop: ".4rem" }}>
          <span className="muted">From this conversation: </span>
          {received.map(({ m, a }) => (
            <button key={`${m.id}:${a.index}`} type="button" className="chip" disabled={!!uploading} onClick={() => void fromMessage(m.id, a.index, a.filename)}
              title={`Attach ${a.filename} (${fileSize(a.size)})`}>+ {a.filename}</button>))}
        </div>)}
    </div>
  );
}
