/** Tiny hash router: works the same in Safari PWA, Capacitor and desktop browsers.
 *  Screen changes use the View Transitions API where the browser has it, for a smooth cross-fade. */
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

export interface Route { name: string; id?: string; query: URLSearchParams }

export function parseHash(hash: string): Route {
  const [path, qs] = hash.replace(/^#\/?/, "").split("?");
  const [name = "inbox", id] = path.split("/").filter(Boolean);
  return { name, id, query: new URLSearchParams(qs ?? "") };
}
type VT = Document & { startViewTransition?: (cb: () => void) => unknown };
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
export function useRoute(): Route {
  const [r, setR] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => {
      const next = parseHash(window.location.hash);
      const doc = document as VT;
      if (doc.startViewTransition && !reducedMotion()) doc.startViewTransition(() => flushSync(() => setR(next)));
      else setR(next);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}
export const go = (path: string) => { window.location.hash = path.startsWith("#") ? path : `#${path}`; };
