/**
 * APP SESSIONS
 * - Access token: signed, valid 15 minutes, sent as "Authorization: Bearer …".
 * - Refresh token: random, valid 30 days, stored only as a hash; every use
 *   issues a new one and retires the old (rotation). Reusing an old refresh
 *   token revokes that session (theft detection).
 * The app also locks itself after an idle period (Settings → Security).
 */
import crypto from "node:crypto";
import { getDb, now, uid } from "../db/index.js";
import { randomToken, sessionSecret, sha256 } from "../crypto.js";

export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 30 * 86400;

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signAccess(sessionId: string, ttl = ACCESS_TTL_S, nowS = Math.floor(Date.now() / 1000)): string {
  const body = b64u(JSON.stringify({ sid: sessionId, exp: nowS + ttl, typ: "access" }));
  const sig = b64u(crypto.createHmac("sha256", sessionSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyAccess(token: string, nowS = Math.floor(Date.now() / 1000)): { sid: string } | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = b64u(crypto.createHmac("sha256", sessionSecret()).update(body).digest());
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (p.typ !== "access" || p.exp < nowS) return null;
    return { sid: p.sid };
  } catch { return null; }
}

/** Short-lived ticket for EventSource (which cannot send headers). */
export function signTicket(sessionId: string) {
  const body = b64u(JSON.stringify({ sid: sessionId, exp: Math.floor(Date.now() / 1000) + 60, typ: "sse" }));
  return `${body}.${b64u(crypto.createHmac("sha256", sessionSecret()).update("sse:" + body).digest())}`;
}
export function verifyTicket(t: string): { sid: string } | null {
  const [body, sig] = t.split(".");
  if (!body || !sig) return null;
  const expected = b64u(crypto.createHmac("sha256", sessionSecret()).update("sse:" + body).digest());
  if (expected !== sig) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  return p.typ === "sse" && p.exp >= Date.now() / 1000 ? { sid: p.sid } : null;
}

export async function createSession(device: string | null) {
  const db = await getDb();
  const id = uid();
  const refresh = randomToken();
  await db.insertInto("sessions").values({ id, refresh_hash: sha256(refresh), expires_at: new Date(Date.now() + REFRESH_TTL_S * 1000).toISOString(),
    device: device?.slice(0, 120) ?? null, created_at: now(), last_used_at: now(), revoked_at: null }).execute();
  return { accessToken: signAccess(id), refreshToken: `${id}.${refresh}`, expiresIn: ACCESS_TTL_S };
}

export async function refreshSession(token: string) {
  const db = await getDb();
  const [id, secret] = token.split(".");
  if (!id || !secret) return null;
  const s = await db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst();
  if (!s || s.revoked_at || new Date(s.expires_at).getTime() < Date.now()) return null;
  if (s.refresh_hash !== sha256(secret)) {
    await db.updateTable("sessions").set({ revoked_at: now() }).where("id", "=", id).execute(); // reuse → revoke
    return null;
  }
  const next = randomToken();
  await db.updateTable("sessions").set({ refresh_hash: sha256(next), last_used_at: now() }).where("id", "=", id).execute();
  return { accessToken: signAccess(id), refreshToken: `${id}.${next}`, expiresIn: ACCESS_TTL_S };
}

export async function sessionActive(sid: string) {
  const db = await getDb();
  const s = await db.selectFrom("sessions").select(["revoked_at", "expires_at"]).where("id", "=", sid).executeTakeFirst();
  return Boolean(s && !s.revoked_at && new Date(s.expires_at).getTime() > Date.now());
}

export async function revokeSession(sid: string) {
  const db = await getDb();
  await db.updateTable("sessions").set({ revoked_at: now() }).where("id", "=", sid).execute();
}
