/**
 * Streamed chat replies: POST /api/chat/:id/messages answers with NDJSON
 * (one event per line) so tool activity shows up as it happens. Uses the same
 * bearer token as api(); if it has expired, an ordinary authed call refreshes
 * it and the request is retried once.
 */
import { api, authHeader, ApiError } from "./api";
import { apiUrl } from "./apiUrl";
import type { ChatEvent } from "./types";

export async function streamChat(chatId: string, body: { text: string; model?: string }, onEvent: (e: ChatEvent) => void, signal?: AbortSignal) {
  const send = () => fetch(apiUrl(`/api/chat/${chatId}/messages`), {
    method: "POST", signal, headers: { "Content-Type": "application/json", ...authHeader() }, body: JSON.stringify(body),
  });
  let res: Response;
  try { res = await send(); } catch (e) { if ((e as Error).name === "AbortError") throw e; throw new ApiError(0, "You're offline"); }
  if (res.status === 401) { await api("/api/chat").catch(() => undefined); res = await send(); } // refreshes the token
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new ApiError(res.status, data.error ?? (res.status === 429 ? "Too many messages — wait a minute." : res.statusText));
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line) { try { onEvent(JSON.parse(line) as ChatEvent); } catch { /* ignore a bad line */ } }
    }
    if (done) break;
  }
  if (buf.trim()) { try { onEvent(JSON.parse(buf) as ChatEvent); } catch { /* ignore */ } }
}
