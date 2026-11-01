/** ONBOARDING — connect Google, import history & seed profiles, review the style guide, run a test draft. */
import { useState } from "react";
import { api } from "../api";
import { useApi, useLive } from "../hooks";
import { registerPush } from "../platform";

export function Onboarding() {
  const status = useApi<{ accounts: { email: string; status: string; provider: string }[]; mock: boolean }>("/api/status");
  const jobs = useApi<{ id: string; kind: string; status: string; progress: { phase?: string; scanned?: number; profiled?: number; total?: number }; error: string | null }[]>("/api/jobs");
  useLive(["job"], () => void jobs.reload());
  const [months, setMonths] = useState(12);
  const [test, setTest] = useState<string | null>(null);
  const connected = status.data?.accounts.some((a) => a.status === "ok");
  const seed = jobs.data?.find((j) => j.kind === "seed");
  const step = (n: number, title: string, done: boolean, children: React.ReactNode) => (
    <section className="card"><h3>{done ? "✓" : n}. {title}</h3>{children}</section>);
  return (
    <div>
      <div className="toolbar"><a className="btn small" href="#/settings" aria-label="Back">‹</a><h1>Set up</h1></div>
      <div className="content">
        {step(1, "Connect Google (Gmail + Calendar)", Boolean(connected), <>
          {status.data?.accounts.map((a) => <p key={a.email}>{a.email} — {a.status}</p>)}
          <button className="btn primary" onClick={async () => { const r = await api<{ url: string | null }>("/api/google/connect"); if (r.url) window.open(r.url, "_blank"); else alert("Mock mode: already connected to the fake mailbox."); }}>Connect Google</button>
          <button className="btn" onClick={() => status.reload()}>Refresh</button></>)}
        {step(2, "Import history and seed profiles", seed?.status === "done", <>
          <p className="small muted">Scans your sent mail to find the people you write to most and builds a short profile for each. You can pause it; it resumes where it left off.</p>
          <div className="row"><label className="inline">Months to scan <input type="number" min={1} max={36} value={months} onChange={(e) => setMonths(Number(e.target.value))} style={{ width: "5rem" }} /></label>
            <button className="btn primary" disabled={seed?.status === "running"} onClick={() => api("/api/jobs/seed", { method: "POST", body: { months } }).then(() => jobs.reload())}>Start import</button>
            {seed?.status === "running" && <button className="btn" onClick={() => api(`/api/jobs/${seed.id}/pause`, { method: "POST" }).then(() => jobs.reload())}>Pause</button>}
            {seed?.status === "paused" && <button className="btn" onClick={() => api(`/api/jobs/${seed.id}/resume`, { method: "POST" }).then(() => jobs.reload())}>Resume</button>}</div>
          {seed && <p className="small" role="status">Status: {seed.status} · {seed.progress.phase} · scanned {seed.progress.scanned ?? 0} sent emails · profiles {seed.progress.profiled ?? 0}/{seed.progress.total ?? "?"}{seed.error ? ` · ${seed.error}` : ""}</p>}
          {seed && <progress max={seed.progress.total || 1} value={seed.progress.profiled ?? 0} style={{ width: "100%" }} aria-label="Import progress" />}</>)}
        {step(3, "Review your style guide", false, <p><a className="btn" href="#/settings">Open Settings → Style guide</a></p>)}
        {step(4, "Turn on notifications", false, <button className="btn" onClick={() => registerPush(true).then((r) => alert(r === "registered" ? "Notifications enabled" : r === "unsupported" ? "On iPad: install to Home Screen first (Share → Add to Home Screen), then try again from the installed app." : r))}>Enable notifications</button>)}
        {step(5, "Run a test draft", Boolean(test), <>
          <button className="btn primary" onClick={async () => {
            const r = await api<{ draft_body: string }>("/api/scratch", { method: "POST", body: { text: "Hi Matthew,\n\nWould you be available to sing the bass solos in our spring concert? We rehearse on Tuesday evenings.\n\nBest,\nA conductor" } });
            setTest(r.draft_body); }}>Draft a sample reply</button>
          {test && <pre className="mail card">{test}</pre>}</>)}
      </div>
    </div>
  );
}
