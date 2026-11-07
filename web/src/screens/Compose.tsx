/**
 * COMPOSE — write a new email (not a reply).
 * To / Cc / Bcc autocomplete from your contacts. Your text autosaves here as
 * you type; "Save to Gmail" puts it in Gmail's Drafts folder too. Claude can
 * write or polish it from a one-line instruction (you review the result).
 * Files and PDFs can be attached ("Attach files"). Send asks for
 * confirmation first, like replies. The list on the left (or at
 * the top on phones) holds the new emails you haven't sent yet.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApi, useLive, toast } from "../hooks";
import { go } from "../router";
import { when } from "../format";
import type { Address, ComposeDraft } from "../types";
import { RecipientInput } from "../components/RecipientInput";
import { SendDialog } from "../components/SendDialog";
import { Attachments } from "../components/Attachments";
import { ModelPicker, type ModelOption } from "../components/ModelPicker";

export function ComposeList({ selected }: { selected?: string }) {
  const list = useApi<ComposeDraft[]>("/api/compose");
  useLive(["compose"], () => void list.reload());
  const start = async () => { const c = await api<ComposeDraft>("/api/compose", { method: "POST", body: {} }); go(`/compose/${c.id}`); };
  return (
    <div>
      <div className="toolbar"><h1>Write</h1><button className="btn primary small" onClick={start}>✎ New email</button></div>
      {list.data && list.data.length === 0 && <div className="empty"><span className="big">✉︎</span>No unsent emails. Start one with New email.</div>}
      <ul className="compose-list" style={{ margin: 0, padding: 0 }}>
        {(list.data ?? []).map((c, i) => (
          <li key={c.id} className="trow" style={{ ["--i" as string]: i }}>
            <a href={`#/compose/${c.id}`} aria-current={c.id === selected ? "true" : undefined}>
              <div className="row"><strong style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.subject || "(no subject)"}</strong>
                <span className="muted small">{when(c.updated_at)}</span></div>
              <div className="muted small">{c.to.length ? `To ${c.to.map((a) => a.name || a.email).join(", ")}` : "No recipients yet"} {c.saved && <span className="badge ok">in Gmail</span>}</div>
            </a>
          </li>))}
      </ul>
    </div>
  );
}

export function ComposeEditor({ id, split }: { id: string; split?: boolean }) {
  const { data, error } = useApi<ComposeDraft>(`/api/compose/${id}`);
  const [to, setTo] = useState<Address[]>([]);
  const [cc, setCc] = useState<Address[]>([]);
  const [bcc, setBcc] = useState<Address[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [instruction, setInstruction] = useState("");
  const models = useApi<{ options: ModelOption[]; default: string }>("/api/models");
  const [model, setModel] = useState<string | null>(null);
  const chosen = model ?? models.data?.default ?? "sonnet";
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<"saved" | "saving" | "gmail" | null>(null);
  const [sending, setSending] = useState(false);
  const [notes, setNotes] = useState<{ open_questions: string[]; confidence: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loaded = useRef<string | null>(null);

  useEffect(() => {
    if (!data || loaded.current === data.id) return;
    loaded.current = data.id;
    setTo(data.to); setCc(data.cc); setBcc(data.bcc); setShowCc(data.cc.length + data.bcc.length > 0);
    setSubject(data.subject); setBody(data.body); setSaved(data.saved ? "gmail" : "saved");
  }, [data]);

  const patch = (p: Partial<{ to: Address[]; cc: Address[]; bcc: Address[]; subject: string; body: string }>, delay = 800) => {
    setSaved("saving");
    if (timer.current) clearTimeout(timer.current);
    const send = () => api(`/api/compose/${id}`, { method: "PUT", body: { to, cc, bcc, subject, body, ...p } }).then(() => setSaved("saved")).catch((e) => toast((e as Error).message, "error"));
    if (delay) timer.current = setTimeout(send, delay); else return send();
  };
  const flush = async () => { if (timer.current) clearTimeout(timer.current); await api(`/api/compose/${id}`, { method: "PUT", body: { to, cc, bcc, subject, body } }); setSaved("saved"); };
  const run = async (label: string, fn: () => Promise<unknown>) => { setBusy(label); try { await fn(); } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); } };

  if (error) return <div className="pane"><div className="banner error">{error}</div></div>;
  if (!data) return <div className="pane"><div className="skeleton" /><div className="skeleton" /></div>;
  const placeholders = /\[CONFIRM:/i.test(body);

  return (
    <div className="pane pane-anim" key={id}>
      <div className="toolbar">
        {!split && <button className="btn small" onClick={() => go("/compose")} aria-label="Back to list">‹</button>}
        <h2>{subject || "New email"}</h2>
        <span className="muted small" role="status">{saved === "saving" ? "Saving…" : saved === "gmail" ? "Saved in Gmail" : saved === "saved" ? "Saved" : ""}</span>
      </div>
      <div className="content">
        <div className="card">
          <div className="recips">
            <label htmlFor="c-to" className="muted" style={{ margin: 0, fontWeight: 500 }}>To</label>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <div style={{ flex: 1, minWidth: 0 }}><RecipientInput id="c-to" value={to} autoFocus={!data.to.length} placeholder="Name or email" onChange={(v) => { setTo(v); void patch({ to: v }, 0); }} /></div>
              {!showCc && <button className="btn ghost small" onClick={() => setShowCc(true)}>Cc/Bcc</button>}
            </div>
            {showCc && <>
              <label htmlFor="c-cc" className="muted" style={{ margin: 0, fontWeight: 500 }}>Cc</label>
              <RecipientInput id="c-cc" value={cc} onChange={(v) => { setCc(v); void patch({ cc: v }, 0); }} />
              <label htmlFor="c-bcc" className="muted" style={{ margin: 0, fontWeight: 500 }}>Bcc</label>
              <RecipientInput id="c-bcc" value={bcc} onChange={(v) => { setBcc(v); void patch({ bcc: v }, 0); }} />
            </>}
            <label htmlFor="c-subj" className="muted" style={{ margin: 0, fontWeight: 500 }}>Subject</label>
            <input id="c-subj" type="text" value={subject} onChange={(e) => { setSubject(e.target.value); patch({ subject: e.target.value }); }} />
          </div>
          <label htmlFor="c-body" className="sr-only">Message</label>
          <textarea id="c-body" className="draft-editor" style={{ marginTop: ".7rem" }} rows={14} spellCheck value={body} placeholder="Write your email… (your Gmail signature is added automatically)"
            onChange={(e) => { setBody(e.target.value); patch({ body: e.target.value }); }} />
          <Attachments kind="compose" owner={id} onChange={() => setSaved((s) => (s === "gmail" ? "saved" : s))} />
          {notes && notes.open_questions.length > 0 && <div className="small" style={{ marginTop: ".4rem" }}><strong>Check before sending:</strong><ul style={{ margin: ".2rem 0" }}>{notes.open_questions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>}
          <div className="row" style={{ marginTop: ".7rem" }}>
            <button className="btn" disabled={!!busy} onClick={() => run("save", async () => { await flush(); await api(`/api/compose/${id}/save`, { method: "POST" }); setSaved("gmail"); toast("Saved to Gmail drafts"); })}>
              {busy === "save" ? <span className="spinner" /> : "💾"} Save to Gmail</button>
            <button className="btn danger small" disabled={!!busy} onClick={() => { if (confirm("Discard this email? It is deleted from Gmail drafts too.")) void run("discard", async () => { await api(`/api/compose/${id}`, { method: "DELETE" }); toast("Discarded"); go("/compose"); }); }}>Discard</button>
            <span className="spacer" />
            <button className="btn primary" disabled={!!busy || !to.length || placeholders} title={placeholders ? "Fill in the [CONFIRM: …] placeholders first" : !to.length ? "Add a recipient" : undefined}
              onClick={async () => { await flush(); setSending(true); }}>Send…</button>
          </div>
          {placeholders && <p className="small muted">Fill in every [CONFIRM: …] placeholder before sending.</p>}
        </div>

        <div className="card ai-box">
          <h3>✨ Write it with Claude</h3>
          {models.data && <div style={{ marginBottom: ".5rem" }}><ModelPicker id="m-compose" options={models.data.options} value={chosen} onChange={setModel} /></div>}
          <p className="small muted" style={{ marginTop: 0 }}>Say what the email should say. Claude writes it in your voice{body.trim() ? " and keeps the facts from what you've written" : ""}; you review before anything is sent.</p>
          <div className="row">
            <input type="text" aria-label="Instruction for Claude" placeholder='e.g. "ask if they can move rehearsal to Thursday, friendly"' value={instruction}
              onChange={(e) => setInstruction(e.target.value)} style={{ flex: 1 }} onKeyDown={(e) => { if (e.key === "Enter" && instruction.trim()) (e.currentTarget.nextElementSibling as HTMLButtonElement)?.click(); }} />
            <button className="btn primary" disabled={!!busy || !instruction.trim()} onClick={() => run("write", async () => {
              await flush();
              const r = await api<{ compose: ComposeDraft; open_questions: string[]; confidence: string }>(`/api/compose/${id}/write`, { method: "POST", body: { instruction, model: chosen } });
              setBody(r.compose.body); setSubject(r.compose.subject); setNotes(r); setSaved("saved"); toast("Written — review it before sending");
            })}>{busy === "write" ? <><span className="spinner" /> Writing…</> : body.trim() ? "Polish" : "Write"}</button>
          </div>
        </div>
      </div>
      {sending && <SendDialog draftId={id} base={`/api/compose/${id}`} onClose={() => setSending(false)} onSent={() => { setSending(false); toast("Sent ✓"); go("/compose"); }} />}
    </div>
  );
}
