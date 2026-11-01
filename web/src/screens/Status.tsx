/** STATUS — last successful poll, queue depth, Google token validity, recent errors. */
import { api } from "../api";
import { useApi } from "../hooks";
import { dateTime } from "../format";

interface St { worker: { lastPollAt: string | null; lastSuccessAt: string | null; lastError: string | null; running: boolean; processed: number };
  accounts: { email: string; status: string; last_sync_at: string | null; last_error: string | null }[]; queueDepth: number; attention: number;
  recentErrors: { at: string; error: string }[]; mock: boolean; version: string }

export function Status() {
  const { data, reload } = useApi<St>("/api/status");
  if (!data) return <div className="empty">Loading…</div>;
  const w = data.worker;
  const stale = w.lastSuccessAt ? Date.now() - new Date(w.lastSuccessAt).getTime() > 10 * 60_000 : true;
  return (
    <div>
      <div className="toolbar"><a className="btn small" href="#/settings" aria-label="Back">‹</a><h1>Status</h1>
        <button className="btn small" onClick={() => api("/api/sync/now", { method: "POST" }).then(reload)}>Check mail now</button></div>
      <div className="content">
        {data.mock && <div className="banner info">Mock mode: Gmail, Calendar and Claude are simulated.</div>}
        <section className="card"><table><tbody>
          <tr><th scope="row">Last successful poll</th><td>{w.lastSuccessAt ? dateTime(w.lastSuccessAt) : "never"} {stale && <span className="badge danger">stale</span>}</td></tr>
          <tr><th scope="row">Last attempt</th><td>{w.lastPollAt ? dateTime(w.lastPollAt) : "—"}{w.running ? " (running)" : ""}</td></tr>
          <tr><th scope="row">Messages waiting for triage</th><td>{data.queueDepth}</td></tr>
          <tr><th scope="row">Needs attention</th><td><a href="#/attention">{data.attention}</a></td></tr>
          <tr><th scope="row">Processed since start</th><td>{w.processed}</td></tr>
          {w.lastError && <tr><th scope="row">Last error</th><td className="error-text">{w.lastError}</td></tr>}
          <tr><th scope="row">Server version</th><td>{data.version}</td></tr>
        </tbody></table></section>
        <section className="card"><h3>Google access</h3>
          {data.accounts.map((a) => <p key={a.email}>{a.email}: <span className={`badge ${a.status === "ok" ? "ok" : "danger"}`}>{a.status === "ok" ? "token valid" : a.status}</span>{a.last_error ? <span className="error-text small"> {a.last_error}</span> : null}</p>)}</section>
        {data.recentErrors.length > 0 && <section className="card"><h3>Recent model / draft errors</h3><ul className="small">{data.recentErrors.map((e, i) => <li key={i}>{dateTime(e.at)} — {e.error}</li>)}</ul></section>}
      </div>
    </div>
  );
}
