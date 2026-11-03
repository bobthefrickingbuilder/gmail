/**
 * SUGGESTIONS FROM THIS EMAIL — shown under the draft section only when the
 * AI found something concrete (a task you're asked to do, or an event with a
 * real date). Each one is a button: nothing is added until you press it.
 * Tasks go to your to-do list; events go on your calendar as tentative.
 */
import { useState } from "react";
import { api } from "../apiUrl";
import { useApi, useLive, toast } from "../hooks";
import { dateTime, dueLabel } from "../format";
import type { AnalysisItem } from "../types";

export function Suggestions({ threadId }: { threadId: string }) {
  const { data, reload } = useApi<{ items: AnalysisItem[]; status: string }>(`/api/threads/${threadId}/analysis`, [threadId]);
  useLive(["thread"], (e) => { if (e.threadId === threadId) void reload(); });
  const [busy, setBusy] = useState<string | null>(null);
  const items = (data?.items ?? []).filter((i) => !i.dismissed);
  if (!items.length) return null;

  const add = async (it: AnalysisItem) => {
    setBusy(it.key);
    try {
      await api(`/api/threads/${threadId}/analysis/${it.key}/add`, { method: "POST", body: {} });
      toast(it.type === "todo" ? "Added to your to-do list" : "Added to your calendar (tentative)");
      await reload();
    } catch (e) { toast((e as Error).message, "error"); }
    finally { setBusy(null); }
  };
  const dismiss = async (it: AnalysisItem) => {
    await api(`/api/threads/${threadId}/analysis/${it.key}/dismiss`, { method: "POST" }).catch(() => undefined);
    await reload();
  };
  const when = (it: AnalysisItem) => it.type === "todo"
    ? (it.due_date ? `due ${dueLabel(it.due_date).text}` : null)
    : it.allDay ? new Date(it.start.slice(0, 10) + "T12:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : dateTime(it.start);

  return (
    <section className="card sugg" aria-label="Suggestions from this email">
      <h3>✨ From this email</h3>
      {items.map((it, i) => {
        const done = !!it.added;
        const dup = it.type === "event" && it.alreadyOnCalendar && !done;
        const w = when(it);
        return (
          <div key={it.key} className={`sugg-item ${it.type}${done ? " done" : ""}`} style={{ ["--i" as string]: i }}>
            <button className="sugg-btn" disabled={done || busy === it.key} onClick={() => add(it)}
              title={it.evidence ? `From the email: “${it.evidence}”` : undefined}>
              <span className="ico" aria-hidden>{done ? "✓" : it.type === "todo" ? "☑︎" : "📅"}</span>
              <span className="txt">
                <span className="lbl">{done ? (it.type === "todo" ? "Added to to-do" : "Added to calendar") : dup ? "Add anyway" : it.type === "todo" ? "Add to to-do" : "Add to calendar"}</span>
                <strong>{it.title}</strong>
                {(w || (it.type === "event" && it.location)) && <span className="muted small">{[w, it.type === "event" ? it.location : null].filter(Boolean).join(" · ")}</span>}
                {dup && <span className="small" style={{ color: "var(--warn)" }}>Looks like it's already on your calendar</span>}
              </span>
              {busy === it.key && <span className="spinner" aria-hidden />}
            </button>
            {!done && <button className="btn ghost small icon" aria-label={`Hide suggestion: ${it.title}`} title="Not needed" onClick={() => dismiss(it)}>✕</button>}
          </div>
        );
      })}
    </section>
  );
}
