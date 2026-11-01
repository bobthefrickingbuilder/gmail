import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

/** Fetch JSON from the API; `reload()` to refresh; refreshes on live events with matching type. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    setLoading(true);
    try { const d = await api<T>(path); if (my === seq.current) { setData(d); setError(null); } }
    catch (e) { if (my === seq.current) setError((e as ApiError).message); }
    finally { if (my === seq.current) setLoading(false); }
  }, [path]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setData(null); void reload(); }, [path, ...deps]);
  return { data, error, loading, reload, setData };
}

/** Live update bus (fed by the SSE connection in App). */
type Handler = (type: string, data: Record<string, unknown>) => void;
const handlers = new Set<Handler>();
export const liveBus = { emit: (t: string, d: Record<string, unknown>) => handlers.forEach((h) => h(t, d)) };
export function useLive(types: string[], fn: (data: Record<string, unknown>) => void) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => {
    const h: Handler = (t, d) => { if (types.includes(t)) ref.current(d); };
    handlers.add(h); return () => { handlers.delete(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.join(",")]);
}

export function useMedia(q: string) {
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const on = () => setM(mq.matches); mq.addEventListener("change", on); return () => mq.removeEventListener("change", on); }, [q]);
  return m;
}
export const useWide = () => useMedia("(min-width: 1100px) and (orientation: landscape), (min-width: 1300px)");

/** Toast-style status line. */
export function useFlash() {
  const [msg, setMsg] = useState<{ text: string; kind: "info" | "error" } | null>(null);
  const flash = useCallback((text: string, kind: "info" | "error" = "info") => { setMsg({ text, kind }); setTimeout(() => setMsg(null), 4000); }, []);
  return { msg, flash };
}
