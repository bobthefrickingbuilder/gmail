/** Small additions to the API client: full URLs, and binary downloads with auth. */
import { api as baseApi, type ApiOptions } from "./api";
import { apiBase } from "./config";
export const apiUrl = (p: string) => `${apiBase()}${p}`;
export async function api<T = unknown>(path: string, opts: ApiOptions & { blob?: boolean } = {}): Promise<T> {
  if (!opts.blob) return baseApi<T>(path, opts);
  const { authHeader } = await import("./api");
  const r = await fetch(apiUrl(path), { headers: authHeader() });
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  return (await r.blob()) as T;
}
