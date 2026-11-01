/**
 * SCHEDULING CARD — appears above the draft when an email proposes times or
 * asks for availability. Shows each proposed time as free / conflict against
 * your calendar, suggests free slots, inserts availability into the draft,
 * and can add a TENTATIVE event (only when you tap the button).
 */
import { useState } from "react";
import { api } from "../api";
import { dateTime } from "../format";
import type { ThreadDetail } from "../types";

export function SchedulingCard({ card, onInsert, subject }: { card: NonNullable<ThreadDetail["scheduling"]>; onInsert: (text: string) => void; subject: string }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [kind, setKind] = useState(/rehears|répét/i.test(subject) ? "rehearsal" : /concert/i.test(subject) ? "concert" : "meeting");
  const [msg, setMsg] = useState<string | null>(null);
  const toggle = (label: string) => setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
  const addEvent = async (start: string, end: string | null) => {
    try {
      const r = await api<{ summary: string }>("/api/calendar/events", { method: "POST", body: { title: subject.replace(/^(re|ré|fwd?):\s*/i, ""), kind, start, end, durationMinutes: card.durationMinutes } });
      setMsg(`Tentative event added: ${r.summary}`);
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <section className="card" aria-label="Scheduling">
      <h3>Scheduling · {card.kind.replace(/_/g, " ")} · {card.durationMinutes} min</h3>
      {card.proposed.length > 0 && <ul style={{ paddingLeft: "1.1rem", margin: "0 0 .5rem" }}>
        {card.proposed.map((p, i) => (
          <li key={i} className="row">
            <span style={{ flex: 1 }}>{p.text}{p.start ? ` (${dateTime(p.start)})` : ""}</span>
            <span className={`badge ${p.status === "free" ? "ok" : p.status === "conflict" ? "danger" : ""}`}>{p.status}</span>
            {p.start && <button className="btn small" onClick={() => addEvent(p.start!, p.end)}>Add tentative</button>}
          </li>))}
      </ul>}
      <div className="small muted">Free slots ({card.timezone}) — select to insert:</div>
      <div className="chips" style={{ padding: ".3rem 0", flexWrap: "wrap" }}>
        {card.suggestions.length === 0 && <span className="muted small">No free slots in range.</span>}
        {card.suggestions.map((s) => <button key={s.start} className="chip" aria-pressed={picked.includes(s.label)} onClick={() => toggle(s.label)}>{s.label}</button>)}
      </div>
      <div className="row">
        <button className="btn small" disabled={!picked.length} onClick={() => onInsert(`I am free ${picked.join("; ")}.`)}>Insert availability into draft</button>
        <label className="inline small">Event type
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: "auto" }}>
            <option value="rehearsal">Rehearsal</option><option value="concert">Concert</option><option value="meeting">Meeting</option><option value="lesson">Lesson</option><option value="other">Other</option>
          </select></label>
        {picked.length === 1 && <button className="btn small" onClick={() => { const s = card.suggestions.find((x) => x.label === picked[0])!; void addEvent(s.start, null); }}>Add tentative event</button>}
      </div>
      {msg && <p className="small" role="status">{msg}</p>}
    </section>
  );
}
