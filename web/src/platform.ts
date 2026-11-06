/**
 * PLATFORM GLUE
 * - Push: Web Push on iPad/desktop (needs the app installed to the Home
 *   Screen on iPad, iPadOS 16.4+); Firebase push inside the Android app.
 * - Update check: Android app compares its version with the latest APK.
 * - Android share sheet / app shortcut → routes inside the app.
 */
import { Capacitor } from "@capacitor/core";
import { api } from "./api";
import { APP_VERSION, apiBase, isNative } from "./config";
import { go } from "./router";

function urlB64ToUint8Array(base64: string) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function registerPush(ask = false): Promise<string> {
  if (isNative()) {
    // Without google-services.json, Firebase isn't initialised and calling
    // register() crashes the app on launch, so only use push when the APK was
    // built with Firebase (build-apk.sh sets VITE_FCM_ENABLED).
    if (import.meta.env.VITE_FCM_ENABLED !== "true") return "unsupported";
    const { PushNotifications } = await import("@capacitor/push-notifications");
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive !== "granted" && ask) perm = await PushNotifications.requestPermissions();
    if (perm.receive !== "granted") return "not-granted";
    await PushNotifications.addListener("registration", (t) => { void api("/api/push/subscribe", { method: "POST", body: { kind: "fcm", endpoint: t.value } }); });
    await PushNotifications.addListener("pushNotificationActionPerformed", (a) => { const u = a.notification.data?.url; if (u) window.location.hash = String(u).replace(/^\/?#?/, "#"); });
    await PushNotifications.register();
    return "registered";
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  const { publicKey } = await api<{ publicKey: string | null }>("/api/push/vapid");
  if (!publicKey) return "server-not-configured";
  if (Notification.permission !== "granted") {
    if (!ask) return "not-granted";
    if ((await Notification.requestPermission()) !== "granted") return "denied";
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
  const j = sub.toJSON();
  await api("/api/push/subscribe", { method: "POST", body: { kind: "webpush", endpoint: j.endpoint, keys: j.keys } });
  return "registered";
}

const newer = (a: string, b: string) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0); }
  return false;
};
export async function checkForUpdate(): Promise<{ version: string; url: string } | null> {
  if (Capacitor.getPlatform() !== "android") return null;
  const v = await api<{ android: { version: string; url: string } | null }>("/api/app/version");
  return v.android && newer(v.android.version, APP_VERSION) ? { version: v.android.version, url: `${apiBase()}${v.android.url}` } : null;
}

/** Android: text shared into the app arrives via a deep link set by MainActivity (#/share?text=…). */
if (isNative()) {
  void import("@capacitor/app").then(({ App }) => {
    void App.addListener("appUrlOpen", (e) => { const h = e.url.split("#")[1]; if (h) go(h); });
  });
}
