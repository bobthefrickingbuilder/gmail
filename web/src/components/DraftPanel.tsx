/**
 * DRAFT PANEL
 * Edit the draft, see the model badge / confidence / flags / open questions,
 * pick the model (Haiku, Sonnet or Opus) for each draft or redraft, add an instruction, compare and
 * revert versions, choose reply vs reply-all and the signature, then
 * attach files, then Save to Gmail, Copy, Open in Gmail, or Send (with a
 * confirmation dialog).
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useFlash } from "../hooks";
import { dateTime, flagLabel, modelLabel, money } from "../format";
import type { Address, ThreadDetail, Version } from "../types";
import { CompareView } from "./CompareView";
import { SendDialog } from "./SendDialog";
import { RecipientInput } from "./RecipientInput";
import { Attachments } from "./Attachments";
import { ModelPicker } from "./ModelPicker";

/** Voice dictation hook (v1: uses the browser's speech recognition where available). */
function useDictation(onText: (t: string) => void) {
  const SR = (window as unknown as { webkitSpeechRecognition?: new () => { lang: string; onresult: (e: { results: { 0: { transcript: string } }[] }) => void; start: () => void } }).webkitSpeechRecognition;
  if (!SR) return null;
  return () => { const r = new SR(); r.lang = navigator.language; r.onresult = (e) => onText(e.results[0][0].transcript); r.start(); };
}

export function DraftPanel({ d, reload, insertText, onInserted }: { d: ThreadDetail; reload: () => void; insertText: string | null; onInserted: () => void }) {
  const current: Version | undefined = d.versions.find((v) => v.id === d.draft?.current_version_id) ?? d.versions[0];
  const [body, setBody] = useState(current?.body ?? "");
  const [subject, setSubject] = useState(current?.subject ?? "");
  const [to, setTo] = useState<Address[]>(d.draft?.to ?? []);
  const [cc, setCc] = useState<Address[]>(d.draft?.cc ?? []);
  const [instruction, setInstruction] = useState("");
  const [model, setModel] = useState(d.buttons.selected);
  const [busy, setBusy] = useState<string | null>(null);
  const [compare, setCompare] = useState<[Version, Version] | null>(null);
  const [sending, setSending] = useState(false);
  const { msg, flash } = useFlash();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dictate = useDictation((t) => setInstruction((i) => (i ? `${i} ${t}` : t)));

  useEffect(() => { setBody(current?.body ?? ""); setSubject(current?.subject ?? ""); }, [current?.id]);
  useEffect(() => { setModel(d.buttons.selected); }, [d.thread.id, d.buttons.selected]);
  const modelName = (k: string) => d.buttons.options.find((o) => o.key === k)?.label ?? k;
  useEffect(() => { setTo(d.draft?.to ?? []); setCc(d.draft?.cc ?? []); }, [d.draft?.id, d.draft?.reply_mode, JSON.stringify(d.draft?.to)]);
  useEffect(() => { if (insertText) { setBody((b) => insertAvailability(b, insertText)); onInserted(); } }, [insertText]);

  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label);
    try { await fn(); if (ok) flash(ok); reload(); } catch (e) { flash((e as Error).message, "error"); } finally { setBusy(null); }
  };
  const draft = (m: string) => run("draft", () => api(`/api/threads/${d.thread.id}/draft`, { method: "POST", body: { model: m, instruction: instruction || null } }), `Drafted with ${modelLabel(m)}`);
  const saveEdits = async (recips: { to?: Address[]; cc?: Address[] } = {}) => {
    if (!d.draft) return;
    const r = await api<{ queued?: boolean }>(`/api/drafts/${d.draft.id}`, { method: "PUT", offlineQueue: true, body: { body, subject, to: recips.to ?? to, cc: recips.cc ?? cc } });
    return r;
  };
  const onBodyChange = (v: string) => {
    setBody(v);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveEdits(), 1500);
  };

  if (!d.draft || !current) {
    return (
      <section className="card" aria-label="Draft">
        <h3>No draft yet</h3>
        <label htmlFor="ins">Instruction (optional)</label>
        <div className="row"><input id="ins" type="text" placeholder="e.g. decline politely, firmer tone" value={instruction} onChange={(e) => setInstruction(e.target.value)} style={{ flex: 1 }} />
          {dictate && <button className="btn small" onClick={dictate} aria-label="Dictate instruction">🎤</button>}</div>
        <div style={{ marginTop: ".6rem" }}><ModelPicker id="m-new" options={d.buttons.options} value={model} onChange={setModel} /></div>
        <div className="row" style={{ marginTop: ".6rem" }}>
          <button className="btn primary" disabled={!!busy} onClick={() => draft(model)}>{busy ? <><span className="spinner" /> Drafting with {modelName(model)}…</> : `Draft with ${modelName(model)}`}</button>
        </div>
        {msg && <p className={msg.kind === "error" ? "error-text" : "small"} role="status">{msg.text}</p>}
      </section>
    );
  }

  const draftId = d.draft.id;
  const placeholders = /\[CONFIRM:/i.test(body);
  return (
    <section aria-label="Draft">
      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>Draft</h3>
          {current.model_key && <span className="badge ok">{modelLabel(current.model_key)}</span>}
          {current.origin === "user" && <span className="badge">your edit</span>}
          <span className="badge">v{current.version} · {dateTime(current.created_at)}</span>
          {current.confidence && <span className={`badge ${current.confidence === "high" ? "ok" : current.confidence === "low" ? "danger" : "warn"}`}>confidence: {current.confidence}</span>}
          {d.draft.status === "saved" && <span className="badge accent">saved to Gmail</span>}
        </div>
        {current.flags.length > 0 && <div className="row" style={{ marginTop: ".4rem" }}>{current.flags.map((f) => <span key={f} className={`badge ${f.includes("injection") || f.includes("schedule") ? "danger" : "warn"}`}>⚠ {flagLabel(f)}</span>)}</div>}
        {current.open_questions.length > 0 && <div style={{ marginTop: ".5rem" }}><strong className="small">Open questions</strong><ul className="small" style={{ margin: ".2rem 0" }}>{current.open_questions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>}

        <div className="recips" style={{ marginTop: ".6rem" }}>
          <span className="muted">Mode</span>
          <div className="row">
            {(["reply", "reply_all"] as const).map((m) => <button key={m} className="chip" aria-pressed={d.draft!.reply_mode === m}
              onClick={() => run("mode", () => api(`/api/drafts/${draftId}`, { method: "PUT", body: { reply_mode: m } }))}>{m === "reply" ? "Reply" : "Reply all"}</button>)}
          </div>
          <label htmlFor="to" className="muted" style={{ margin: 0, fontWeight: 400 }}>To</label>
          <RecipientInput id="to" value={to} onChange={(v) => { setTo(v); void saveEdits({ to: v }); }} />
          <label htmlFor="cc" className="muted" style={{ margin: 0, fontWeight: 400 }}>Cc</label>
          <RecipientInput id="cc" value={cc} onChange={(v) => { setCc(v); void saveEdits({ cc: v }); }} />
          <label htmlFor="subj" className="muted" style={{ margin: 0, fontWeight: 400 }}>Subject</label>
          <input id="subj" type="text" value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={() => void saveEdits()} />
        </div>
        <label htmlFor="body" className="sr-only">Draft text</label>
        <textarea id="body" className="draft-editor" style={{ marginTop: ".6rem" }} value={body} onChange={(e) => onBodyChange(e.target.value)} rows={14} spellCheck lang={d.person?.language ?? undefined} />
        <Attachments kind="reply" owner={draftId} sources={d.messages} />
        <div className="row small" style={{ marginTop: ".3rem" }}>
          <label className="inline" htmlFor="sig">Signature</label>
          <select id="sig" style={{ width: "auto" }} value={d.draft.signature_key ?? ""} onChange={(e) => run("sig", () => api(`/api/drafts/${draftId}`, { method: "PUT", body: { signature_key: e.target.value || null } }))}>
            <option value="">Automatic</option>{d.signatures.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <label className="inline"><input type="checkbox" checked={d.draft.share_schedule_details}
            onChange={(e) => run("share", () => api(`/api/drafts/${draftId}`, { method: "PUT", body: { share_schedule_details: e.target.checked } }), e.target.checked ? "Next redraft may mention event details" : undefined)} /> Allow event details in this draft</label>
        </div>

        <div className="row" style={{ marginTop: ".7rem" }}>
          <button className="btn" disabled={!!busy} onClick={() => run("save", async () => { await saveEdits(); await api(`/api/drafts/${draftId}/save`, { method: "POST" }); }, "Saved to Gmail drafts")}>Save to Gmail</button>
          <button className="btn" onClick={() => navigator.clipboard.writeText(body).then(() => flash("Copied"))}>Copy</button>
          <a className="btn" href={`https://mail.google.com/mail/u/0/#drafts`} target="_blank" rel="noreferrer">Open in Gmail</a>
          <span className="spacer" />
          <button className="btn primary" disabled={!!busy || placeholders} title={placeholders ? "Resolve the [CONFIRM: …] placeholders first" : undefined}
            onClick={async () => { await saveEdits(); setSending(true); }}>Send…</button>
        </div>
        {placeholders && <p className="small muted">Fill in every [CONFIRM: …] placeholder before sending.</p>}
        {msg && <p className={msg.kind === "error" ? "error-text" : "small"} role="status">{msg.text}</p>}
      </div>

      <div className="card">
        <h3>Redraft</h3>
        <label htmlFor="ins2">Instruction (optional)</label>
        <div className="row"><input id="ins2" type="text" placeholder="e.g. decline politely, shorter, firmer tone" value={instruction} onChange={(e) => setInstruction(e.target.value)} style={{ flex: 1 }} />
          {dictate && <button className="btn small" onClick={dictate} aria-label="Dictate instruction">🎤</button>}</div>
        <div style={{ marginTop: ".6rem" }}><ModelPicker id="m-re" options={d.buttons.options} value={model} onChange={setModel} /></div>
        <div className="row" style={{ marginTop: ".6rem" }}>
          <button className="btn primary" disabled={!!busy} onClick={() => draft(model)}>{busy === "draft" ? <><span className="spinner" /> Drafting with {modelName(model)}…</> : `Redraft with ${modelName(model)}`}</button>
          <span className="spacer" />
          <button className="btn danger small" onClick={() => { if (confirm("Discard this draft? It will be deleted from Gmail drafts too.")) void run("discard", () => api(`/api/drafts/${draftId}`, { method: "DELETE" }), "Draft discarded"); }}>Discard</button>
        </div>
      </div>

      {current.calendar_actions.length > 0 && (
        <div className="card"><h3>Suggested calendar entries</h3>
          {current.calendar_actions.map((a, i) => (
            <div key={i} className="row" style={{ marginBottom: ".3rem" }}>
              <span style={{ flex: 1 }}>{a.title} · {dateTime(a.start)}</span>
              <button className="btn small" onClick={() => run("cal", () => api("/api/calendar/events", { method: "POST", body: { title: a.title, kind: a.kind, start: a.start, end: a.end } }), "Tentative event added")}>Add to calendar</button>
            </div>))}
        </div>
      )}

      <div className="card">
        <h3>Versions</h3>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {d.versions.map((v, i) => (
            <li key={v.id} className="row" style={{ borderBottom: "1px solid var(--line)", padding: ".35rem 0" }}>
              <span className="badge">v{v.version}</span><span className={`badge ${v.model_key ? "ok" : ""}`}>{v.model_key ? modelLabel(v.model_key) : "you"}</span>
              <span className="small muted" style={{ flex: 1 }}>{dateTime(v.created_at)}{v.instruction ? ` · “${v.instruction}”` : ""}{v.cost_usd ? ` · ${money(v.cost_usd)}` : ""}</span>
              {v.id === current.id ? <span className="badge accent">current</span> : <button className="btn small" onClick={() => run("revert", () => api(`/api/drafts/${draftId}/revert`, { method: "POST", body: { versionId: v.id } }), `Reverted to v${v.version}`)}>Revert</button>}
              {i < d.versions.length - 1 && <button className="btn small" onClick={() => setCompare([d.versions[i + 1], v])}>Compare</button>}
            </li>))}
        </ul>
      </div>
      {compare && <CompareView a={compare[0]} b={compare[1]} onClose={() => setCompare(null)} />}
      {sending && <SendDialog draftId={draftId} onClose={() => setSending(false)} onSent={() => { setSending(false); flash("Sent"); reload(); }} />}
    </section>
  );
}

/** Insert availability text at the [CONFIRM: availability] placeholder, else after the first paragraph. */
export function insertAvailability(body: string, text: string): string {
  if (/\[CONFIRM:[^\]]*availab[^\]]*\]/i.test(body)) return body.replace(/\[CONFIRM:[^\]]*availab[^\]]*\]/i, text);
  const parts = body.split(/\n\n/);
  if (parts.length > 1) { parts.splice(1, 0, text); return parts.join("\n\n"); }
  return `${body}\n\n${text}`;
}
