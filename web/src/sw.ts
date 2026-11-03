/// <reference lib="webworker" />
/**
 * SERVICE WORKER — makes the app open offline (cached app shell) and shows
 * push notifications (sender + subject only, as sent by the server).
 * API data is cached separately by the app in IndexedDB (see offline.ts).
 */
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: { url: string; revision: string | null }[] };

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// "Reload now?" → OK. vite-plugin-pwa sends { type: "SKIP_WAITING" }; the plain string is accepted too.
self.addEventListener("message", (e) => {
  const d = e.data as unknown;
  if (d === "SKIP_WAITING" || (typeof d === "object" && d !== null && (d as { type?: string }).type === "SKIP_WAITING")) void self.skipWaiting();
});

self.addEventListener("push", (event) => {
  let data: { title?: string; body?: string; url?: string; tag?: string } = {};
  try { data = event.data?.json() ?? {}; } catch { data = { title: "Email Assistant", body: event.data?.text() ?? "" }; }
  event.waitUntil(self.registration.showNotification(data.title ?? "Email Assistant", {
    body: data.body ?? "", tag: data.tag, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: data.url ?? "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string })?.url ?? "/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) { await c.focus(); (c as WindowClient).navigate(url).catch(() => undefined); return; } }
    await self.clients.openWindow(url);
  })());
});
