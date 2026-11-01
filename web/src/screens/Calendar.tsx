/**
 * CALENDAR — agenda and week views from Google Calendar (the source of
 * truth), a preview of free slots, and quick-add (creates a tentative event).
 */
import { useMemo, useState } from "react";
import { api } from "../api";
import { useApi, useFlash } from "../hooks";

interface Ev { id: string; summary: string; start: string; end: string; allDay: boolean; location: string | null; status: string }
const startOfWeek = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const t = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function CalendarView() {
  const [mode, setMode] = useState<"agenda" | "week">("week");
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const from = anchor, to = new Date(anchor.getTime() + (mode === "week" ? 7 : 14) * 86400_000);
  const ev = useApi<Ev[]>(`/api/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`);
  const [duration, setDuration] = useState(60);
  const fromDay = from.toLocaleDateString("en-CA"), toDay = new Date(to.getTime() - 86400_000).toLocaleDateString("en-CA");
  const av = useApi<{ slots: { start: string; end: string; label: string }[]; timezone: string }>(`/api/calendar/availability?from=${fromDay}&to=${toDay}&duration=${duration}`);
  const [qa, setQa] = useState({ title: "", start: "", minutes: 120, kind: "rehearsal" });
  const { msg, flash } = useFlash();
  const days = useMemo(() => Array.from({ length: mode === "week" ? 7 : 14 }, (_, i) => new Date(anchor.getTime() + i * 86400_000)), [anchor, mode]);
  const onDay = <T extends { start: string }>(d: Date, items: T[]): T[] => items.filter((e) => new Date(e.start).toDateString() === d.toDateString());

  return (
    <div>
      <div className="toolbar"><h1>Calendar</h1>
        <button className="chip" aria-pressed={mode === "week"} onClick={() => setMode("week")}>Week</button>
        <button className="chip" aria-pressed={mode === "agenda"} onClick={() => setMode("agenda")}>Agenda</button></div>
      <div className="content" style={{ maxWidth: 1200 }}>
        <div className="row" style={{ marginBottom: ".6rem" }}>
          <button className="btn small" onClick={() => setAnchor(new Date(anchor.getTime() - 7 * 86400_000))} aria-label="Previous week">‹</button>
          <button className="btn small" onClick={() => setAnchor(startOfWeek(new Date()))}>Today</button>
          <button className="btn small" onClick={() => setAnchor(new Date(anchor.getTime() + 7 * 86400_000))} aria-label="Next week">›</button>
          <strong>{from.toLocaleDateString([], { month: "long", day: "numeric" })} – {new Date(to.getTime() - 1).toLocaleDateString([], { month: "long", day: "numeric" })}</strong>
          <span className="spacer" />
          <label className="inline small">Free slots of <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} style={{ width: "auto" }}>{[30, 60, 90, 120, 180].map((m) => <option key={m} value={m}>{m} min</option>)}</select></label>
        </div>
        {ev.error && <div className="banner error">{ev.error}</div>}
        {mode === "week" ? (
          <div className="week">{days.map((d) => (
            <div className="day" key={d.toISOString()} aria-label={d.toDateString()}>
              <strong>{d.toLocaleDateString([], { weekday: "short", day: "numeric" })}</strong>
              {onDay(d, ev.data ?? []).map((e) => <div className="ev" key={e.id}>{e.allDay ? "All day" : t(e.start)} {e.summary}</div>)}
              {onDay(d, av.data?.slots ?? []).map((s) => <div className="ev free" key={s.start}>Free {t(s.start)}–{t(s.end)}</div>)}
            </div>))}
          </div>
        ) : (
          <div>{days.map((d) => { const items = onDay(d, ev.data ?? []); return items.length ? (
            <section key={d.toISOString()} className="card"><h3>{d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</h3>
              {items.map((e) => <div key={e.id} className="row"><span className="muted small" style={{ width: "6rem" }}>{e.allDay ? "All day" : `${t(e.start)}–${t(e.end)}`}</span><span style={{ flex: 1 }}>{e.summary}{e.status === "tentative" ? " (tentative)" : ""}</span>{e.location && <span className="muted small">{e.location}</span>}</div>)}
            </section>) : null; })}</div>
        )}
        <section className="card" style={{ marginTop: ".8rem" }}>
          <h3>Quick add (tentative)</h3>
          <div className="row">
            <input type="text" aria-label="Title" placeholder="Title" value={qa.title} onChange={(e) => setQa({ ...qa, title: e.target.value })} style={{ flex: 2 }} />
            <input type="datetime-local" aria-label="Start" value={qa.start} onChange={(e) => setQa({ ...qa, start: e.target.value })} style={{ flex: 1 }} />
            <select aria-label="Type" value={qa.kind} onChange={(e) => setQa({ ...qa, kind: e.target.value })} style={{ flex: 1 }}><option value="rehearsal">Rehearsal</option><option value="concert">Concert</option><option value="meeting">Meeting</option><option value="lesson">Lesson</option><option value="other">Other</option></select>
            <input type="number" aria-label="Minutes" min={15} step={15} value={qa.minutes} onChange={(e) => setQa({ ...qa, minutes: Number(e.target.value) })} style={{ width: "6rem" }} />
            <button className="btn primary" disabled={!qa.title || !qa.start} onClick={async () => {
              try { const r = await api<{ summary: string }>("/api/calendar/events", { method: "POST", body: { title: qa.title, kind: qa.kind, start: new Date(qa.start).toISOString(), durationMinutes: qa.minutes } });
                flash(`Added: ${r.summary}`); setQa({ ...qa, title: "" }); void ev.reload(); } catch (e) { flash((e as Error).message, "error"); } }}>Add</button>
          </div>
          {msg && <p className="small" role="status">{msg.text}</p>}
        </section>
      </div>
    </div>
  );
}
