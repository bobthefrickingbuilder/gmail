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
    const { PushNotifications } = await import("@capacitor/push-notifications");
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive !== "granted" && ask) perm = await PushNotifications.requestPermissions();
    if (perm.receive !== "granted") return "not-granted";
    // Android hands us a Firebase token; iOS an APNs device token (hex).
    const kind = Capacitor.getPlatform() === "ios" ? "apns" : "fcm";
    await PushNotifications.removeAllListeners();
    const failed = new Promise<string>((resolve) => {
      void PushNotifications.addListener("registrationError", () => resolve(kind === "apns" ? "ios-push-unavailable" : "failed"));
    });
    const ok = new Promise<string>((resolve) => {
      void PushNotifications.addListener("registration", (t) => { void api("/api/push/subscribe", { method: "POST", body: { kind, endpoint: t.value } }); resolve("registered"); });
    });
    await PushNotifications.addListener("pushNotificationActionPerformed", (a) => { const u = a.notification.data?.url; if (u) window.location.hash = String(u).replace(/^\/?#?/, "#"); });
    await PushNotifications.register();
    // A sideloaded iOS app signed with a free Apple ID has no push entitlement: iOS reports an error.
    return Promise.race([ok, failed, new Promise<string>((r) => setTimeout(() => r("registered"), 10_000))]);
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

/** What to tell the person after registerPush(true). */
export function pushResultText(r: string): string {
  if (r === "registered") return "Notifications enabled on this device";
  if (r === "unsupported") return "On iPad in Safari, install the app to the Home Screen first (Share → Add to Home Screen), then try again from the installed app.";
  if (r === "ios-push-unavailable") return "This copy of the iPad app can't get notifications: apps installed with a free Apple ID aren't allowed push. Use the Home Screen web app for notifications, or rebuild with a paid developer account (docs/IOS.md).";
  return `Not enabled (${r})`;
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

/**
 * Deep links assistant://open#/route — Android share sheet and shortcuts (MainActivity),
 * iOS quick actions (AppDelegate) and the iOS Shortcuts "Draft from shared text" action.
 */
if (isNative()) {
  void import("@capacitor/app").then(async ({ App }) => {
    const open = (url: string | undefined) => { const h = url?.split("#")[1]; if (h) go(h); };
    void App.addListener("appUrlOpen", (e) => open(e.url));
    try { open((await App.getLaunchUrl())?.url); } catch { /* not launched from a link */ }
  });
}
