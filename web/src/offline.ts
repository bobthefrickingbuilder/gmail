/**
 * OFFLINE SUPPORT
 * - Recent inbox lists and threads are cached on the device (IndexedDB) so
 *   they can be read without a connection.
 * - Draft edits made offline are queued and sent when you're back online.
 * Cached data is cleared when you sign out.
 */
import { get, set, del, keys, createStore } from "idb-keyval";

const store = typeof indexedDB !== "undefined" ? createStore("assistant-cache", "kv") : undefined;
const mem = new Map<string, unknown>();

async function g<T>(k: string): Promise<T | undefined> { if (!store) return mem.get(k) as T | undefined; try { return await get<T>(k, store); } catch { return mem.get(k) as T | undefined; } }
async function s(k: string, v: unknown) { if (!store) { mem.set(k, v); return; } try { await set(k, v, store); } catch { mem.set(k, v); } }

export const cacheGet = <T>(url: string) => g<{ at: string; data: T }>(`get:${url}`);
export const cachePut = (url: string, data: unknown) => s(`get:${url}`, { at: new Date().toISOString(), data });

export interface QueuedEdit { id: string; method: string; url: string; body: unknown; at: string }
export async function queue(): Promise<QueuedEdit[]> { return (await g<QueuedEdit[]>("queue")) ?? []; }
export async function enqueue(e: Omit<QueuedEdit, "id" | "at">) {
  const q = await queue();
  // keep only the latest edit for the same draft
  const rest = q.filter((x) => !(x.url === e.url && x.method === e.method));
  await s("queue", [...rest, { ...e, id: crypto.randomUUID(), at: new Date().toISOString() }]);
}
export async function setQueue(q: QueuedEdit[]) { await s("queue", q); }

export async function clearAll() {
  mem.clear();
  if (!store) return;
  for (const k of await keys(store)) await del(k, store);
}

export async function saveTokens(t: { refreshToken: string } | null) { await s("refresh", t?.refreshToken ?? null); }
export async function loadRefresh(): Promise<string | null> { return (await g<string | null>("refresh")) ?? null; }
