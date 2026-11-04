/**
 * DRAFTS — every unsent draft in one place: replies Claude (or you) wrote to
 * incoming mail, and new emails you started. Newest first. Filter by kind or
 * text; tap one to open it in its email (replies) or the editor (new emails).
 * On wide screens the list sits beside the open draft. Discard asks first and
 * also deletes the copy in Gmail Drafts.
 */
import { useState } from "react";
import { api } from "../api";
import { useApi, useLive, toast } from "../hooks";
import { go } from "../router";
import { when, modelLabel, who } from "../format";
import { Avatar } from "../components/Avatar";
import type { DraftRow } from "../types";

const KINDS = [["all", "All"], ["reply", "Replies"], ["new", "New emails"]] as const;

/** Route id for the split view: "reply:<threadId>" or "new:<composeId>". */
export const draftKey = (d: DraftRow) => (d.kind === "reply" ? `reply:${d.thread_id}` : `new:${d.id}`);

export function DraftsList({ selected, wide }: { selected?: string; wide: boolean }) {
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>("all");
  const [q, setQ] = useState("");
  const params = new URLSearchParams({ kind, ...(q.trim() && { q: q.trim() }) });
  const { data, error, reload } = useApi<DraftRow[]>(`/api/drafts?${params}`);
  useLive(["draft", "compose", "thread"], () => void reload());

  const open = (d: DraftRow) => go(wide ? `/drafts/${draftKey(d)}` : d.kind === "reply" ? `/thread/${d.thread_id}` : `/compose/${d.id}`);
  const discard = async (d: DraftRow) => {
    if (!window.confirm(`Discard the draft "${d.subject || "(no subject)"}"? This also deletes it from Gmail Drafts.`)) return;
    try {
      await api(d.kind === "reply" ? `/api/drafts/${d.id}` : `/api/compose/${d.id}`, { method: "DELETE" });
      toast("Draft discarded");
      if (selected === draftKey(d)) go("/drafts");
      await reload();
    } catch (e) { toast((e as Error).message, "error"); }
  };

  return (
    <div>
      <div className="toolbar"><h1>Drafts</h1>{data && <span className="muted small">{data.length}</span>}
        <button className="btn small" onClick={() => void reload()} aria-label="Refresh drafts">↻</button></div>
      <div className="chips" role="group" aria-label="Show">
        {KINDS.map(([v, l]) => <button key={v} className="chip" aria-pressed={kind === v} onClick={() => setKind(v)}>{l}</button>)}
      </div>
      <div className="row" style={{ padding: "0 .8rem .5rem" }}>
        <input type="search" placeholder="Filter subject, recipient, text…" aria-label="Filter drafts" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
      </div>
      {error && <div className="banner error">{error}</div>}
      {!data && !error && <><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></>}
      {data && data.length === 0 && <div className="empty"><span className="big">✓</span>{q || kind !== "all" ? "No drafts match." : "No drafts waiting. Replies Claude writes will show up here."}</div>}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {(data ?? []).map((d, i) => {
          const to = d.to.length ? d.to.map(who).join(", ") : "No recipients yet";
          const review = d.kind === "reply" && d.origin === "model" && (d.confidence !== "high" || d.flags.length > 0 || d.open_questions > 0);
          return (
            <li key={`${d.kind}-${d.id}`} className="trow" style={{ ["--i" as string]: i }}>
              <div className="face" role="link" tabIndex={0} aria-current={selected === draftKey(d) ? "true" : undefined}
                aria-label={`${d.kind === "reply" ? "Reply" : "New email"} to ${to}: ${d.subject || "(no subject)"}`}
                onClick={() => open(d)} onKeyDown={(e) => { if (e.key === "Enter") open(d); }}>
                <Avatar name={d.person_name ?? d.to[0]?.name ?? null} email={d.to[0]?.email ?? "?"} />
                <span className="from">{d.to.length ? `To ${d.person_name ?? to}` : to}</span>
                <span className="muted small">{when(d.updated_at)}</span>
                <span className="subj">{d.subject || "(no subject)"}</span>
                {d.preview && <span className="sum">{d.preview}</span>}
                <span className="badges">
                  <span className={`badge${d.kind === "new" ? " accent" : ""}`}>{d.kind === "reply" ? "Reply" : "New email"}</span>
                  {d.origin === "model" && d.model_key && <span className="badge ok">Claude · {modelLabel(d.model_key)}</span>}
                  {d.origin === "user" && d.kind === "reply" && <span className="badge">Edited by you</span>}
                  {review && <span className="badge warn">Needs review</span>}
                  {d.flags.includes("possible_prompt_injection") && <span className="badge danger">⚠ Injection?</span>}
                  {d.in_gmail && <span className="badge">In Gmail</span>}
                  <button className="btn ghost small" style={{ marginLeft: "auto" }} aria-label={`Discard draft ${d.subject}`}
                    onClick={(e) => { e.stopPropagation(); void discard(d); }}>Discard</button>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
