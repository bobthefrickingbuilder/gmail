/** Tiny hash router: works the same in Safari PWA, Capacitor and desktop browsers. */
import { useEffect, useState } from "react";

export interface Route { name: string; id?: string; query: URLSearchParams }

export function parseHash(hash: string): Route {
  const [path, qs] = hash.replace(/^#\/?/, "").split("?");
  const [name = "inbox", id] = path.split("/").filter(Boolean);
  return { name, id, query: new URLSearchParams(qs ?? "") };
}
export function useRoute(): Route {
  const [r, setR] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setR(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}
export const go = (path: string) => { window.location.hash = path.startsWith("#") ? path : `#${path}`; };
