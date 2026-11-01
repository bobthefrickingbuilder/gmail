/** USAGE DASHBOARD — tokens and cost by model and by day, budget, and the draft quality signal. */
import { useApi } from "../hooks";
import { money, modelLabel } from "../format";

interface U { days: number; monthToDate: number; budget: number; byModel: Record<string, { cost: number; input: number; output: number; calls: number }>;
  byDay: Record<string, { cost: number; input: number; output: number; byModel: Record<string, number> }>; quality: Record<string, number> }

export function Usage() {
  const { data } = useApi<U>("/api/usage?days=30");
  if (!data) return <div className="empty">Loading…</div>;
  const q = { unedited: data.quality.unedited ?? 0, edited: data.quality.edited ?? 0, discarded: data.quality.discarded ?? 0 };
  const total = q.unedited + q.edited + q.discarded;
  const pct = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : "—");
  const days = Object.entries(data.byDay).sort((a, b) => b[0].localeCompare(a[0]));
  const models = Object.keys(data.byModel);
  return (
    <div>
      <div className="toolbar"><a className="btn small" href="#/settings" aria-label="Back">‹</a><h1>Usage</h1></div>
      <div className="content">
        <section className="card"><h3>This month</h3>
          <p style={{ fontSize: "1.6rem", margin: 0 }}>{money(data.monthToDate)} <span className="muted small">of {money(data.budget)} budget</span></p>
          {data.budget > 0 && data.monthToDate >= data.budget && <p className="error-text">Budget reached: automatic drafting is paused. Manual drafting still works.</p>}
        </section>
        <section className="card"><h3>Draft quality (all time)</h3>
          <table><thead><tr><th>Outcome</th><th className="num">Drafts</th><th className="num">Share</th></tr></thead><tbody>
            <tr><td>Sent/saved without edits</td><td className="num">{q.unedited}</td><td className="num">{pct(q.unedited)}</td></tr>
            <tr><td>Edited before sending/saving</td><td className="num">{q.edited}</td><td className="num">{pct(q.edited)}</td></tr>
            <tr><td>Discarded</td><td className="num">{q.discarded}</td><td className="num">{pct(q.discarded)}</td></tr></tbody></table>
        </section>
        <section className="card"><h3>By model (last {data.days} days)</h3>
          <table><thead><tr><th>Model</th><th className="num">Calls</th><th className="num">Input tokens</th><th className="num">Output tokens</th><th className="num">Cost</th></tr></thead>
            <tbody>{Object.entries(data.byModel).map(([k, m]) => <tr key={k}><td>{modelLabel(k)}</td><td className="num">{m.calls}</td><td className="num">{m.input.toLocaleString()}</td><td className="num">{m.output.toLocaleString()}</td><td className="num">{money(m.cost)}</td></tr>)}</tbody></table>
        </section>
        <section className="card"><h3>By day</h3>
          <table><thead><tr><th>Day</th>{models.map((m) => <th key={m} className="num">{modelLabel(m)}</th>)}<th className="num">Tokens</th><th className="num">Total</th></tr></thead>
            <tbody>{days.map(([d, v]) => <tr key={d}><td>{d}</td>{models.map((m) => <td key={m} className="num">{money(v.byModel[m] ?? 0)}</td>)}<td className="num">{(v.input + v.output).toLocaleString()}</td><td className="num">{money(v.cost)}</td></tr>)}</tbody></table>
          {days.length === 0 && <p className="muted">No usage yet.</p>}
        </section>
      </div>
    </div>
  );
}
