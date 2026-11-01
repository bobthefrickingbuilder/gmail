/**
 * PUSH NOTIFICATIONS
 * - iPad PWA / desktop: Web Push (VAPID keys in env).
 * - Android app: Firebase Cloud Messaging HTTP v1 (service-account JSON in env).
 * Payloads carry ONLY a title (sender) and body (subject) — never email text.
 * Quiet hours (Settings) suppress non-critical notifications.
 */
import webpush from "web-push";
import { GoogleAuth } from "google-auth-library";
import { env } from "../config.js";
import { getDb, now, uid, j, pj } from "../db/index.js";
import { getSettings } from "../settings.js";
import { log } from "../log.js";

export interface PushPayload { title: string; body: string; url?: string; tag?: string; critical?: boolean }

let vapidReady = false;
function setupVapid() {
  const e = env();
  if (vapidReady || !e.VAPID_PUBLIC_KEY || !e.VAPID_PRIVATE_KEY) return vapidReady;
  webpush.setVapidDetails(e.VAPID_SUBJECT, e.VAPID_PUBLIC_KEY, e.VAPID_PRIVATE_KEY);
  return (vapidReady = true);
}

export function inQuietHours(q: { start: string; end: string } | null, timeZone: string, at = new Date()): boolean {
  if (!q) return false;
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return q.start <= q.end ? hm >= q.start && hm < q.end : hm >= q.start || hm < q.end;
}

/** Strip anything that could be body text; enforce short sender/subject only. */
export function safePayload(p: PushPayload): PushPayload {
  return { title: p.title.slice(0, 80), body: p.body.replace(/\s+/g, " ").slice(0, 120), url: p.url, tag: p.tag, critical: p.critical };
}

export const sentLog: PushPayload[] = []; // last few (for the status screen and tests)

export async function sendPush(p: PushPayload) {
  const s = await getSettings();
  if (!p.critical && inQuietHours(s.notifications.quiet_hours, s.timezone)) return { skipped: "quiet_hours" };
  const payload = safePayload(p);
  sentLog.push(payload); if (sentLog.length > 20) sentLog.shift();
  const db = await getDb();
  const subs = await db.selectFrom("push_subscriptions").selectAll().execute();
  let delivered = 0;
  for (const sub of subs) {
    try {
      if (sub.kind === "webpush" && setupVapid()) {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: pj(sub.keys_json, { p256dh: "", auth: "" }) }, JSON.stringify(payload), { TTL: 3600 });
        delivered++;
      } else if (sub.kind === "fcm" && env().FCM_SERVICE_ACCOUNT_JSON) {
        await sendFcm(sub.endpoint, payload); delivered++;
      }
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.deleteFrom("push_subscriptions").where("id", "=", sub.id).execute();
      else log.warn({ kind: sub.kind, err: (e as Error).message }, "push failed");
    }
  }
  return { delivered };
}

let fcmAuth: GoogleAuth | null = null;
async function sendFcm(token: string, p: PushPayload) {
  const creds = JSON.parse(env().FCM_SERVICE_ACCOUNT_JSON!);
  fcmAuth ??= new GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
  const client = await fcmAuth.getClient();
  await client.request({
    url: `https://fcm.googleapis.com/v1/projects/${creds.project_id}/messages:send`, method: "POST",
    data: { message: { token, notification: { title: p.title, body: p.body }, data: { url: p.url ?? "/" }, android: { priority: p.critical ? "high" : "normal" } } },
  });
}

export async function subscribe(kind: "webpush" | "fcm", endpoint: string, keys: Record<string, string> = {}) {
  const db = await getDb();
  await db.deleteFrom("push_subscriptions").where("endpoint", "=", endpoint).execute();
  await db.insertInto("push_subscriptions").values({ id: uid(), kind, endpoint, keys_json: j(keys), created_at: now() }).execute();
}
