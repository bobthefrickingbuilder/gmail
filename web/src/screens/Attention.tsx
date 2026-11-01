/** NEEDS ATTENTION — failures after retries (dead-letter queue): retry or dismiss. */
import { api } from "../api";
import { useApi, useLive } from "../hooks";
import { dateTime } from "../format";

export function Attention() {
  const { data, reload } = useApi<{ id: string; kind: string; ref_id: string | null; error: string; attempts: number; updated_at: string }[]>("/api/attention");
  useLive(["attention"], () => void reload());
  return (
    <div>
      <div className="toolbar"><a className="btn small" href="#/inbox" aria-label="Back">‹</a><h1>Needs attention</h1></div>
      <div className="content">
        {data?.length === 0 && <div className="empty">All clear.</div>}
        {data?.map((d) => <section key={d.id} className="card">
          <div className="row"><span className="badge danger">{d.kind}</span><span className="muted small">{dateTime(d.updated_at)} · {d.attempts} attempt(s)</span></div>
          <p>{d.error}</p>
          <div className="row">{d.kind === "draft" && d.ref_id && <a className="btn small" href={`#/thread/${d.ref_id}`}>Open email</a>}
            <button className="btn small primary" onClick={() => api(`/api/attention/${d.id}/retry`, { method: "POST" }).then(reload, (e) => alert(e.message))}>Retry</button>
            <button className="btn small" onClick={() => api(`/api/attention/${d.id}/resolve`, { method: "POST" }).then(reload)}>Dismiss</button></div>
        </section>)}
      </div>
    </div>
  );
}
