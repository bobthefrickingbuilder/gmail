/**
 * SEND CONFIRMATION — shows exactly what will go out (from, to, cc, subject,
 * attached files, first lines). Sending needs this explicit second tap; the server rejects
 * a send without the one-time token this dialog receives.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { flagLabel } from "../format";
import type { Address } from "../types";
import { fileSize } from "./Attachments";

const full = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email);
interface Prep { token: string; expiresInSeconds: number; from: string; to: Address[]; cc: Address[]; bcc?: Address[]; subject: string; preview: string; flags: string[]; hasPlaceholders: boolean;
  attachments?: { filename: string; size: number; mime_type: string }[] }

/** base: the draft's API path; replies use /api/drafts/:id, new emails /api/compose/:id. */
export function SendDialog({ draftId, base = `/api/drafts/${draftId}`, onClose, onSent }: { draftId: string; base?: string; onClose: () => void; onSent: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [prep, setPrep] = useState<Prep | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(120);
  useEffect(() => {
    ref.current?.showModal();
    api<Prep>(`${base}/send/prepare`, { method: "POST" }).then((p) => { setPrep(p); setLeft(p.expiresInSeconds); }).catch((e) => setErr((e as Error).message));
  }, [base]);
  useEffect(() => { const t = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000); return () => clearInterval(t); }, []);
  const send = async () => {
    if (!prep) return;
    setBusy(true);
    try { await api(`${base}/send`, { method: "POST", body: { token: prep.token, confirm: true } }); onSent(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="sd">
      <div className="dlg">
        <h2 id="sd" style={{ marginTop: 0 }}>Send this email?</h2>
        {err && <p className="error-text" role="alert">{err}</p>}
        {prep ? <>
          <table><tbody>
            <tr><th scope="row">From</th><td>{prep.from}</td></tr>
            <tr><th scope="row">To</th><td>{prep.to.map(full).join(", ")}</td></tr>
            {prep.cc.length > 0 && <tr><th scope="row">Cc</th><td>{prep.cc.map(full).join(", ")}</td></tr>}
            {(prep.bcc?.length ?? 0) > 0 && <tr><th scope="row">Bcc</th><td>{prep.bcc!.map(full).join(", ")}</td></tr>}
            <tr><th scope="row">Subject</th><td>{prep.subject}</td></tr>
            {(prep.attachments?.length ?? 0) > 0 && <tr><th scope="row">Files</th><td>{prep.attachments!.map((a) => `📎 ${a.filename} (${fileSize(a.size)})`).join(", ")}</td></tr>}
          </tbody></table>
          <pre className="mail card small" style={{ marginTop: ".6rem" }}>{prep.preview}{"\n…"}</pre>
          {prep.flags.length > 0 && <p className="small">{prep.flags.map((f) => <span key={f} className="badge warn" style={{ marginRight: ".3rem" }}>⚠ {flagLabel(f)}</span>)}</p>}
          {prep.hasPlaceholders && <p className="error-text">This draft still has [CONFIRM: …] placeholders.</p>}
          <p className="small muted">Confirmation expires in {left}s.</p>
        </> : !err && <p>Preparing…</p>}
        <div className="row">
          <button className="btn" onClick={() => ref.current?.close()}>Cancel</button><span className="spacer" />
          <button className="btn primary" disabled={!prep || busy || left === 0 || prep.hasPlaceholders} onClick={send}>{busy ? "Sending…" : "Send now"}</button>
        </div>
      </div>
    </dialog>
  );
}
