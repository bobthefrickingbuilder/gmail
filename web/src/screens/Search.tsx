/** SEARCH across emails, profiles and drafts. */
import { useState } from "react";
import { useApi } from "../hooks";
import { when } from "../format";

export function SearchView({ q: initial }: { q: string }) {
  const [q, setQ] = useState(initial);
  const { data } = useApi<{ emails: { id: string; thread_id: string; subject: string; from_name: string | null; from_email: string; date: string; snippet: string | null }[];
    people: { id: string; display_name: string; organization: string | null }[]; drafts: { thread_id: string; subject: string; excerpt: string; created_at: string }[] }>(q.length >= 2 ? `/api/search?q=${encodeURIComponent(q)}` : null);
  return (
    <div>
      <div className="toolbar"><a className="btn small" href="#/inbox" aria-label="Back">‹</a><input type="search" autoFocus aria-label="Search" placeholder="Search emails, people, drafts" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="content">
        {data && <>
          <h2 className="group-h">People</h2>{data.people.map((p) => <p key={p.id}><a href={`#/person/${p.id}`}>{p.display_name}</a> <span className="muted small">{p.organization}</span></p>)}
          <h2 className="group-h">Emails</h2>{data.emails.map((e) => <p key={e.id}><a href={`#/thread/${e.thread_id}`}>{e.subject || "(no subject)"}</a> <span className="muted small">{e.from_name ?? e.from_email} · {when(e.date)}</span></p>)}
          <h2 className="group-h">Drafts</h2>{data.drafts.map((d, i) => <p key={i}><a href={`#/thread/${d.thread_id}`}>{d.subject}</a> <span className="muted small">{d.excerpt}</span></p>)}
        </>}
      </div>
    </div>
  );
}
