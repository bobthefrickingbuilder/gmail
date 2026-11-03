/**
 * INBOX / QUEUE
 * Newest first by default. "Focused" (on by default) hides newsletters, FYI and
 * other low-value mail unless it's urgent; turn it off to see everything.
 * The "Smart sort" toggle (remembered per device)
 * groups emails by triage category, urgent and highest priority first. Badges show
 * drafted / needs review / urgent / scheduling. Filters by category, status,
 * person, model and label; search; pull to refresh; swipe a row left for
 * Done / Snooze / Skip, right to escalate the draft model.
 */
import { useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useApi, useLive } from "../hooks";
import { go } from "../router";
import { when, modelLabel, catHue } from "../format";
import { Avatar } from "../components/Avatar";
import type { ThreadRow } from "../types";

const ORDER = ["urgent", "needs-reply", "scheduling", "personal", "invoice/admin", "fyi", "other", "newsletter", "uncategorized"];
const STATUS = [["", "All"], ["drafted", "Drafted"], ["needs-review", "Needs review"], ["urgent", "Urgent"], ["scheduling", "Scheduling"], ["undrafted", "No draft"]] as const;
const VIEWS = [["inbox", "Inbox"], ["snoozed", "Snoozed"], ["done", "Done"], ["skipped", "Skipped"]] as const;
const SMART_KEY = "inboxSmartSort";
const loadSmart = () => { try { return localStorage.getItem(SMART_KEY) === "1"; } catch { return false; } };
const saveSmart = (on: boolean) => { try { localStorage.setItem(SMART_KEY, on ? "1" : "0"); } catch { /* storage unavailable */ } };
const FOCUS_KEY = "inboxFocused";
const loadFocus = () => { try { return localStorage.getItem(FOCUS_KEY) !== "0"; } catch { return true; } };
const saveFocus = (on: boolean) => { try { localStorage.setItem(FOCUS_KEY, on ? "1" : "0"); } catch { /* storage unavailable */ } };

function Row({ t, selected, onChanged, i }: { t: ThreadRow; selected: boolean; onChanged: () => void; i: number }) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const act = async (state: string) => {
    const body: Record<string, unknown> = { state };
    if (state === "snoozed") body.snooze_until = new Date(Date.now() + 86400_000).toISOString();
    await api(`/api/threads/${t.id}/state`, { method: "POST", body }); onChanged();
  };
  const escalate = async () => {
    const next = t.draft_status === "drafted:haiku" ? "sonnet" : t.draft_status === "drafted:sonnet" ? "opus" : "sonnet";
    await api(`/api/threads/${t.id}/draft`, { method: "POST", body: { model: next } }); onChanged();
  };
  const sender = t.latest ? (t.latest.is_from_me ? "Me" : t.latest.from_name || t.latest.from_email) : t.person_name ?? "";
  const model = t.draft_status.startsWith("drafted:") ? t.draft_status.slice(8) : null;
  return (
    <li className="trow" style={{ ["--i" as string]: i }}>
      <div className="actions" aria-hidden={dx === 0}>
        {dx > 0 ? <button className="a-esc" onClick={escalate}>Escalate</button> : <>
          <button className="a-done" onClick={() => act("done")}>Done</button>
          <button className="a-snooze" onClick={() => act("snoozed")}>Snooze</button>
          <button className="a-skip" onClick={() => act("skipped")}>Skip</button></>}
      </div>
      <div className={`face${t.unread ? " unread" : ""}`} role="link" tabIndex={0} aria-current={selected ? "true" : undefined} style={{ transform: `translateX(${dx}px)` }}
        aria-label={`${t.unread ? "Unread. " : ""}${sender}: ${t.subject}${t.urgent ? ", urgent" : ""}${model ? `, drafted with ${model}` : ""}`}
        onClick={() => { if (dx !== 0) { setDx(0); return; } go(`/thread/${t.id}`); }}
        onKeyDown={(e) => { if (e.key === "Enter") go(`/thread/${t.id}`); if (e.key === "d") void act("done"); }}
        onTouchStart={(e) => { start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
        onTouchMove={(e) => { if (!start.current) return; const ddx = e.touches[0].clientX - start.current.x; if (Math.abs(ddx) > Math.abs(e.touches[0].clientY - start.current.y)) setDx(Math.max(-240, Math.min(110, ddx))); }}
        onTouchEnd={() => { start.current = null; setDx((d) => (d < -80 ? -240 : d > 60 ? 110 : 0)); }}>
        <Avatar name={t.latest?.is_from_me ? "Me" : t.latest?.from_name ?? t.person_name} email={t.latest?.is_from_me ? "me" : t.latest?.from_email ?? sender} />
        <span className="from">{t.person_vip ? "★ " : ""}{sender}</span>
        <span className="muted small">{when(t.last_message_at)}</span>
        <span className="subj">{t.subject || "(no subject)"}</span>
        {t.summary && <span className="sum">{t.summary}</span>}
        <span className="badges">
          {t.category && t.category !== "urgent" && !(t.category === "scheduling" && t.scheduling) && <span className="badge cat" style={{ ["--hue" as string]: catHue(t.category) }}>{t.category}</span>}
          {t.urgent && <span className="badge danger">Urgent</span>}
          {t.scheduling && <span className="badge accent">Scheduling</span>}
          {model && <span className="badge ok">Drafted · {modelLabel(model)}</span>}
          {model && (t.confidence !== "high" || t.flags.length > 0 || t.open_questions > 0) && <span className="badge warn">Needs review</span>}
          {t.flags.includes("possible_prompt_injection") && <span className="badge danger">⚠ Injection?</span>}
          {t.needs_attention && <span className="badge danger">Needs attention</span>}
          {t.state === "snoozed" && <span className="badge">Snoozed</span>}
        </span>
      </div>
    </li>
  );
}

export function Inbox({ selected, query }: { selected?: string; query: URLSearchParams }) {
  const [view, setView] = useState(query.get("view") ?? "inbox");
  const [status, setStatus] = useState(query.get("status") ?? "");
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [model, setModel] = useState("");
  const [smart, setSmart] = useState(loadSmart);
  const toggleSmart = () => setSmart((on) => { saveSmart(!on); return !on; });
  const [focus, setFocus] = useState(loadFocus);
  const toggleFocus = () => setFocus((on) => { saveFocus(!on); return !on; });
  const focusOn = focus && view === "inbox" && !category;
  const params = new URLSearchParams({ view, sort: smart ? "smart" : "date", focus: focusOn ? "1" : "0", ...(status && { status }), ...(category && { category }), ...(q && { q }), ...(model && { model }) });
  const { data, error, reload, loading } = useApi<ThreadRow[]>(`/api/threads?${params}`);
  useLive(["thread", "draft", "sync"], () => void reload());
  const attention = useApi<unknown[]>("/api/attention");
  useLive(["attention"], () => void attention.reload());
  const [pull, setPull] = useState(0);
  const touchY = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    if (!smart) return [["", [...(data ?? [])].sort((a, b) => b.last_message_at.localeCompare(a.last_message_at))]] as [string, ThreadRow[]][];
    const g = new Map<string, ThreadRow[]>();
    for (const t of data ?? []) { const k = t.category ?? "uncategorized"; g.set(k, [...(g.get(k) ?? []), t]); }
    for (const list of g.values()) list.sort((a, b) => Number(b.urgent) - Number(a.urgent) || (b.priority ?? 0) - (a.priority ?? 0) || b.last_message_at.localeCompare(a.last_message_at));
    return [...g.entries()].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
  }, [data, smart]);

  const refresh = async () => { await api("/api/sync/now", { method: "POST" }).catch(() => undefined); await reload(); };

  return (
    <div ref={scroller} onTouchStart={(e) => { if ((scroller.current?.parentElement?.scrollTop ?? 0) <= 0) touchY.current = e.touches[0].clientY; }}
      onTouchMove={(e) => { if (touchY.current !== null) setPull(Math.max(0, Math.min(80, e.touches[0].clientY - touchY.current))); }}
      onTouchEnd={() => { if (pull > 60) void refresh(); setPull(0); touchY.current = null; }}>
      <div className="toolbar">
        <h1>Inbox</h1>
        <button className="btn small" onClick={refresh} aria-label="Check for new mail">{loading ? "…" : "↻"}</button>
        <button className="btn small" onClick={() => go("/search")} aria-label="Search">⌕</button>
      </div>
      <div className="ptr" style={{ height: pull }} aria-hidden>{pull > 60 ? "Release to refresh" : "Pull to refresh"}</div>
      {(attention.data?.length ?? 0) > 0 && <div className="banner error"><a href="#/attention">{attention.data!.length} item(s) need attention</a></div>}
      <div className="chips" role="group" aria-label="Show">
        <button className="chip" aria-pressed={focus} onClick={toggleFocus} title="Hide newsletters, FYI and other low-value mail (urgent mail always shows)">◎ Focused</button>
        <button className="chip" aria-pressed={smart} onClick={toggleSmart} title="Group by category, urgent and highest priority first">⇅ Smart sort</button>
      </div>
      <div className="chips" role="group" aria-label="View" style={{ paddingTop: 0 }}>{VIEWS.map(([v, l]) => <button key={v} className="chip" aria-pressed={view === v} onClick={() => setView(v)}>{l}</button>)}</div>
      <div className="chips" role="group" aria-label="Status" style={{ paddingTop: 0 }}>{STATUS.map(([v, l]) => <button key={v} className="chip" aria-pressed={status === v} onClick={() => setStatus(v)}>{l}</button>)}</div>
      <div className="row" style={{ padding: "0 .8rem .5rem" }}>
        <input type="search" placeholder="Filter subject, sender, text…" aria-label="Filter" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 2 }} />
        <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} style={{ flex: 1 }}>
          <option value="">All categories</option>{ORDER.slice(0, -1).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} style={{ flex: 1 }}>
          <option value="">Any model</option><option value="haiku">Haiku</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option>
        </select>
      </div>
      {error && <div className="banner error">{error}</div>}
      {!data && !error && <><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></>}
      {data && data.length === 0 && <div className="empty"><span className="big">✓</span>{focusOn ? "All caught up on the mail that matters." : "Nothing here."}</div>}
      {data && data.length > 0 && groups.map(([cat, list]) => (
        <section key={cat || "all"} aria-label={cat || "All mail, newest first"}>
          {cat && <h2 className="group-h" style={{ ["--hue" as string]: catHue(cat) }}>{cat} · {list.length}</h2>}
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{list.map((t, i) => <Row key={t.id} t={t} i={i} selected={t.id === selected} onChanged={reload} />)}</ul>
        </section>
      ))}
      {focusOn && data && <p className="hidden-note">Focused view hides newsletters, FYI and other low-value mail. <button className="btn ghost small" onClick={toggleFocus}>Show everything</button></p>}
    </div>
  );
}
