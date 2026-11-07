/** SETTINGS — every knob from the brief, grouped into sections. Changes save immediately. */
import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { api, signOut } from "../api";
import { apiUrl } from "../apiUrl";
import { useApi, useFlash, useLive } from "../hooks";
import { registerPush } from "../platform";
import { dateTime } from "../format";
import { APP_VERSION, isNative } from "../config";

interface S {
  default_model: string; start_on_sonnet: boolean; escalation_rules: { senders: string[]; labels: string[]; categories: string[]; model: string };
  draft_categories: string[]; auto_draft: boolean; auto_apply_profile_updates: boolean; urgent_keywords: string[]; vip_emails: string[];
  working_hours: { start: string; end: string; days: number[] }; buffer_minutes: number; travel_buffer_minutes: number; travel_notes: string;
  no_go_windows: { day: number | null; start: string; end: string; label?: string }[]; calendars: string[]; polling_interval_seconds: number;
  notifications: { urgent: boolean; drafts: boolean; quiet_hours: { start: string; end: string } | null }; monthly_budget_usd: number; retention_days: number;
  idle_lock_minutes: number; theme: "system" | "light" | "dark"; timezone: string; reply_all_default: boolean; seed_months: number;
}
interface SettingsResp { settings: S; models: { default_draft_model: string; models: Record<string, { id: string; label: string; blurb?: string; input_per_mtok: number; output_per_mtok: number }> };
  signatures: { default: string; groups: Record<string, { label: string; text: string }>; prefer_gmail_signature: boolean }; categories: string[] }
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const list = (s: string) => s.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);

interface ContactsStatus { last_sync_at: string | null; google: "ok" | "needs_permission" | "error" | "never"; count: number; error?: string }

/** Address autocomplete source: Google contacts (needs the contacts permission) + everyone in your synced mail. */
function ContactsSection({ flash }: { flash: (t: string, k?: "info" | "error") => void }) {
  const st = useApi<ContactsStatus>("/api/contacts/status");
  const [busy, setBusy] = useState(false);
  const s = st.data;
  return (
    <Section title="Contacts (address autocomplete)">
      {s && <p className="small">{s.count} contacts{s.last_sync_at ? ` · refreshed ${dateTime(s.last_sync_at)}` : " · not built yet"}
        {" "}<span className={`badge ${s.google === "ok" ? "ok" : s.google === "never" ? "" : "warn"}`}>{s.google === "ok" ? "Google contacts connected" : s.google === "needs_permission" ? "Google contacts not allowed yet" : s.google === "error" ? "Google contacts error" : "not checked"}</span></p>}
      {s?.google === "needs_permission" && <div className="small">
        <p style={{ marginTop: 0 }}>Autocomplete works now from people in your mail. To also include your saved Google contacts (like Gmail does), one-time setup:</p>
        <ol style={{ margin: ".2rem 0 .6rem" }}>
          <li>In Google Cloud Console → APIs &amp; Services → Library, enable the <strong>People API</strong> for this app's project.</li>
          <li>Under Google Auth Platform → Data access, add the scopes <code>…/auth/contacts.readonly</code> and <code>…/auth/contacts.other.readonly</code>.</li>
          <li>Press <strong>Connect / reconnect Google</strong> above and allow contacts access, then Refresh below.</li>
        </ol></div>}
      {s?.error && <p className="error-text small">{s.error}</p>}
      <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await api("/api/contacts/sync", { method: "POST" }); await st.reload(); flash("Contacts refreshed"); } catch (e) { flash((e as Error).message, "error"); } finally { setBusy(false); } }}>
        {busy ? <span className="spinner" /> : "↻"} Refresh contacts</button>
      <p className="small muted">Refreshes by itself every 6 hours. Read only: the app never changes your Google contacts.</p>
    </Section>
  );
}

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return <details className="card" id={id}><summary><h3 style={{ display: "inline" }}>{title}</h3></summary><div style={{ marginTop: ".5rem" }}>{children}</div></details>;
}

export function Settings() {
  const { data, reload } = useApi<SettingsResp>("/api/settings");
  const status = useApi<{ accounts: { id: string; email: string; provider: string; status: string; last_sync_at: string | null; last_error: string | null }[] }>("/api/status");
  const { msg, flash } = useFlash();
  const [s, setS] = useState<S | null>(null);
  useEffect(() => { if (data) setS(data.settings); }, [data]);
  if (!data || !s) return <div className="empty"><span className="spinner" /></div>;
  const save = async (patch: Partial<S>) => {
    setS({ ...s, ...patch });
    try { await api("/api/settings", { method: "PUT", body: patch }); flash("Saved"); if (patch.theme) document.documentElement.dataset.theme = patch.theme === "system" ? "" : patch.theme; }
    catch (e) { flash((e as Error).message, "error"); void reload(); }
  };
  const models = Object.entries(data.models.models);

  return (
    <div>
      <div className="toolbar"><h1>Settings</h1><a className="btn small" href="#/usage">Usage</a><a className="btn small" href="#/status">Status</a><a className="btn small" href="#/onboarding">Setup</a></div>
      <div className="content">
        {msg && <div className={`banner ${msg.kind === "error" ? "error" : "info"}`} role="status">{msg.text}</div>}

        <Section title="Accounts & Google">
          {status.data?.accounts.map((a) => <div key={a.id} className="row"><span style={{ flex: 1 }}>{a.email} <span className="muted small">({a.provider})</span></span>
            <span className={`badge ${a.status === "ok" ? "ok" : "danger"}`}>{a.status === "reauth_required" ? "Reconnect needed" : a.status}</span>
            <span className="muted small">{a.last_sync_at ? `synced ${dateTime(a.last_sync_at)}` : "never synced"}</span></div>)}
          {status.data?.accounts.some((a) => a.status === "reauth_required") && <p className="error-text small">Google access expired or was revoked. Tap Connect Google to sign in again.</p>}
          <p className="row"><button className="btn primary" onClick={async () => { const r = await api<{ url: string | null; mock?: boolean }>("/api/google/connect"); if (r.url) window.open(r.url, "_blank"); else flash("Mock mode: Google is simulated"); }}>Connect / reconnect Google</button>
            {status.data?.accounts.filter((a) => a.provider === "google").map((a) => <button key={a.id} className="btn danger" onClick={() => { if (confirm("Disconnect this Google account?")) void api("/api/google/disconnect", { method: "POST", body: { accountId: a.id } }).then(() => status.reload()); }}>Disconnect {a.email}</button>)}</p>
        </Section>

        <ContactsSection flash={flash} />

        <Section title="Models & drafting">
          <table><thead><tr><th>Key</th><th>Model ID</th><th className="num">$ in / out per M tokens</th></tr></thead>
            <tbody>{models.map(([k, m]) => <tr key={k}><td>{m.label}</td><td><code>{m.id}</code></td><td className="num">{m.input_per_mtok} / {m.output_per_mtok}</td></tr>)}</tbody></table>
          <p className="small muted">Model IDs and prices live in config/models.json on the server.</p>
          <label htmlFor="dm">Default drafting model</label>
          <select id="dm" value={s.default_model} onChange={(e) => save({ default_model: e.target.value })}>{models.map(([k, m]) => <option key={k} value={k}>{m.label}{m.blurb ? ` · ${m.blurb}` : ""}</option>)}</select>
          <p className="small muted">Used for automatic drafts and as the starting choice on every draft. You can pick another model on any draft or new email.</p>
          <label className="inline"><input type="checkbox" checked={s.auto_draft} onChange={(e) => save({ auto_draft: e.target.checked })} /> Draft automatically when new mail arrives</label>
          <label className="inline"><input type="checkbox" checked={s.reply_all_default} onChange={(e) => save({ reply_all_default: e.target.checked })} /> Reply-all by default when others were copied</label>
          <label>Draft these categories automatically</label>
          <div className="row">{data.categories.map((c) => <label key={c} className="inline small"><input type="checkbox" checked={s.draft_categories.includes(c)}
            onChange={(e) => save({ draft_categories: e.target.checked ? [...s.draft_categories, c] : s.draft_categories.filter((x) => x !== c) })} />{c}</label>)}</div>
          <h4>Auto-escalation</h4>
          <label htmlFor="es">Senders (addresses or @domain), comma-separated</label>
          <input id="es" type="text" defaultValue={s.escalation_rules.senders.join(", ")} onBlur={(e) => save({ escalation_rules: { ...s.escalation_rules, senders: list(e.target.value) } })} />
          <label htmlFor="el">Gmail labels</label>
          <input id="el" type="text" defaultValue={s.escalation_rules.labels.join(", ")} onBlur={(e) => save({ escalation_rules: { ...s.escalation_rules, labels: list(e.target.value) } })} />
          <label>Categories</label>
          <div className="row">{data.categories.map((c) => <label key={c} className="inline small"><input type="checkbox" checked={s.escalation_rules.categories.includes(c)}
            onChange={(e) => save({ escalation_rules: { ...s.escalation_rules, categories: e.target.checked ? [...s.escalation_rules.categories, c] : s.escalation_rules.categories.filter((x) => x !== c) } })} />{c}</label>)}</div>
          <label htmlFor="em">…use model</label>
          <select id="em" value={s.escalation_rules.model} onChange={(e) => save({ escalation_rules: { ...s.escalation_rules, model: e.target.value } })}>{models.map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}</select>
          <label className="inline"><input type="checkbox" checked={s.auto_apply_profile_updates} onChange={(e) => save({ auto_apply_profile_updates: e.target.checked })} /> Apply profile updates automatically (otherwise you approve each one)</label>
        </Section>

        <StyleGuide />
        <Signatures sig={data.signatures} onSaved={reload} />
        <Triage s={s} save={save} />

        <Section title="Calendar & availability">
          <div className="row"><div style={{ flex: 1 }}><label htmlFor="ws">Working hours start</label><input id="ws" type="time" value={s.working_hours.start} onChange={(e) => save({ working_hours: { ...s.working_hours, start: e.target.value } })} /></div>
            <div style={{ flex: 1 }}><label htmlFor="we">End</label><input id="we" type="time" value={s.working_hours.end} onChange={(e) => save({ working_hours: { ...s.working_hours, end: e.target.value } })} /></div></div>
          <div className="row" style={{ marginTop: ".4rem" }}>{DAYS.map((d, i) => <label key={d} className="inline small"><input type="checkbox" checked={s.working_hours.days.includes(i)}
            onChange={(e) => save({ working_hours: { ...s.working_hours, days: e.target.checked ? [...s.working_hours.days, i].sort() : s.working_hours.days.filter((x) => x !== i) } })} />{d}</label>)}</div>
          <div className="row"><div style={{ flex: 1 }}><label htmlFor="bm">Buffer between events (min)</label><input id="bm" type="number" min={0} value={s.buffer_minutes} onChange={(e) => save({ buffer_minutes: Number(e.target.value) })} /></div>
            <div style={{ flex: 1 }}><label htmlFor="tb">Extra travel time around events with a location (min)</label><input id="tb" type="number" min={0} value={s.travel_buffer_minutes} onChange={(e) => save({ travel_buffer_minutes: Number(e.target.value) })} /></div></div>
          <label htmlFor="tn">Travel notes (for you; not sent to the model)</label>
          <textarea id="tn" rows={2} defaultValue={s.travel_notes} onBlur={(e) => save({ travel_notes: e.target.value })} />
          <label>No-go windows</label>
          {s.no_go_windows.map((n, i) => <div key={i} className="row small" style={{ marginBottom: ".3rem" }}>
            <select value={n.day ?? ""} onChange={(e) => { const w = [...s.no_go_windows]; w[i] = { ...n, day: e.target.value === "" ? null : Number(e.target.value) }; void save({ no_go_windows: w }); }} style={{ width: "auto" }}><option value="">Every day</option>{DAYS.map((d, j) => <option key={d} value={j}>{d}</option>)}</select>
            <input type="time" value={n.start} onChange={(e) => { const w = [...s.no_go_windows]; w[i] = { ...n, start: e.target.value }; void save({ no_go_windows: w }); }} style={{ width: "auto" }} />–
            <input type="time" value={n.end} onChange={(e) => { const w = [...s.no_go_windows]; w[i] = { ...n, end: e.target.value }; void save({ no_go_windows: w }); }} style={{ width: "auto" }} />
            <button className="btn small" onClick={() => save({ no_go_windows: s.no_go_windows.filter((_, j) => j !== i) })} aria-label="Remove window">✕</button></div>)}
          <button className="btn small" onClick={() => save({ no_go_windows: [...s.no_go_windows, { day: null, start: "12:00", end: "13:00" }] })}>Add no-go window</button>
          <Calendars selected={s.calendars} save={(c) => save({ calendars: c })} />
          <label htmlFor="tz">Time zone</label><input id="tz" type="text" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} onBlur={(e) => save({ timezone: e.target.value })} />
        </Section>

        <Section title="Notifications & polling">
          <p><button className="btn" onClick={() => registerPush(true).then((r) => flash(r === "registered" ? "Notifications enabled on this device" : r === "unsupported" && isNative() ? "This Android build has no Firebase set up, so notifications are off (see INSTALL.md §5 step 3)" : r === "unsupported" ? "On iPad, install the app to the Home Screen first (Share → Add to Home Screen)" : `Not enabled (${r})`))}>Enable notifications on this device</button></p>
          <label className="inline"><input type="checkbox" checked={s.notifications.urgent} onChange={(e) => save({ notifications: { ...s.notifications, urgent: e.target.checked } })} /> Urgent mail and VIP senders</label>
          <label className="inline"><input type="checkbox" checked={s.notifications.drafts} onChange={(e) => save({ notifications: { ...s.notifications, drafts: e.target.checked } })} /> Every new draft</label>
          <label className="inline"><input type="checkbox" checked={Boolean(s.notifications.quiet_hours)} onChange={(e) => save({ notifications: { ...s.notifications, quiet_hours: e.target.checked ? { start: "22:00", end: "07:30" } : null } })} /> Quiet hours</label>
          {s.notifications.quiet_hours && <div className="row"><input type="time" aria-label="Quiet from" value={s.notifications.quiet_hours.start} onChange={(e) => save({ notifications: { ...s.notifications, quiet_hours: { ...s.notifications.quiet_hours!, start: e.target.value } } })} style={{ width: "auto" }} /> to
            <input type="time" aria-label="Quiet until" value={s.notifications.quiet_hours.end} onChange={(e) => save({ notifications: { ...s.notifications, quiet_hours: { ...s.notifications.quiet_hours!, end: e.target.value } } })} style={{ width: "auto" }} /></div>}
          <p className="small muted">Notifications show only the sender and subject, never the email text.</p>
          <label htmlFor="pi">Check for new mail every (seconds)</label><input id="pi" type="number" min={30} value={s.polling_interval_seconds} onChange={(e) => save({ polling_interval_seconds: Number(e.target.value) })} />
        </Section>

        <Section title="Budget & data">
          <label htmlFor="bu">Monthly budget (USD) — pauses automatic drafting when reached</label><input id="bu" type="number" min={0} step={1} value={s.monthly_budget_usd} onChange={(e) => save({ monthly_budget_usd: Number(e.target.value) })} />
          <label htmlFor="rd">Delete stored email bodies after (days, 0 = keep)</label><input id="rd" type="number" min={0} value={s.retention_days} onChange={(e) => save({ retention_days: Number(e.target.value) })} />
          <p className="row"><a className="btn" href={apiUrl("/api/export")} onClick={async (e) => { e.preventDefault(); const r = await api<object>("/api/export"); const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 1)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = `assistant-export-${new Date().toISOString().slice(0, 10)}.json`; a.click(); }}>Export all data</a>
            <WipeButton /></p>
        </Section>

        <Security s={s} save={save} />

        <Section title="Appearance">
          <label htmlFor="th">Theme</label>
          <select id="th" value={s.theme} onChange={(e) => save({ theme: e.target.value as S["theme"] })}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>
          <p className="small muted">Text size follows your device's text-size setting.</p>
        </Section>
        <p className="muted small">App version {APP_VERSION}</p>
        <p><button className="btn" onClick={() => void signOut()}>Sign out</button></p>
      </div>
    </div>
  );
}

function Calendars({ selected, save }: { selected: string[]; save: (c: string[]) => void }) {
  const { data } = useApi<{ id: string; summary: string; primary: boolean; included: boolean }[]>("/api/calendar/calendars");
  if (!data) return null;
  return <><label>Calendars that count as busy</label>{data.map((c) => <label key={c.id} className="inline small"><input type="checkbox" checked={c.included}
    onChange={(e) => { const cur = selected.length ? selected : data.filter((x) => x.primary).map((x) => x.id); save(e.target.checked ? [...cur, c.id] : cur.filter((x) => x !== c.id)); }} />{c.summary}</label>)}</>;
}

function StyleGuide() {
  const g = useApi<{ text: string }>("/api/settings/style-guide");
  const props = useApi<{ id: string; summary: string; proposed_text: string; status: string; created_at: string }[]>("/api/style-proposals");
  const [text, setText] = useState("");
  const { msg, flash } = useFlash();
  useEffect(() => { if (g.data) setText(g.data.text); }, [g.data]);
  const pending = props.data?.filter((p) => p.status === "pending") ?? [];
  return (
    <Section title={`Style guide${pending.length ? ` · ${pending.length} suggestion` : ""}`} id="style">
      {pending.map((p) => <div key={p.id} className="card" style={{ borderColor: "var(--warn)" }}><strong>Suggested from your edits</strong><pre className="mail small">{p.summary}</pre>
        <details><summary className="small">Full proposed guide</summary><pre className="mail small">{p.proposed_text}</pre></details>
        <div className="row"><button className="btn primary small" onClick={() => api(`/api/style-proposals/${p.id}/accept`, { method: "POST" }).then(() => { void g.reload(); void props.reload(); })}>Accept</button>
          <button className="btn small" onClick={() => api(`/api/style-proposals/${p.id}/reject`, { method: "POST" }).then(() => props.reload())}>Reject</button></div></div>)}
      <label htmlFor="sg" className="sr-only">Style guide</label>
      <textarea id="sg" rows={16} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row"><button className="btn primary" onClick={() => api("/api/settings/style-guide", { method: "PUT", body: { text } }).then(() => flash("Style guide saved"), (e) => flash(e.message, "error"))}>Save style guide</button>
        <button className="btn" onClick={() => api<{ proposed: boolean; reason?: string }>("/api/learning/run", { method: "POST" }).then((r) => { flash(r.proposed ? "New suggestion created" : r.reason ?? "Nothing to learn yet"); void props.reload(); })}>Learn from my edits now</button></div>
      {msg && <p className="small" role="status">{msg.text}</p>}
    </Section>
  );
}

function Signatures({ sig, onSaved }: { sig: SettingsResp["signatures"]; onSaved: () => void }) {
  const [groups, setGroups] = useState(sig.groups);
  const { msg, flash } = useFlash();
  return (
    <Section title="Signatures">
      <label className="inline"><input type="checkbox" defaultChecked={sig.prefer_gmail_signature} onChange={(e) => api("/api/settings/signatures", { method: "PUT", body: { prefer_gmail_signature: e.target.checked } }).then(onSaved)} /> Use my Gmail signature when available</label>
      <p className="small muted">The templates below are used when Gmail has no signature, or when you pick one per person or per draft.</p>
      {Object.entries(groups).map(([k, g]) => <div key={k}><label htmlFor={`sig-${k}`}>{g.label} <span className="muted small">({k})</span></label>
        <textarea id={`sig-${k}`} rows={4} value={g.text} onChange={(e) => setGroups({ ...groups, [k]: { ...g, text: e.target.value } })} /></div>)}
      <p><button className="btn primary" onClick={() => api("/api/settings/signatures", { method: "PUT", body: { groups } }).then(() => { flash("Saved"); onSaved(); })}>Save signatures</button></p>
      {msg && <p className="small">{msg.text}</p>}
    </Section>
  );
}

function Triage({ s, save }: { s: S; save: (p: Partial<S>) => Promise<void> }) {
  const rules = useApi<{ id: string; match: string; action: string; value: string | null }[]>("/api/sender-rules");
  const [r, setR] = useState({ match: "", action: "skip", value: "" });
  return (
    <Section title="Triage, VIPs & urgent keywords">
      <label htmlFor="vip">VIP senders (comma-separated addresses)</label>
      <textarea id="vip" rows={2} defaultValue={s.vip_emails.join(", ")} onBlur={(e) => save({ vip_emails: list(e.target.value) })} />
      <label htmlFor="uk">Urgent keywords</label>
      <textarea id="uk" rows={2} defaultValue={s.urgent_keywords.join(", ")} onBlur={(e) => save({ urgent_keywords: list(e.target.value) })} />
      <label>Sender rules</label>
      <table><tbody>{rules.data?.map((x) => <tr key={x.id}><td>{x.match}</td><td>{x.action}{x.value ? `: ${x.value}` : ""}</td>
        <td><button className="btn small" onClick={() => api(`/api/sender-rules/${x.id}`, { method: "DELETE" }).then(() => rules.reload())} aria-label={`Remove rule ${x.match}`}>✕</button></td></tr>)}</tbody></table>
      <div className="row" style={{ marginTop: ".4rem" }}>
        <input type="text" aria-label="Match" placeholder="address, @domain or label:NAME" value={r.match} onChange={(e) => setR({ ...r, match: e.target.value })} style={{ flex: 2 }} />
        <select aria-label="Action" value={r.action} onChange={(e) => setR({ ...r, action: e.target.value })} style={{ flex: 1 }}><option value="skip">Skip</option><option value="vip">VIP</option><option value="escalate">Use Sonnet/Opus</option><option value="category">Set category</option></select>
        {(r.action === "category" || r.action === "escalate") && <input type="text" aria-label="Value" placeholder={r.action === "category" ? "fyi" : "sonnet"} value={r.value} onChange={(e) => setR({ ...r, value: e.target.value })} style={{ flex: 1 }} />}
        <button className="btn" disabled={r.match.length < 2} onClick={() => api("/api/sender-rules", { method: "POST", body: { ...r, value: r.value || null } }).then(() => { setR({ match: "", action: "skip", value: "" }); void rules.reload(); })}>Add</button>
      </div>
    </Section>
  );
}

function Security({ s, save }: { s: S; save: (p: Partial<S>) => Promise<void> }) {
  const st = useApi<{ totpEnabled: boolean; passkeys: number }>("/api/auth/status");
  const sessions = useApi<{ id: string; device: string | null; last_used_at: string }[]>("/api/auth/sessions");
  const audit = useApi<{ id: string; ts: string; actor: string; action: string; target_type: string | null }[]>("/api/audit?limit=50");
  useLive(["draft"], () => void audit.reload());
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState({ current: "", next: "" });
  const { msg, flash } = useFlash();
  return (
    <Section title="Security">
      <label htmlFor="il">Lock the app after (minutes idle)</label>
      <input id="il" type="number" min={1} value={s.idle_lock_minutes} onChange={(e) => save({ idle_lock_minutes: Number(e.target.value) })} />
      <h4>Authenticator code (TOTP)</h4>
      {st.data?.totpEnabled ? <p className="badge ok">Enabled</p> : totp ? <>
        <p className="small">Add this key to your authenticator app (or open the link on this device), then enter the 6-digit code.</p>
        <p><code style={{ wordBreak: "break-all" }}>{totp.secret}</code> · <a href={totp.uri}>Open in authenticator</a></p>
        <div className="row"><input type="text" inputMode="numeric" aria-label="Code" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: "10rem" }} />
          <button className="btn primary" onClick={() => api("/api/auth/totp/confirm", { method: "POST", body: { code } }).then(() => { flash("Two-factor enabled"); setTotp(null); void st.reload(); }, (e) => flash(e.message, "error"))}>Confirm</button></div></>
        : <button className="btn" onClick={() => api<{ secret: string; uri: string }>("/api/auth/totp/start", { method: "POST" }).then(setTotp)}>Set up authenticator code</button>}
      <h4>Passkeys (Face ID / Touch ID / fingerprint)</h4>
      <p className="small">{st.data?.passkeys ?? 0} registered.</p>
      {"PublicKeyCredential" in window ? <button className="btn" onClick={async () => {
        try { const opts = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/passkey/register/options", { method: "POST" });
          const response = await startRegistration({ optionsJSON: opts });
          await api("/api/auth/passkey/register/verify", { method: "POST", body: { response, label: navigator.platform } }); flash("Passkey added"); void st.reload();
        } catch (e) { flash((e as Error).message, "error"); } }}>Add a passkey on this device</button> : <p className="small muted">Passkeys are not available in this app view; use password + code.</p>}
      <h4>Change password</h4>
      <div className="row"><input type="password" aria-label="Current password" placeholder="Current" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} style={{ flex: 1 }} />
        <input type="password" aria-label="New password" placeholder="New (12+ characters)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} style={{ flex: 1 }} />
        <button className="btn" onClick={() => api("/api/auth/password", { method: "POST", body: pw }).then(() => { flash("Password changed"); setPw({ current: "", next: "" }); }, (e) => flash(e.message, "error"))}>Change</button></div>
      <h4>Signed-in devices</h4>
      <ul className="small">{sessions.data?.map((x) => <li key={x.id} className="row"><span style={{ flex: 1 }}>{(x.device ?? "Unknown").slice(0, 60)} · {dateTime(x.last_used_at)}</span>
        <button className="btn small" onClick={() => api(`/api/auth/sessions/${x.id}`, { method: "DELETE" }).then(() => sessions.reload())}>Sign out</button></li>)}</ul>
      <details><summary><h4 style={{ display: "inline" }}>Audit log</h4></summary>
        <table><tbody>{audit.data?.map((a) => <tr key={a.id}><td className="small">{dateTime(a.ts)}</td><td>{a.actor}</td><td>{a.action}</td><td className="muted small">{a.target_type}</td></tr>)}</tbody></table></details>
      {msg && <p className="small" role="status">{msg.text}</p>}
    </Section>
  );
}

function WipeButton() {
  return <button className="btn danger" onClick={async () => {
    const phrase = prompt('This deletes ALL stored mail, drafts, profiles and settings from the assistant (Gmail itself is untouched). Type DELETE EVERYTHING to continue.');
    if (phrase !== "DELETE EVERYTHING") return;
    const password = prompt("Your password") ?? "";
    try { await api("/api/wipe", { method: "POST", body: { confirm: phrase, password } }); alert("Wiped."); location.reload(); } catch (e) { alert((e as Error).message); }
  }}>Wipe all data</button>;
}
