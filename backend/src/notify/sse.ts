/**
 * LIVE UPDATES (Server-Sent Events)
 * The app keeps one connection open to /api/events. When something changes
 * (new draft, triage done, sync finished) we push a tiny event naming WHAT
 * changed (ids only, never content); the app then re-fetches that item.
 */
import type { ServerResponse } from "node:http";

type Client = { id: number; res: ServerResponse };
const clients = new Set<Client>();
let seq = 0;

export function addClient(res: ServerResponse): () => void {
  const c = { id: ++seq, res };
  clients.add(c);
  res.write(`event: hello\ndata: {}\n\n`);
  const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
  return () => { clearInterval(ping); clients.delete(c); };
}

export function emit(type: string, data: Record<string, unknown> = {}) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.res.write(payload); } catch { clients.delete(c); } }
}
export const clientCount = () => clients.size;
