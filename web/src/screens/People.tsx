/**
 * PEOPLE + PROFILE SCREEN — view and edit the profile, approve/reject the
 * model's proposed updates (shown as a diff), version history with revert,
 * merge with another person, split addresses off, pinned documents, your
 * private "notes to the assistant", and the email history with them.
 */
import { useState } from "react";
import { diffWords } from "diff";
import { api } from "../api";
import { useApi, useLive, useFlash } from "../hooks";
import { go } from "../router";
import { dateTime, when } from "../format";

interface PersonRow { id: string; display_name: string; organization: string | null; relationship: string | null; vip: boolean; last_contact_at: string | null; pending_update: boolean }
interface Snapshot { display_name: string; organization: string | null; role: string | null; relationship: string | null; formality: string | null; tone: string | null; language: string | null; summary: string;
  data: { topics: { topic: string; status: string }[]; commitments: { who: string; what: string; due: string | null }[]; facts: string[]; do_not_mention: string[]; response_expectations: string | null } }
interface PersonDetail {
  person: Snapshot & { id: string; notes_to_assistant: string; vip: boolean; escalate_model: string | null; signature_key: string | null; auto_apply_updates: number | null; last_contact_at: string | null };
  addresses: string[]; versions: { id: string; version: number; source: string; status: string; note: string | null; created_at: string; snapshot: Snapshot }[];
  docs: { id: string; title: string; content: string; created_at: string }[]; threads: { id: string; subject: string; last_message_at: string; category: string | null; state: string }[];
}

export function People() {
  const [q, setQ] = useState("");
  const { data } = useApi<PersonRow[]>(`/api/people${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  return (
    <div>
      <div className="toolbar"><h1>People</h1></div>
      <div className="content">
        <input type="search" placeholder="Search people" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul style={{ listStyle: "none", padding: 0 }}>
          {data?.map((p) => (
            <li key={p.id} className="card" style={{ cursor: "pointer" }} onClick={() => go(`/person/${p.id}`)} onKeyDown={(e) => e.key === "Enter" && go(`/person/${p.id}`)} tabIndex={0} role="link">
              <div className="row"><strong style={{ flex: 1 }}>{p.vip ? "★ " : ""}{p.display_name}</strong>{p.pending_update && <span className="badge warn">update to review</span>}
                {p.last_contact_at && <span className="muted small">{when(p.last_contact_at)}</span>}</div>
              <div className="muted small">{[p.organization, p.relationship].filter(Boolean).join(" · ")}</div>
            </li>))}
          {data?.length === 0 && <li className="empty">No people yet. Run the import from Settings → Onboarding.</li>}
        </ul>
      </div>
    </div>
  );
}

const summaryText = (s: Snapshot) => [s.summary, s.data?.topics?.length ? `Topics: ${s.data.topics.map((t) => `${t.topic} [${t.status}]`).join("; ")}` : "",
  s.data?.commitments?.length ? `Commitments: ${s.data.commitments.map((c) => `${c.who}: ${c.what}${c.due ? ` (${c.due})` : ""}`).join("; ")}` : "",
  s.data?.facts?.length ? `Facts: ${s.data.facts.join("; ")}` : ""].filter(Boolean).join("\n");

function Diff({ a, b }: { a: string; b: string }) {
  return <pre className="mail diff small">{diffWords(a, b).map((p, i) => p.added ? <ins key={i}>{p.value}</ins> : p.removed ? <del key={i}>{p.value}</del> : <span key={i}>{p.value}</span>)}</pre>;
}
const lines = (a: string[]) => a.join("\n");
const unlines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export function PersonView({ id }: { id: string }) {
  const { data, reload, error } = useApi<PersonDetail>(`/api/people/${id}`);
  useLive(["profile"], (e) => { if (!e.personId || e.personId === id) void reload(); });
  const [edit, setEdit] = useState<Record<string, unknown> | null>(null);
  const [mergeQ, setMergeQ] = useState("");
  const candidates = useApi<PersonRow[]>(mergeQ.length > 1 ? `/api/people?q=${encodeURIComponent(mergeQ)}` : null);
  const [doc, setDoc] = useState({ title: "", content: "" });
  const { msg, flash } = useFlash();
  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;
  const p = data.person;
  const proposed = data.versions.find((v) => v.status === "proposed");
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); flash(ok); await reload(); } catch (e) { flash((e as Error).message, "error"); } };
  const startEdit = () => setEdit({ display_name: p.display_name, organization: p.organization ?? "", role: p.role ?? "", relationship: p.relationship ?? "", formality: p.formality ?? "",
    tone: p.tone ?? "", language: p.language ?? "", summary: p.summary, facts: lines(p.data.facts ?? []), do_not_mention: lines(p.data.do_not_mention ?? []),
    response_expectations: p.data.response_expectations ?? "", notes_to_assistant: p.notes_to_assistant, vip: p.vip, escalate_model: p.escalate_model ?? "", signature_key: p.signature_key ?? "" });
  const save = () => run(() => api(`/api/people/${id}`, { method: "PUT", body: {
    display_name: edit!.display_name, organization: edit!.organization || null, role: edit!.role || null, relationship: edit!.relationship || null,
    formality: edit!.formality || null, tone: edit!.tone || null, language: edit!.language || null, summary: edit!.summary, notes_to_assistant: edit!.notes_to_assistant,
    vip: edit!.vip, escalate_model: edit!.escalate_model || null, signature_key: edit!.signature_key || null,
    data: { facts: unlines(String(edit!.facts)), do_not_mention: unlines(String(edit!.do_not_mention)), response_expectations: (edit!.response_expectations as string) || null } } }).then(() => setEdit(null)), "Profile saved");
  const F = (k: string, label: string, area = false) => <><label htmlFor={`f-${k}`}>{label}</label>{area
    ? <textarea id={`f-${k}`} rows={k === "summary" ? 6 : 3} value={String(edit![k] ?? "")} onChange={(e) => setEdit({ ...edit!, [k]: e.target.value })} />
    : <input id={`f-${k}`} type="text" value={String(edit![k] ?? "")} onChange={(e) => setEdit({ ...edit!, [k]: e.target.value })} />}</>;

  return (
    <div>
      <div className="toolbar"><button className="btn small" onClick={() => go("/people")} aria-label="Back">‹</button><h1>{p.vip ? "★ " : ""}{p.display_name}</h1>
        {!edit && <button className="btn small" onClick={startEdit}>Edit</button>}</div>
      <div className="content">
        {msg && <div className={`banner ${msg.kind === "error" ? "error" : "info"}`} role="status">{msg.text}</div>}
        {proposed && (
          <section className="card" aria-label="Proposed update" style={{ borderColor: "var(--warn)" }}>
            <h3>Proposed update (v{proposed.version}, {proposed.source})</h3>
            <Diff a={summaryText(p)} b={summaryText(proposed.snapshot)} />
            {proposed.note && <p className="small muted">{proposed.note}</p>}
            <div className="row"><button className="btn primary" onClick={() => run(() => api(`/api/people/${id}/versions/${proposed.id}/apply`, { method: "POST" }), "Applied")}>Apply</button>
              <button className="btn" onClick={() => run(() => api(`/api/people/${id}/versions/${proposed.id}/reject`, { method: "POST" }), "Rejected")}>Reject</button></div>
          </section>)}
        {edit ? (
          <section className="card">
            {F("display_name", "Name")}{F("organization", "Organization")}{F("role", "Role")}{F("relationship", "Relationship (conductor, publisher, parent of a student…)")}
            <div className="row"><div style={{ flex: 1 }}><label htmlFor="f-formality">Formality</label><select id="f-formality" value={String(edit.formality)} onChange={(e) => setEdit({ ...edit, formality: e.target.value })}><option value="">—</option><option>formal</option><option>neutral</option><option>casual</option></select></div>
              <div style={{ flex: 1 }}><label htmlFor="f-language">Language</label><select id="f-language" value={String(edit.language)} onChange={(e) => setEdit({ ...edit, language: e.target.value })}><option value="">Auto (match email)</option><option value="en">English</option><option value="fr">French</option></select></div></div>
            {F("tone", "Preferred tone")}{F("summary", "Profile summary (150–300 words)", true)}{F("facts", "Key facts (one per line)", true)}{F("do_not_mention", "Do not mention (one per line)", true)}
            {F("response_expectations", "Response expectations")}{F("notes_to_assistant", "Notes to the assistant (never changed by the model)", true)}
            <label className="inline"><input type="checkbox" checked={Boolean(edit.vip)} onChange={(e) => setEdit({ ...edit, vip: e.target.checked })} /> VIP (always notify, higher priority)</label>
            <div className="row"><div style={{ flex: 1 }}><label htmlFor="f-esc">Always draft with</label><select id="f-esc" value={String(edit.escalate_model)} onChange={(e) => setEdit({ ...edit, escalate_model: e.target.value })}><option value="">Default</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select></div>
              <div style={{ flex: 1 }}><label htmlFor="f-sig">Signature group</label><input id="f-sig" type="text" placeholder="e.g. oryc, casual, gmail" value={String(edit.signature_key)} onChange={(e) => setEdit({ ...edit, signature_key: e.target.value })} /></div></div>
            <p className="small muted">Health, financial account and government ID details are filtered out automatically.</p>
            <div className="row"><button className="btn primary" onClick={save}>Save</button><button className="btn" onClick={() => setEdit(null)}>Cancel</button></div>
          </section>
        ) : (
          <section className="card">
            <p className="muted small">{[p.organization, p.role, p.relationship, p.formality, p.language && (p.language === "fr" ? "French" : "English")].filter(Boolean).join(" · ")}</p>
            <p>{p.summary || <span className="muted">No summary yet.</span>}</p>
            {p.data.topics?.length > 0 && <><strong className="small">Topics</strong><ul className="small">{p.data.topics.map((t, i) => <li key={i}>{t.topic} <span className="badge">{t.status.replace(/_/g, " ")}</span></li>)}</ul></>}
            {p.data.commitments?.length > 0 && <><strong className="small">Commitments</strong><ul className="small">{p.data.commitments.map((c, i) => <li key={i}>{c.who === "matthew" ? "You" : "They"}: {c.what}{c.due ? ` — ${c.due}` : ""}</li>)}</ul></>}
            {p.data.facts?.length > 0 && <><strong className="small">Key facts</strong><ul className="small">{p.data.facts.map((f, i) => <li key={i}>{f}</li>)}</ul></>}
            {p.data.do_not_mention?.length > 0 && <><strong className="small">Do not mention</strong><ul className="small">{p.data.do_not_mention.map((f, i) => <li key={i}>{f}</li>)}</ul></>}
            {p.notes_to_assistant && <><strong className="small">Your notes to the assistant</strong><pre className="mail small">{p.notes_to_assistant}</pre></>}
          </section>)}

        <section className="card"><h3>Addresses</h3>
          <ul className="small">{data.addresses.map((a) => <li key={a} className="row"><span style={{ flex: 1 }}>{a}</span>
            {data.addresses.length > 1 && <button className="btn small" onClick={() => run(() => api(`/api/people/${id}/split`, { method: "POST", body: { emails: [a] } }), "Split into a new person")}>Split off</button>}</li>)}</ul>
          <label htmlFor="merge">Merge another person into this one</label>
          <input id="merge" type="search" placeholder="Search name or address" value={mergeQ} onChange={(e) => setMergeQ(e.target.value)} />
          {candidates.data?.filter((c) => c.id !== id).slice(0, 5).map((c) => <div key={c.id} className="row small" style={{ marginTop: ".3rem" }}><span style={{ flex: 1 }}>{c.display_name}</span>
            <button className="btn small" onClick={() => { if (confirm(`Merge ${c.display_name} into ${p.display_name}?`)) void run(() => api(`/api/people/${id}/merge`, { method: "POST", body: { sourceId: c.id } }), "Merged"); }}>Merge</button></div>)}
        </section>

        <section className="card"><h3>Pinned documents</h3>
          <p className="small muted">Included in the prompt whenever this person writes (e.g. a contract summary or repertoire list).</p>
          {data.docs.map((d) => <details key={d.id}><summary>{d.title}</summary><pre className="mail small">{d.content}</pre>
            <button className="btn small danger" onClick={() => run(() => api(`/api/people/${id}/docs/${d.id}`, { method: "DELETE" }), "Removed")}>Remove</button></details>)}
          <label htmlFor="dt">Title</label><input id="dt" type="text" value={doc.title} onChange={(e) => setDoc({ ...doc, title: e.target.value })} />
          <label htmlFor="dc">Content</label><textarea id="dc" rows={4} value={doc.content} onChange={(e) => setDoc({ ...doc, content: e.target.value })} />
          <p><button className="btn" disabled={!doc.title || !doc.content} onClick={() => run(() => api(`/api/people/${id}/docs`, { method: "POST", body: doc }).then(() => setDoc({ title: "", content: "" })), "Pinned")}>Pin document</button></p>
        </section>

        <section className="card"><h3>Version history</h3>
          <ul style={{ listStyle: "none", padding: 0 }}>{data.versions.map((v) => <li key={v.id} className="row small" style={{ borderBottom: "1px solid var(--line)", padding: ".3rem 0" }}>
            <span className="badge">v{v.version}</span><span className="badge">{v.source}</span><span className={`badge ${v.status === "applied" ? "ok" : v.status === "proposed" ? "warn" : ""}`}>{v.status}</span>
            <span className="muted" style={{ flex: 1 }}>{dateTime(v.created_at)}{v.note ? ` · ${v.note}` : ""}</span>
            {v.status !== "applied" && v.status !== "proposed" && <button className="btn small" onClick={() => run(() => api(`/api/people/${id}/versions/${v.id}/revert`, { method: "POST" }), `Reverted to v${v.version}`)}>Revert</button>}</li>)}</ul>
        </section>

        <section className="card"><h3>Email history</h3>
          <ul style={{ listStyle: "none", padding: 0 }}>{data.threads.map((t) => <li key={t.id}><a href={`#/thread/${t.id}`}>{t.subject || "(no subject)"}</a> <span className="muted small">{when(t.last_message_at)} · {t.category ?? ""}</span></li>)}</ul>
        </section>
        <p><button className="btn danger" onClick={() => { if (confirm(`Delete ${p.display_name}'s profile and all derived data? (Emails stay in Gmail.)`)) void api(`/api/people/${id}`, { method: "DELETE" }).then(() => go("/people")); }}>Delete profile</button></p>
      </div>
    </div>
  );
}
