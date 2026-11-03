/**
 * CALENDAR — month, week and agenda views from Google Calendar (the source of
 * truth), a preview of free slots, quick-add (creates a tentative event), and
 * "Scan emails for events": the app lists the events it found in your recent
 * mail, you tick and adjust the ones you want, and only then are they added
 * (as tentative events).
 */
import { useMemo, useRef, useState, useEffect } from "react";
import { api } from "../api";
import { useApi, toast } from "../hooks";
import { localDay } from "../format";
import type { EventCandidate } from "../types";

interface Ev { id: string; summary: string; start: string; end: string; allDay: boolean; location: string | null; status: string }
type Mode = "month" | "week" | "agenda";
const DAY = 86400_000;
const startOfWeek = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const t = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
/** All-day events come as YYYY-MM-DD; read them as local dates, not UTC midnight. */
const evDate = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00`) : new Date(s));
const KIND_HUE: [RegExp, string][] = [[/concert/i, "var(--c-personal)"], [/rehearsal|répétition/i, "var(--c-sched)"], [/lesson/i, "var(--c-fyi)"], [/meeting|call/i, "var(--c-needs)"], [/deadline|due/i, "var(--c-urgent)"]];
const hueFor = (s: string) => KIND_HUE.find(([re]) => re.test(s))?.[1] ?? "var(--accent)";
const toLocalInput = (iso: string) => { const d = new Date(iso); return `${localDay(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export function CalendarView() {
  const [mode, setMode] = useState<Mode>("month");
  const [anchor, setAnchor] = useState(() => new Date());
  const [selected, setSelected] = useState<Date>(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [scanning, setScanning] = useState(false);

  const { from, to, days } = useMemo(() => {
    if (mode === "month") {
      const first = startOfWeek(startOfMonth(anchor));
      return { from: first, to: new Date(first.getTime() + 42 * DAY), days: Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)) };
    }
    const f = startOfWeek(anchor); const n = mode === "week" ? 7 : 14;
    return { from: f, to: new Date(f.getTime() + n * DAY), days: Array.from({ length: n }, (_, i) => new Date(f.getFullYear(), f.getMonth(), f.getDate() + i)) };
  }, [anchor, mode]);
  const ev = useApi<Ev[]>(`/api/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`);
  const [duration, setDuration] = useState(60);
  const fromDay = localDay(from), toDay = localDay(new Date(to.getTime() - DAY));
  const av = useApi<{ slots: { start: string; end: string; label: string }[]; timezone: string }>(mode === "month" ? null : `/api/calendar/availability?from=${fromDay}&to=${toDay}&duration=${duration}`);
  const [qa, setQa] = useState({ title: "", start: "", minutes: 120, kind: "rehearsal" });
  const onDay = <T extends { start: string }>(d: Date, items: T[]): T[] => items.filter((e) => sameDay(evDate(e.start), d)).sort((a, b) => a.start.localeCompare(b.start));
  const step = (n: number) => setAnchor((a) => (mode === "month" ? new Date(a.getFullYear(), a.getMonth() + n, 1) : new Date(a.getTime() + n * 7 * DAY)));
  const today = new Date();
  const label = mode === "month" ? anchor.toLocaleDateString([], { month: "long", year: "numeric" })
    : `${from.toLocaleDateString([], { month: "long", day: "numeric" })} – ${new Date(to.getTime() - 1).toLocaleDateString([], { month: "long", day: "numeric" })}`;
  const evRow = (e: Ev) => (
    <div key={e.id} className="ev" style={{ ["--hue" as string]: hueFor(e.summary), padding: ".4rem .55rem", display: "flex", gap: ".6rem" }}>
      <span className="muted small" style={{ width: "6.5rem", flex: "none" }}>{e.allDay ? "All day" : `${t(e.start)}–${t(e.end)}`}</span>
      <span style={{ flex: 1 }}>{e.summary}{e.status === "tentative" ? <span className="muted"> (tentative)</span> : ""}</span>
      {e.location && <span className="muted small">{e.location}</span>}
    </div>);

  return (
    <div className="screen">
      <div className="toolbar"><h1>Calendar</h1>
        {(["month", "week", "agenda"] as const).map((m) => <button key={m} className="chip" aria-pressed={mode === m} onClick={() => setMode(m)}>{m[0].toUpperCase() + m.slice(1)}</button>)}
      </div>
      <div className="content" style={{ maxWidth: 1200 }}>
        <div className="row" style={{ marginBottom: ".7rem" }}>
          <button className="btn small icon" onClick={() => step(-1)} aria-label={`Previous ${mode === "month" ? "month" : "week"}`}>‹</button>
          <button className="btn small" onClick={() => { setAnchor(new Date()); const d = new Date(); d.setHours(0, 0, 0, 0); setSelected(d); }}>Today</button>
          <button className="btn small icon" onClick={() => step(1)} aria-label={`Next ${mode === "month" ? "month" : "week"}`}>›</button>
          <strong style={{ fontSize: "1.1rem" }}>{label}</strong>
          <span className="spacer" />
          <button className="btn primary small" onClick={() => setScanning(true)}>✨ Scan emails for events</button>
          {mode !== "month" && <label className="inline small">Free slots of <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} style={{ width: "auto" }}>{[30, 60, 90, 120, 180].map((m) => <option key={m} value={m}>{m} min</option>)}</select></label>}
        </div>
        {ev.error && <div className="banner error">{ev.error}</div>}

        {mode === "month" && <>
          <div className="month" role="grid" aria-label={label} key={label}>
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="dow" role="columnheader">{d}</div>)}
            {days.map((d, i) => { const items = onDay(d, ev.data ?? []); return (
              <div key={d.toISOString()} role="gridcell" tabIndex={0} aria-selected={sameDay(d, selected)} aria-label={`${d.toDateString()}, ${items.length} events`}
                className={`cell${d.getMonth() !== anchor.getMonth() ? " other" : ""}${sameDay(d, today) ? " today" : ""}`} style={{ animation: `fade-in .3s ${Math.min(i, 41) * 6}ms both` }}
                onClick={() => setSelected(d)} onKeyDown={(e) => { if (e.key === "Enter") setSelected(d); }}>
                <span className="num">{d.getDate()}</span>
                {items.slice(0, 3).map((e) => <div key={e.id} className="ev" style={{ ["--hue" as string]: hueFor(e.summary) }}>{e.allDay ? "" : `${t(e.start)} `}{e.summary}</div>)}
                {items.length > 3 && <div className="more">+{items.length - 3} more</div>}
                <div className="dots">{items.slice(0, 5).map((e) => <i key={e.id} style={{ ["--hue" as string]: hueFor(e.summary) }} />)}</div>
              </div>); })}
          </div>
          <section className="card" style={{ marginTop: ".8rem" }} key={selected.toISOString()}>
            <div className="row"><h3 style={{ margin: 0, flex: 1 }}>{selected.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</h3>
              <button className="btn small" onClick={() => setQa({ ...qa, start: `${localDay(selected)}T19:00` })}>＋ Add on this day</button></div>
            {onDay(selected, ev.data ?? []).length ? <div style={{ marginTop: ".4rem" }}>{onDay(selected, ev.data ?? []).map(evRow)}</div> : <p className="muted small" style={{ marginBottom: 0 }}>Nothing scheduled.</p>}
          </section>
        </>}

        {mode === "week" && (
          <div className="week">{days.map((d) => (
            <div className={`day${sameDay(d, today) ? " today" : ""}`} key={d.toISOString()} aria-label={d.toDateString()}>
              <strong>{d.toLocaleDateString([], { weekday: "short", day: "numeric" })}</strong>
              {onDay(d, ev.data ?? []).map((e) => <div className="ev" key={e.id} style={{ ["--hue" as string]: hueFor(e.summary) }}>{e.allDay ? "All day" : t(e.start)} {e.summary}</div>)}
              {onDay(d, av.data?.slots ?? []).map((s) => <div className="ev free" key={s.start}>Free {t(s.start)}–{t(s.end)}</div>)}
            </div>))}
          </div>)}

        {mode === "agenda" && (
          <div>{days.map((d) => { const items = onDay(d, ev.data ?? []); return items.length ? (
            <section key={d.toISOString()} className="card"><h3>{d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</h3>{items.map(evRow)}</section>) : null; })}
            {(ev.data ?? []).length === 0 && ev.data && <div className="empty">Nothing in the next two weeks.</div>}</div>)}

        <section className="card" style={{ marginTop: ".8rem" }}>
          <h3>Quick add (tentative)</h3>
          <div className="row">
            <input type="text" aria-label="Title" placeholder="Title" value={qa.title} onChange={(e) => setQa({ ...qa, title: e.target.value })} style={{ flex: 2, minWidth: "10rem" }} />
            <input type="datetime-local" aria-label="Start" value={qa.start} onChange={(e) => setQa({ ...qa, start: e.target.value })} style={{ flex: 1, minWidth: "12rem" }} />
            <select aria-label="Type" value={qa.kind} onChange={(e) => setQa({ ...qa, kind: e.target.value })} style={{ flex: 1, minWidth: "8rem" }}><option value="rehearsal">Rehearsal</option><option value="concert">Concert</option><option value="meeting">Meeting</option><option value="lesson">Lesson</option><option value="other">Other</option></select>
            <input type="number" aria-label="Minutes" min={15} step={15} value={qa.minutes} onChange={(e) => setQa({ ...qa, minutes: Number(e.target.value) })} style={{ width: "6rem" }} />
            <button className="btn primary" disabled={!qa.title || !qa.start} onClick={async () => {
              try { const r = await api<{ summary: string }>("/api/calendar/events", { method: "POST", body: { title: qa.title, kind: qa.kind, start: new Date(qa.start).toISOString(), durationMinutes: qa.minutes } });
                toast(`Added: ${r.summary}`); setQa({ ...qa, title: "" }); void ev.reload(); } catch (e) { toast((e as Error).message, "error"); } }}>Add</button>
          </div>
        </section>
      </div>
      {scanning && <ScanDialog onClose={() => setScanning(false)} onAdded={() => void ev.reload()} />}
    </div>
  );
}

interface Cand extends EventCandidate { on: boolean; editStart: string; editTitle: string }

/** Lists the events found in recent mail. Nothing is added until you press Add. */
function ScanDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [days, setDays] = useState(14);
  const [state, setState] = useState<"idle" | "scanning" | "done" | "adding">("idle");
  const [found, setFound] = useState<Cand[]>([]);
  const [scanned, setScanned] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { ref.current?.showModal(); }, []);

  const scan = async () => {
    setState("scanning"); setErr(null);
    try {
      const r = await api<{ events: EventCandidate[]; scanned: number }>("/api/calendar/scan", { method: "POST", body: { days } });
      setScanned(r.scanned);
      setFound(r.events.map((e) => ({ ...e, on: !e.alreadyOnCalendar && e.confidence !== "low", editTitle: e.title, editStart: e.allDay ? e.start.slice(0, 10) : toLocalInput(e.start) })));
      setState("done");
    } catch (e) { setErr((e as Error).message); setState("idle"); }
  };
  const add = async () => {
    const chosen = found.filter((f) => f.on);
    setState("adding"); let ok = 0;
    for (const c of chosen) {
      try {
        const start = c.allDay ? c.editStart : new Date(c.editStart).toISOString();
        const dur = c.end && !c.allDay ? Math.max(15, Math.round((new Date(c.end).getTime() - new Date(c.start).getTime()) / 60000)) : 120;
        await api("/api/calendar/events", { method: "POST", body: { title: c.editTitle, kind: ["concert", "rehearsal", "meeting", "lesson"].includes(c.kind) ? c.kind : "other",
          start, durationMinutes: dur, allDay: c.allDay, ...(c.location ? { location: c.location } : {}), description: `From email: ${c.subject} (${c.from})` } });
        ok++; setFound((f) => f.map((x) => (x.key === c.key ? { ...x, on: false, alreadyOnCalendar: true } : x)));
      } catch (e) { toast(`${c.editTitle}: ${(e as Error).message}`, "error"); }
    }
    if (ok) { toast(`Added ${ok} event${ok > 1 ? "s" : ""} (tentative)`); onAdded(); }
    setState("done");
  };
  const n = found.filter((f) => f.on).length;
  const upd = (key: string, p: Partial<Cand>) => setFound((f) => f.map((x) => (x.key === key ? { ...x, ...p } : x)));

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="scan-h" style={{ maxWidth: "min(720px, 96vw)" }}>
      <div className="dlg">
        <div className="row"><h2 id="scan-h" style={{ margin: 0, flex: 1, fontSize: "1.15rem" }}>✨ Events in your email</h2><button className="btn ghost small" onClick={() => ref.current?.close()} aria-label="Close">✕</button></div>
        {state === "idle" && <>
          <p className="muted">Reads your recent mail (not newsletters or skipped mail) and lists the events it mentions. You choose which to add — nothing goes on your calendar until you press Add.</p>
          <div className="row"><label className="inline">Look back <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: "auto" }}>{[7, 14, 30, 60].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
            <span className="spacer" /><button className="btn primary" onClick={scan}>Scan</button></div>
          {err && <p className="error-text" role="alert">{err}</p>}
        </>}
        {state === "scanning" && <div className="empty"><span className="spinner" style={{ fontSize: "1.6rem" }} /><p>Reading your email…</p></div>}
        {(state === "done" || state === "adding") && <>
          <p className="small muted">Scanned {scanned} emails · found {found.length} upcoming event{found.length === 1 ? "" : "s"}. Check the date and title before adding.</p>
          {found.length === 0 && <div className="empty">No upcoming events found.</div>}
          <div style={{ maxHeight: "55dvh", overflowY: "auto" }}>
            {found.map((c, i) => (
              <div key={c.key} className={`ev-cand${c.on ? " on" : ""}${c.alreadyOnCalendar ? " dup" : ""}`} style={{ ["--i" as string]: i }}>
                <input type="checkbox" checked={c.on} aria-label={`Add ${c.editTitle}`} onChange={(e) => upd(c.key, { on: e.target.checked })} style={{ marginTop: ".3rem" }} />
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: ".35rem" }}><strong>{c.editTitle}</strong>
                    {c.alreadyOnCalendar && <span className="badge ok">already on calendar</span>}
                    {c.source === "invite" ? <span className="badge accent">invitation</span> : <span className={`badge ${c.confidence === "high" ? "ok" : c.confidence === "low" ? "danger" : "warn"}`}>{c.confidence} confidence</span>}</div>
                  <div className="small muted">{c.allDay ? new Date(`${c.start.slice(0, 10)}T12:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + " · all day"
                    : new Date(c.start).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{c.location ? ` · ${c.location}` : ""}</div>
                  <div className="small">From <a href={`#/thread/${c.threadId}`} onClick={() => ref.current?.close()}>{c.from}: {c.subject}</a>{c.evidence && <span className="muted"> — “{c.evidence}”</span>}</div>
                </div>
                {c.on && <div className="edit">
                  <input type="text" aria-label="Event title" value={c.editTitle} onChange={(e) => upd(c.key, { editTitle: e.target.value })} />
                  <input type={c.allDay ? "date" : "datetime-local"} aria-label="Start" value={c.editStart} onChange={(e) => upd(c.key, { editStart: e.target.value })} />
                </div>}
              </div>))}
          </div>
          <div className="row" style={{ marginTop: ".7rem" }}>
            <button className="btn ghost" onClick={() => setState("idle")}>Scan again</button><span className="spacer" />
            <button className="btn" onClick={() => ref.current?.close()}>Close</button>
            <button className="btn primary" disabled={!n || state === "adding"} onClick={add}>{state === "adding" ? <><span className="spinner" /> Adding…</> : `Add ${n} to calendar`}</button>
          </div>
        </>}
      </div>
    </dialog>
  );
}
