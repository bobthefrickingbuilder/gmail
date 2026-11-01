/** SIGN-IN, FIRST-RUN SETUP and the IDLE LOCK screen. */
import { useEffect, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { api, ApiError, setSession, signOut } from "../api";
import { apiBase, isNative, setApiBase } from "../config";

type Tokens = { accessToken: string; refreshToken: string };
const passkeySupported = () => typeof window !== "undefined" && "PublicKeyCredential" in window && !isNative();

export async function passkeyLogin(): Promise<Tokens> {
  const options = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/api/auth/passkey/login/options", { method: "POST", noAuth: true });
  const response = await startAuthentication({ optionsJSON: options });
  return api<Tokens>("/api/auth/passkey/login/verify", { method: "POST", body: { response }, noAuth: true });
}

function PasswordForm({ onTokens, submitLabel }: { onTokens: (t: Tokens) => void; submitLabel: string }) {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { onTokens(await api<Tokens>("/api/auth/login", { method: "POST", body: { password, totp: totp || undefined }, noAuth: true })); }
    catch (x) { const ex = x as ApiError; if (ex.data?.totpRequired) setNeedTotp(true); setErr(ex.message); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit}>
      <label htmlFor="pw">Password</label>
      <input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {needTotp && <><label htmlFor="totp">Authenticator code</label>
        <input id="totp" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" value={totp} onChange={(e) => setTotp(e.target.value)} autoFocus /></>}
      {err && <p className="error-text" role="alert">{err}</p>}
      <p><button className="btn primary" disabled={busy} style={{ width: "100%" }}>{busy ? "Signing in…" : submitLabel}</button></p>
    </form>
  );
}

export function Login({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<{ setupRequired: boolean; passkeys: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [server, setServer] = useState(apiBase());
  const [setupCode, setSetupCode] = useState("");
  const [pw1, setPw1] = useState(""); const [pw2, setPw2] = useState("");

  const load = () => api<{ setupRequired: boolean; passkeys: number }>("/api/auth/status", { noAuth: true }).then((s) => { setStatus(s); setErr(null); })
    .catch((e) => setErr(`Cannot reach the server${apiBase() ? ` at ${apiBase()}` : ""}: ${(e as Error).message}`));
  useEffect(() => { void load(); }, []);
  const done = async (t: Tokens) => { await setSession(t); onDone(); };

  const setup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw1 !== pw2) { setErr("Passwords do not match"); return; }
    try { await done(await api<Tokens>("/api/auth/setup", { method: "POST", body: { setupCode: setupCode.trim(), password: pw1 }, noAuth: true })); window.location.hash = "#/onboarding"; }
    catch (x) { setErr((x as Error).message); }
  };

  return (
    <main className="lock" aria-labelledby="t">
      <div className="auth-box card">
        <h1 id="t" style={{ marginTop: 0 }}>Email Assistant</h1>
        {(isNative() || err) && (
          <details open={Boolean(err) || !apiBase()}>
            <summary>Server address</summary>
            <div className="row" style={{ marginTop: ".4rem" }}>
              <input type="url" aria-label="Server address" placeholder="https://mail.example.com" value={server} onChange={(e) => setServer(e.target.value)} />
              <button className="btn" onClick={() => { setApiBase(server); void load(); }}>Connect</button>
            </div>
          </details>
        )}
        {err && <p className="error-text" role="alert">{err}</p>}
        {status?.setupRequired ? (
          <form onSubmit={setup}>
            <p className="muted">First run. Enter the setup code printed in the server log, then choose a password (12+ characters).</p>
            <label htmlFor="sc">Setup code</label>
            <input id="sc" type="text" inputMode="numeric" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} required />
            <label htmlFor="p1">New password</label>
            <input id="p1" type="password" autoComplete="new-password" minLength={12} value={pw1} onChange={(e) => setPw1(e.target.value)} required />
            <label htmlFor="p2">Repeat password</label>
            <input id="p2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
            <p><button className="btn primary" style={{ width: "100%" }}>Create login</button></p>
          </form>
        ) : status ? (
          <>
            {passkeySupported() && status.passkeys > 0 && (
              <p><button className="btn primary" style={{ width: "100%" }} onClick={() => passkeyLogin().then(done).catch((e) => setErr((e as Error).message))}>Sign in with passkey (Face ID / Touch ID)</button></p>
            )}
            <PasswordForm onTokens={done} submitLabel="Sign in" />
          </>
        ) : null}
      </div>
    </main>
  );
}

export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const unlock = async (t: Tokens) => { await setSession(t); onUnlock(); };
  return (
    <div className="lock" role="dialog" aria-modal="true" aria-labelledby="lk">
      <div className="auth-box card">
        <h2 id="lk" style={{ marginTop: 0 }}>Locked</h2>
        <p className="muted">The app locked itself after a period of inactivity.</p>
        {passkeySupported() && <p><button className="btn primary" style={{ width: "100%" }} autoFocus onClick={() => passkeyLogin().then(unlock).catch((e) => setErr((e as Error).message))}>Unlock with passkey</button></p>}
        <PasswordForm onTokens={unlock} submitLabel="Unlock" />
        {err && <p className="error-text">{err}</p>}
        <p><button className="btn ghost small" onClick={() => void signOut()}>Sign out</button></p>
      </div>
    </div>
  );
}
