/**
 * TO-DO LIST
 * Views: Today (due today or overdue), Upcoming (next two weeks, by day),
 * Inbox (tasks without a project), All, Done, and one page per project with
 * its progress bar. Any task can be broken into steps, and steps into steps;
 * the arrow beside a task shows them. "✨ Break down" asks Claude for steps
 * and lets you tick which to add. Quick add understands "tomorrow", "friday",
 * "!high" and "#project" in the title.
 */
import { useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { useApi, useLive, toast } from "../hooks";
import { go } from "../router";
import { dueLabel, localDay, projectHue } from "../format";
import type { Project, Task } from "../types";

interface Data { projects: Project[]; tasks: Task[]; colors: string[] }
const FIXED = ["today", "upcoming", "inbox", "all", "done"] as const;
const VIEW_LABEL: Record<string, [string, string]> = { today: ["Today", "☀︎"], upcoming: ["Upcoming", "▦"], inbox: ["Inbox", "⬚"], all: ["All tasks", "≡"], done: ["Done", "✓"] };
const PRIO = ["None", "Low", "Medium", "High"];
const addDaysStr = (day: string, n: number) => { const [y, m, d] = day.split("-").map(Number); return localDay(new Date(y, m - 1, d + n)); };

export function Todo({ view = "today" }: { view?: string }) {
  const { data, reload, setData } = useApi<Data>("/api/tasks");
  useLive(["tasks"], () => void reload());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<string | null>(null);
  const [quick, setQuick] = useState("");
  const [newProj, setNewProj] = useState("");

  const tasks = data?.tasks ?? []; const projects = data?.projects ?? [];
  const project = projects.find((p) => p.id === view);
  const today = localDay();
  const kids = useMemo(() => { const m = new Map<string, Task[]>(); for (const t of tasks) if (t.parent_id) m.set(t.parent_id, [...(m.get(t.parent_id) ?? []), t]); return m; }, [tasks]);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const countAll = (id: string): [number, number] => { let done = 0, all = 0; for (const k of kids.get(id) ?? []) { all++; if (k.status === "done") done++; const [d, a] = countAll(k.id); done += d; all += a; } return [done, all]; };
  const roots = (filter: (t: Task) => boolean) => tasks.filter((t) => !t.parent_id && filter(t));
  const openTasks = tasks.filter((t) => t.status === "open");

  const counts = {
    today: openTasks.filter((t) => t.due_date && t.due_date <= today).length,
    upcoming: openTasks.filter((t) => t.due_date && t.due_date > today && t.due_date <= addDaysStr(today, 14)).length,
    inbox: roots((t) => t.status === "open" && !t.project_id).length,
    all: roots((t) => t.status === "open").length, done: 0,
  };

  const mutate = async (id: string, patch: Partial<Task>, msg?: string) => {
    setData((d) => d && { ...d, tasks: d.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }); // instant feedback
    try { await api(`/api/tasks/${id}`, { method: "PATCH", body: patch }); if (msg) toast(msg); } catch (e) { toast((e as Error).message, "error"); }
    void reload();
  };
  const toggle = (t: Task) => void mutate(t.id, { status: t.status === "done" ? "open" : "done" }, t.status === "open" && (kids.get(t.id)?.length ?? 0) > 0 ? "Done — steps ticked too" : undefined);
  const create = async (body: Record<string, unknown>) => { try { await api("/api/tasks", { method: "POST", body }); await reload(); } catch (e) { toast((e as Error).message, "error"); } };
  const addQuick = async () => {
    const title = quick.trim(); if (!title) return;
    setQuick("");
    await create({ title, quick: true, ...(project ? { project_id: project.id } : {}), ...(view === "today" && !/\b(today|tomorrow|mon|tue|wed|thu|fri|sat|sun|\d{4}-)/i.test(title) ? { due_date: today } : {}) });
  };
  const flip = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const row = (t: Task, depth: number, i: number, showProject?: boolean): ReactNode => {
    const sub = kids.get(t.id) ?? []; const [d, a] = countAll(t.id); const isOpen = open.has(t.id);
    const p = t.project_id ? projects.find((x) => x.id === t.project_id) : undefined; const due = t.due_date ? dueLabel(t.due_date) : null;
    const parent = depth === 0 && t.parent_id ? byId.get(t.parent_id) : undefined;
    return (
      <div key={t.id} style={{ ["--hue" as string]: projectHue(p?.color) }}>
        <div className={`task prio-${t.priority}${t.status === "done" ? " done" : ""}`} style={{ ["--i" as string]: i }}>
          <button className={`twist${sub.length ? "" : " none"}`} aria-expanded={isOpen} aria-label={isOpen ? "Hide steps" : "Show steps"} onClick={() => flip(t.id)}>›</button>
          <button className={`check${t.status === "done" ? " on" : ""}`} role="checkbox" aria-checked={t.status === "done"} aria-label={`Done: ${t.title}`} onClick={() => toggle(t)}>{t.status === "done" ? "✓" : ""}</button>
          <span className="ttl" onClick={() => setDetail(t.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setDetail(t.id); }}>{t.title}</span>
          <span className="side">
            <button className="btn ghost small icon" title="Add a step" aria-label="Add a step" onClick={() => { setOpen((s) => new Set(s).add(t.id)); setTimeout(() => document.getElementById(`step-${t.id}`)?.focus(), 50); }}>＋</button>
            <button className="btn ghost small icon" title="Details" aria-label="Details" onClick={() => setDetail(t.id)}>⋯</button>
          </span>
          {(due || a > 0 || t.priority > 0 || (showProject && p) || t.thread_id || t.notes || parent) && (
            <span className="meta">
              {parent && <span className="muted">↳ {parent.title}</span>}
              {due && <span className={`due ${t.status === "open" ? due.cls : ""}`}>◷ {due.text}</span>}
              {t.priority > 0 && <span className="badge cat" style={{ ["--hue" as string]: t.priority === 3 ? "var(--c-urgent)" : t.priority === 2 ? "var(--c-admin)" : "var(--c-needs)" }}>⚑ {PRIO[t.priority]}</span>}
              {a > 0 && <span className="badge cat" style={{ ["--hue" as string]: d === a ? "var(--ok)" : projectHue(p?.color) }}>{d}/{a} steps</span>}
              {showProject && p && <span className="row" style={{ gap: ".25rem" }}><span className="dot" />{p.name}</span>}
              {t.thread_id && <a href={`#/thread/${t.thread_id}`} onClick={(e) => e.stopPropagation()}>✉︎ email</a>}
              {t.notes && <span className="muted">✎ notes</span>}
            </span>)}
        </div>
        {isOpen && (
          <div className="subtasks">
            {sub.map((s, k) => row(s, depth + 1, k))}
            <AddStep parentId={t.id} onAdd={(title) => create({ title, parent_id: t.id, quick: true })} />
          </div>)}
      </div>
    );
  };

  let title = project?.name ?? VIEW_LABEL[view]?.[0] ?? "To-do";
  let body: ReactNode;
  if (!data) body = <><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></>;
  else if (view === "today") {
    const list = openTasks.filter((t) => t.due_date && t.due_date <= today).sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1) || b.priority - a.priority);
    const doneToday = tasks.filter((t) => t.status === "done" && t.completed_at && localDay(new Date(t.completed_at)) === today && t.due_date && t.due_date <= today);
    body = list.length || doneToday.length
      ? <>{list.map((t, i) => row(t, 0, i, true))}{doneToday.map((t, i) => row(t, 0, list.length + i, true))}</>
      : <div className="empty"><span className="big">☀︎</span>Nothing due today. Add a task above, or plan ahead in Upcoming.</div>;
  } else if (view === "upcoming") {
    const days = Array.from({ length: 14 }, (_, i) => addDaysStr(today, i + 1));
    const groups = days.map((d) => [d, openTasks.filter((t) => t.due_date === d)] as const).filter(([, l]) => l.length);
    body = groups.length ? groups.map(([d, l]) => (
      <section key={d}><h4 className="group-h" style={{ ["--hue" as string]: "var(--accent)" }}>{dueLabel(d).text} · {new Date(`${d}T12:00`).toLocaleDateString([], { month: "short", day: "numeric" })}</h4>
        {l.map((t, i) => row(t, 0, i, true))}</section>))
      : <div className="empty"><span className="big">▦</span>Nothing scheduled in the next two weeks.</div>;
  } else if (view === "done") {
    const list = tasks.filter((t) => t.status === "done").sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
    body = list.length ? list.map((t, i) => row(t, 0, i, true)) : <div className="empty"><span className="big">✓</span>Nothing finished in the last 30 days yet.</div>;
  } else if (view === "all") {
    const sections = [{ id: null as string | null, name: "Inbox", color: "slate" }, ...projects];
    body = sections.map((s) => { const l = roots((t) => t.status === "open" && t.project_id === s.id); return l.length ? (
      <section key={s.id ?? "inbox"}><h4 className="group-h" style={{ ["--hue" as string]: projectHue(s.color) }}>{s.name} · {l.length}</h4>{l.map((t, i) => row(t, 0, i))}</section>) : null; });
  } else {
    const list = roots((t) => (project ? t.project_id === project.id : !t.project_id));
    const openList = list.filter((t) => t.status === "open"), doneList = list.filter((t) => t.status === "done");
    body = <>{openList.map((t, i) => row(t, 0, i))}
      {!openList.length && <div className="empty"><span className="big">{project ? "◎" : "⬚"}</span>{project ? "No open tasks in this project. Add the first one above — then break it into steps." : "No tasks without a project."}</div>}
      {doneList.length > 0 && <details style={{ marginTop: ".8rem" }}><summary className="muted small">Completed · {doneList.length}</summary>{doneList.map((t, i) => row(t, 0, i))}</details>}</>;
  }
  if (!project && !FIXED.includes(view as (typeof FIXED)[number]) && data) title = "Project not found";

  const projStats = (p: Project) => { const all = tasks.filter((t) => t.project_id === p.id); return [all.filter((t) => t.status === "done").length, all.length]; };

  return (
    <div className="todo screen">
      <nav className="todo-nav" aria-label="Lists">
        {FIXED.map((v) => <a key={v} href={`#/todo/${v}`} aria-current={view === v ? "page" : undefined}><span aria-hidden>{VIEW_LABEL[v][1]}</span>{VIEW_LABEL[v][0]}{counts[v] > 0 && <span className="n">{counts[v]}</span>}</a>)}
        <h4>Projects</h4>
        {projects.map((p) => { const [d, a] = projStats(p); return (
          <a key={p.id} href={`#/todo/${p.id}`} aria-current={view === p.id ? "page" : undefined} style={{ ["--hue" as string]: projectHue(p.color) }}>
            <span className="dot" />{p.name}<span className="n">{a ? `${d}/${a}` : ""}</span></a>); })}
        <form className="newproj" style={{ padding: ".3rem .4rem" }} onSubmit={async (e) => { e.preventDefault(); if (!newProj.trim()) return;
          const p = await api<Project>("/api/projects", { method: "POST", body: { name: newProj.trim() } }); setNewProj(""); await reload(); go(`/todo/${p.id}`); }}>
          <input type="text" placeholder="＋ New project" aria-label="New project name" value={newProj} onChange={(e) => setNewProj(e.target.value)} style={{ minHeight: 36, fontSize: ".9rem" }} />
        </form>
        {<a className="narrow-only" href="#/todo/all" onClick={(e) => { e.preventDefault(); const n = prompt("Project name"); if (n?.trim()) void api<Project>("/api/projects", { method: "POST", body: { name: n.trim() } }).then((p) => { void reload(); go(`/todo/${p.id}`); }); }}>＋ Project</a>}
      </nav>
      <div style={{ minWidth: 0 }}>
        <div className="toolbar"><h1>{title}</h1>
          {project && <ProjectMenu p={project} colors={data?.colors ?? []} onChanged={reload} />}
        </div>
        <div className="content" style={{ maxWidth: 820 }}>
          {project && (() => { const [d, a] = projStats(project); return a > 0 ? (
            <div style={{ ["--hue" as string]: projectHue(project.color), marginBottom: ".8rem" }}>
              <div className="row small muted" style={{ marginBottom: ".3rem" }}><span>{Math.round((d / a) * 100)}% done</span><span className="spacer" /><span>{d} of {a} tasks and steps</span></div>
              <div className="progress"><i style={{ width: `${(d / a) * 100}%` }} /></div></div>) : null; })()}
          {view !== "done" && (
            <form className="quick-add" onSubmit={(e) => { e.preventDefault(); void addQuick(); }} style={{ marginBottom: ".9rem" }}>
              <span aria-hidden style={{ color: "var(--accent)", fontSize: "1.2rem" }}>＋</span>
              <input type="text" aria-label="New task" placeholder={`Add a task${project ? ` to ${project.name}` : ""} — try "Book hall friday !high"`} value={quick} onChange={(e) => setQuick(e.target.value)} />
              <button className="btn primary small" disabled={!quick.trim()}>Add</button>
            </form>)}
          {body}
        </div>
      </div>
      {detail && byId.get(detail) && <TaskDetail t={byId.get(detail)!} projects={projects} steps={kids.get(detail) ?? []} onClose={() => setDetail(null)}
        onChanged={reload} onOpenSteps={() => setOpen((s) => new Set(s).add(detail))} />}
    </div>
  );
}

function AddStep({ parentId, onAdd }: { parentId: string; onAdd: (title: string) => Promise<void> }) {
  const [v, setV] = useState("");
  return (
    <form onSubmit={async (e) => { e.preventDefault(); if (!v.trim()) return; const t = v; setV(""); await onAdd(t); }} style={{ padding: ".2rem .6rem .4rem 2.2rem" }}>
      <input id={`step-${parentId}`} type="text" aria-label="Add a step" placeholder="＋ Add a step" value={v} onChange={(e) => setV(e.target.value)} style={{ minHeight: 34, fontSize: ".9rem", background: "transparent" }} />
    </form>
  );
}

function ProjectMenu({ p, colors, onChanged }: { p: Project; colors: string[]; onChanged: () => void }) {
  const upd = async (body: Record<string, unknown>) => { await api(`/api/projects/${p.id}`, { method: "PATCH", body }); onChanged(); };
  return (
    <details className="menu">
      <summary className="btn small">⋯</summary>
      <div className="menu-pop">
        <div className="row" style={{ padding: ".4rem .5rem", gap: ".35rem" }}>
          {colors.map((c) => <button key={c} aria-label={`Colour ${c}`} onClick={() => void upd({ color: c })}
            style={{ width: 22, height: 22, padding: 0, borderRadius: "50%", background: projectHue(c), border: c === p.color ? "3px solid var(--text)" : "0", display: "inline-block" }} />)}
        </div>
        <button onClick={() => { const n = prompt("Rename project", p.name); if (n?.trim()) void upd({ name: n.trim() }); }}>Rename</button>
        <button onClick={() => { if (confirm("Archive this project? Its tasks stay saved but hidden.")) void upd({ archived: true }).then(() => go("/todo/all")); }}>Archive</button>
        <button style={{ color: "var(--danger)" }} onClick={async () => { if (!confirm(`Delete "${p.name}" and all of its tasks? This can't be undone.`)) return;
          await api(`/api/projects/${p.id}`, { method: "DELETE" }); toast("Project deleted"); go("/todo/all"); onChanged(); }}>Delete project…</button>
      </div>
    </details>
  );
}

function TaskDetail({ t, projects, steps, onClose, onChanged, onOpenSteps }: { t: Task; projects: Project[]; steps: Task[]; onClose: () => void; onChanged: () => void; onOpenSteps: () => void }) {
  const [title, setTitle] = useState(t.title);
  const [notes, setNotes] = useState(t.notes);
  const [sugs, setSugs] = useState<{ title: string; notes: string | null; on: boolean }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const patch = async (body: Record<string, unknown>) => { try { await api(`/api/tasks/${t.id}`, { method: "PATCH", body }); onChanged(); } catch (e) { toast((e as Error).message, "error"); } };
  const suggest = async () => { setBusy(true); try { const r = await api<{ steps: { title: string; notes: string | null }[] }>(`/api/tasks/${t.id}/suggest`, { method: "POST" }); setSugs(r.steps.map((s) => ({ ...s, on: true }))); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); } };
  const addSugs = async () => { const chosen = sugs!.filter((s) => s.on); if (!chosen.length) return;
    await api(`/api/tasks/${t.id}/steps`, { method: "POST", body: { steps: chosen.map(({ title: tt, notes: n }) => ({ title: tt, notes: n })) } });
    toast(`Added ${chosen.length} step${chosen.length > 1 ? "s" : ""}`); setSugs(null); onOpenSteps(); onChanged(); };
  return (
    <dialog open className="task-detail" style={{ position: "fixed", inset: 0, margin: "auto", zIndex: 40, maxHeight: "90dvh", overflowY: "auto" }} aria-label="Task details">
      <div className="dlg">
        <div className="row"><h2 style={{ margin: 0, flex: 1, fontSize: "1.1rem" }}>Task</h2><button className="btn ghost small" onClick={onClose} aria-label="Close">✕</button></div>
        <label htmlFor="td-title">Title</label>
        <input id="td-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== t.title && void patch({ title })} />
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div style={{ flex: 1, minWidth: "9rem" }}><label htmlFor="td-due">Due</label>
            <input id="td-due" type="date" value={t.due_date ?? ""} onChange={(e) => void patch({ due_date: e.target.value || null })} /></div>
          <div style={{ flex: 1, minWidth: "8rem" }}><label htmlFor="td-prio">Priority</label>
            <select id="td-prio" value={t.priority} onChange={(e) => void patch({ priority: Number(e.target.value) })}>{PRIO.map((p, i) => <option key={p} value={i}>{p}</option>)}</select></div>
          {!t.parent_id && <div style={{ flex: 1, minWidth: "9rem" }}><label htmlFor="td-proj">Project</label>
            <select id="td-proj" value={t.project_id ?? ""} onChange={(e) => void patch({ project_id: e.target.value || null })}>
              <option value="">Inbox (no project)</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}
        </div>
        <label htmlFor="td-notes">Notes</label>
        <textarea id="td-notes" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== t.notes && void patch({ notes })} placeholder="Details, links, anything useful…" />

        <div className="card ai-box" style={{ marginTop: ".8rem" }}>
          <div className="row"><strong style={{ flex: 1 }}>Steps {steps.length > 0 && <span className="muted small">· {steps.filter((s) => s.status === "done").length}/{steps.length} done</span>}</strong>
            <button className="btn small" disabled={busy} onClick={suggest}>{busy ? <><span className="spinner" /> Thinking…</> : "✨ Break down with Claude"}</button></div>
          {sugs && (sugs.length ? <>
            <p className="small muted" style={{ margin: ".4rem 0" }}>Suggested steps — untick any you don't want:</p>
            {sugs.map((s, i) => (
              <label key={i} className="sug-step" style={{ ["--i" as string]: i, fontWeight: 400, margin: 0 }}>
                <input type="checkbox" checked={s.on} onChange={(e) => setSugs(sugs.map((x, k) => (k === i ? { ...x, on: e.target.checked } : x)))} />
                <span><span>{s.title}</span>{s.notes && <span className="muted small"><br />{s.notes}</span>}</span>
              </label>))}
            <div className="row" style={{ marginTop: ".5rem" }}><button className="btn primary small" onClick={addSugs} disabled={!sugs.some((s) => s.on)}>Add {sugs.filter((s) => s.on).length} steps</button>
              <button className="btn ghost small" onClick={() => setSugs(null)}>Cancel</button></div>
          </> : <p className="small muted">No steps suggested.</p>)}
          {!sugs && steps.length === 0 && <p className="small muted" style={{ marginBottom: 0 }}>Big task? Break it into steps — use ＋ on the task, or let Claude suggest some.</p>}
        </div>
        <div className="row" style={{ marginTop: ".8rem" }}>
          <button className="btn danger small" onClick={async () => { if (!confirm(steps.length ? "Delete this task and all its steps?" : "Delete this task?")) return;
            await api(`/api/tasks/${t.id}`, { method: "DELETE" }); toast("Deleted"); onClose(); onChanged(); }}>Delete</button>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </dialog>
  );
}
