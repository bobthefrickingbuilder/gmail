/**
 * WHERE IS THE SERVER?
 * - PWA (iPad/desktop): served by the backend itself → same origin, base "".
 * - Android (Capacitor): the app is bundled, so it needs the backend URL.
 *   It comes from VITE_API_BASE at build time, and can be changed on the
 *   sign-in screen ("Server address"), saved on the device.
 */
import { Capacitor } from "@capacitor/core";

export const isNative = () => Capacitor.isNativePlatform();
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? "0.0.0";

export function apiBase(): string {
  try {
    const saved = localStorage.getItem("serverUrl");
    if (saved) return saved.replace(/\/$/, "");
  } catch { /* storage unavailable */ }
  const built = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
  return built.replace(/\/$/, "");
}
export function setApiBase(url: string) {
  try { if (url) localStorage.setItem("serverUrl", url.replace(/\/$/, "")); else localStorage.removeItem("serverUrl"); } catch { /* ignore */ }
}
