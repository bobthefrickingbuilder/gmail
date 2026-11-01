/**
 * THREAD VIEW — the conversation (quoted text collapsed), attachments,
 * the triage result with one-tap correction, the scheduling card, and the
 * draft panel. On wide landscape screens the draft sits in its own pane.
 */
import { useState } from "react";
import { api, apiUrl } from "../apiUrl";
import { useApi, useLive, useFlash } from "../hooks";
import { go } from "../router";
import { dateTime, who } from "../format";
import type { Message, ThreadDetail } from "../types";
import { DraftPanel } from "../components/DraftPanel";
import { SchedulingCard } from "../components/SchedulingCard";

function MessageCard({ m }: { m: Message }) {
  const [full, setFull] = useState(false);
  const hasQuoted = m.body_text && m.new_text && m.body_text.trim() !== m.new_text.trim();
  return (
    <article className={`card msg ${m.is_from_me ? "me" : ""}`} aria-label={`From ${m.is_from_me ? "you" : who({ name: m.from_name, email: m.from_email })}`}>
      <div className="head">
        <strong>{m.is_from_me ? "You" : who({ name: m.from_name, email: m.from_email })}</strong>
        <span className="muted small">{m.from_email}</span><span className="spacer" />
        <time className="muted small" dateTime={m.date}>{dateTime(m.date)}</time>
      </div>
      <div className="muted small">To: {m.to.map(who).join(", ")}{m.cc.length ? ` · Cc: ${m.cc.map(who).join(", ")}` : ""}</div>
      {m.invite && <p className="badge accent">Invitation: {m.invite.summary} · {m.invite.start ? dateTime(m.invite.start) : ""}{m.invite.location ? ` · ${m.invite.location}` : ""}</p>}
      {m.purged ? <p className="muted"><em>Body removed by your retention setting (still in Gmail).</em></p>
        : <pre className="mail" style={{ marginTop: ".5rem" }}>{full ? m.body_text : m.new_text}</pre>}
      {hasQuoted && !m.purged && <button className="btn ghost small quoted-toggle" aria-expanded={full} onClick={() => setFull(!full)}>{full ? "Hide quoted text" : "Show quoted text"}</button>}
      {m.attachments.filter((a) => !a.inline || a.mimeType === "application/pdf").map((a) => (
        <div className="att" key={a.index}>
          <span aria-hidden>📎</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <a href={apiUrl(`/api/messages/${m.id}/attachments/${a.index}`)} onClick={(e) => { e.preventDefault(); void downloadAttachment(m.id, a.index, a.filename); }}>{a.filename}</a>
            <span className="muted small"> · {Math.ceil(a.size / 1024)} KB</span>
            {a.preview && <details className="preview"><summary className="small">Preview text</summary><pre className="mail small">{a.preview}</pre></details>}
          </div>
        </div>
      ))}
    </article>
  );
}

async function downloadAttachment(messageId: string, index: number, filename: string) {
  const blob = await api<Blob>(`/api/messages/${messageId}/attachments/${index}`, { blob: true });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function TriageBox({ d, reload }: { d: ThreadDetail; reload: () => void }) {
  const t = d.triage;
  const { msg, flash } = useFlash();
  if (!t) return null;
  const cat = t.corrected_category ?? t.category;
  return (
    <section className="card" aria-label="Triage">
      <div className="row">
        <h3 style={{ margin: 0 }}>Triage</h3>
        {t.urgent && <span className="badge danger">Urgent</span>}
        <span className="badge">{t.stage === "rules" ? "rule" : "Haiku"}</span><span className="badge">priority {t.priority}</span>
        <span className="spacer" />
        <label className="sr-only" htmlFor="cat">Category</label>
        <select id="cat" value={cat} style={{ width: "auto" }} onChange={async (e) => { await api(`/api/threads/${d.thread.id}/triage`, { method: "POST", body: { category: e.target.value } }); flash("Thanks — future emails like this will be classified that way."); reload(); }}>
          {d.categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <p style={{ margin: ".4rem 0 0" }}>{t.summary}</p>
      <p className="muted small" style={{ margin: ".2rem 0 0" }}>{t.reasoning}{t.corrected_category ? ` (corrected by you from "${t.category}")` : ""}</p>
      {msg && <p className="small" role="status">{msg.text}</p>}
    </section>
  );
}

export function ThreadView({ id, split }: { id?: string; split?: boolean }) {
  const { data: d, error, reload } = useApi<ThreadDetail>(id ? `/api/threads/${id}` : null);
  useLive(["draft", "thread", "profile"], (e) => { if (!e.threadId || e.threadId === id) void reload(); });
  const [insert, setInsert] = useState<string | null>(null);

  if (!id) return <><div className="pane empty">Select an email.</div><div className="pane" /></>;
  if (error) return <div className="pane"><div className="banner error">{error}</div></div>;
  if (!d) return <div className="pane empty">Loading…</div>;

  const setState = async (state: string) => {
    await api(`/api/threads/${d.thread.id}/state`, { method: "POST", body: { state, ...(state === "snoozed" ? { snooze_until: new Date(Date.now() + 86400_000).toISOString() } : {}) } });
    go("/inbox");
  };
  const threadPane = (
    <div className="pane">
      <div className="toolbar">
        {!split && <button className="btn small" onClick={() => go("/inbox")} aria-label="Back to inbox">‹</button>}
        <h2>{d.thread.subject || "(no subject)"}</h2>
        <button className="btn small" onClick={() => setState("done")}>Done</button>
        <button className="btn small" onClick={() => setState("snoozed")}>Snooze</button>
      </div>
      <div className="content">
        {d.person && <p className="small"><a href={`#/person/${d.person.id}`}>{d.person.vip ? "★ " : ""}{d.person.display_name}</a>{d.person.organization ? ` · ${d.person.organization}` : ""}{d.person.relationship ? ` · ${d.person.relationship}` : ""}</p>}
        <TriageBox d={d} reload={reload} />
        {d.scheduling && <SchedulingCard card={d.scheduling} onInsert={setInsert} subject={d.thread.subject} />}
        {!split && d.versions.length > 0 && <p className="stack-only"><a href="#draft">Jump to draft ↓</a></p>}
        {d.messages.slice().reverse().map((m) => <MessageCard key={m.id} m={m} />)}
        {!split && <div id="draft"><DraftPanel d={d} reload={reload} insertText={insert} onInserted={() => setInsert(null)} /></div>}
      </div>
    </div>
  );
  if (!split) return threadPane;
  return <>{threadPane}<div className="pane"><div className="content"><DraftPanel d={d} reload={reload} insertText={insert} onInserted={() => setInsert(null)} /></div></div></>;
}
