/**
 * APPLE PUSH (APNs) for the iOS/iPadOS app.
 * Token-based auth: a .p8 key from developer.apple.com (needs a paid Apple
 * Developer account). One HTTP/2 request per notification; the JWT is reused
 * for 50 minutes (Apple accepts 20–60).
 * Payload is the same short title/subject as every other push — never email text.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";
import { env } from "../config.js";
import type { PushPayload } from "./push.js";

export const apnsConfigured = () => { const e = env(); return !!(e.APNS_KEY && e.APNS_KEY_ID && e.APNS_TEAM_ID); };

function keyPem(): string {
  const k = env().APNS_KEY!.trim();
  if (k.includes("BEGIN PRIVATE KEY")) return k.replace(/\\n/g, "\n");
  return fs.readFileSync(k, "utf8");
}

let cached: { jwt: string; at: number } | null = null;
export function apnsJwt(nowMs = Date.now()): string {
  if (cached && nowMs - cached.at < 50 * 60_000) return cached.jwt;
  const e = env();
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "ES256", kid: e.APNS_KEY_ID })}.${b64({ iss: e.APNS_TEAM_ID, iat: Math.floor(nowMs / 1000) })}`;
  const sig = crypto.sign("sha256", Buffer.from(unsigned), { key: keyPem(), dsaEncoding: "ieee-p1363" }).toString("base64url");
  cached = { jwt: `${unsigned}.${sig}`, at: nowMs };
  return cached.jwt;
}

export function apnsBody(p: PushPayload) {
  return { aps: { alert: { title: p.title, body: p.body }, sound: "default", ...(p.tag ? { "thread-id": p.tag } : {}) }, url: p.url ?? "/" };
}

/** Sends one notification. Throws an error with statusCode 410/400 when the token is dead (caller removes it). */
export async function sendApns(token: string, p: PushPayload): Promise<void> {
  if (!/^[0-9a-f]{32,200}$/i.test(token)) throw Object.assign(new Error("bad APNs token"), { statusCode: 410 });
  const e = env();
  const host = e.APNS_PRODUCTION ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
  const session = http2.connect(host);
  try {
    await new Promise<void>((resolve, reject) => {
      session.on("error", reject);
      const req = session.request({
        ":method": "POST", ":path": `/3/device/${token}`,
        authorization: `bearer ${apnsJwt()}`, "apns-topic": e.APNS_BUNDLE_ID, "apns-push-type": "alert",
        "apns-priority": p.critical ? "10" : "5", "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
        "content-type": "application/json",
      });
      let status = 0, body = "";
      req.on("response", (h) => { status = Number(h[":status"]); });
      req.setEncoding("utf8");
      req.on("data", (c) => { body += c; });
      req.on("error", reject);
      req.on("end", () => {
        if (status === 200) return resolve();
        let reason = "";
        try { reason = JSON.parse(body).reason ?? ""; } catch { /* empty body */ }
        // Dead token → 410, or 400 BadDeviceToken (e.g. a sandbox token sent to production).
        const dead = status === 410 || (status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(reason));
        reject(Object.assign(new Error(`APNs ${status} ${reason}`.trim()), { statusCode: dead ? 410 : status }));
      });
      req.end(JSON.stringify(apnsBody(p)));
    });
  } finally {
    session.close();
  }
}
