/**
 * API CLIENT
 * Every call to the backend goes through `api()`. It:
 *  - attaches the short-lived access token
 *  - refreshes it automatically when it expires (refresh token rotation)
 *  - caches GET results for offline reading
 *  - queues draft edits when offline (see offline.ts)
 */
import { apiBase } from "./config";
import { cacheGet, cachePut, enqueue, queue, setQueue, saveTokens, loadRefresh, clearAll } from "./offline";

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
type Listener = () => void;
const authListeners = new Set<Listener>();
export const onAuthChange = (l: Listener) => { authListeners.add(l); return () => { authListeners.delete(l); }; };
const fire = () => authListeners.forEach((l) => l());

export class ApiError extends Error {
  constructor(public status: number, message: string, public data: Record<string, unknown> = {}) { super(message); }
}

export const isSignedIn = () => Boolean(accessToken);
export const authHeader = (): Record<string, string> => (accessToken ? { Authorization: `Bearer ${accessToken}` } : {});

export async function setSession(s: { accessToken: string; refreshToken: string } | null) {
  accessToken = s?.accessToken ?? null;
  await saveTokens(s);
  fire();
}

export async function tryResume(): Promise<boolean> {
  if (accessToken) return true;
  return refresh();
}

async function refresh(): Promise<boolean> {
  if (refreshing) return refreshing;
  const work = async () => {
    const rt = await loadRefresh();
    if (!rt) return false;
    try {
      const r = await fetch(`${apiBase()}/api/auth/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: rt }) });
      if (!r.ok) { if (r.status === 401) await setSession(null); return false; }
      await setSession(await r.json());
      return true;
    } catch { return false; }
  };
  // One refresh at a time across tabs: two tabs sending the same refresh token
  // looks like token theft to the server, which then revokes the session.
  // Inside the lock each tab re-reads the token the previous tab just saved.
  const locked = typeof navigator !== "undefined" && navigator.locks ? navigator.locks.request("auth-refresh", work) : work();
  refreshing = locked.finally(() => { refreshing = null; });
  return refreshing;
}

export async function signOut() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* ignore */ }
  accessToken = null;
  await clearAll();
  fire();
}

export interface ApiOptions { method?: string; body?: unknown; offlineQueue?: boolean; noAuth?: boolean }

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const doFetch = () => fetch(`${apiBase()}${path}`, {
    method,
    headers: { ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(accessToken && !opts.noAuth ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let res: Response;
  try {
    res = await doFetch();
  } catch {
    // offline
    if (method === "GET") {
      const c = await cacheGet<T>(path);
      if (c) { markOffline(true); return c.data; }
    } else if (opts.offlineQueue) {
      await enqueue({ method, url: path, body: opts.body });
      markOffline(true);
      return { queued: true } as T;
    }
    markOffline(true);
    throw new ApiError(0, "You're offline");
  }
  markOffline(false);
  if (res.status === 401 && !opts.noAuth && (await refresh())) res = await doFetch();
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? res.statusText, typeof data === "object" ? data : {});
  if (method === "GET" && path.startsWith("/api/threads")) void cachePut(path, data);
  return data as T;
}

// ---- offline indicator + queue flush ----
let offline = false;
const offlineListeners = new Set<(o: boolean) => void>();
export const onOffline = (l: (o: boolean) => void) => { offlineListeners.add(l); return () => { offlineListeners.delete(l); }; };
function markOffline(o: boolean) {
  if (o === offline) return;
  offline = o;
  offlineListeners.forEach((l) => l(o));
  if (!o) void flushQueue();
}
export async function flushQueue() {
  const q = await queue();
  const left = [];
  for (const item of q) {
    try { await api(item.url, { method: item.method, body: item.body }); } catch (e) { if ((e as ApiError).status === 0) left.push(item); }
  }
  await setQueue(left);
  return { sent: q.length - left.length, pending: left.length };
}
if (typeof window !== "undefined") window.addEventListener("online", () => void flushQueue());

// ---- live updates (SSE) ----
export function subscribeEvents(onEvent: (type: string, data: Record<string, unknown>) => void): () => void {
  let es: EventSource | null = null; let stopped = false; let retry: ReturnType<typeof setTimeout> | null = null;
  const connect = async () => {
    try {
      const { ticket } = await api<{ ticket: string }>("/api/events/ticket", { method: "POST" });
      if (stopped) return;
      es = new EventSource(`${apiBase()}/api/events?ticket=${encodeURIComponent(ticket)}`);
      for (const t of ["draft", "thread", "sync", "profile", "attention", "job", "compose", "tasks", "chat"])
        es.addEventListener(t, (e) => onEvent(t, JSON.parse((e as MessageEvent).data || "{}")));
      es.onerror = () => { es?.close(); if (!stopped) retry = setTimeout(connect, 10_000); };
    } catch { if (!stopped) retry = setTimeout(connect, 15_000); }
  };
  void connect();
  return () => { stopped = true; es?.close(); if (retry) clearTimeout(retry); };
}
