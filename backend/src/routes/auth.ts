/**
 * LOGIN ROUTES
 * First run: the server prints a one-time SETUP CODE in its log; enter it
 * with your new password in the app. After that: password (+ authenticator
 * code once enabled), or a passkey (Face ID / Touch ID / fingerprint).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { getDb, now, uid } from "../db/index.js";
import { HttpError, parse, type Req } from "../http.js";
import { hashPassword, passwordProblems, verifyPassword } from "../auth/password.js";
import { newTotpSecret, otpauthUri, verifyTotp } from "../auth/totp.js";
import { createSession, refreshSession, revokeSession, signTicket } from "../auth/sessions.js";
import { decrypt, encrypt } from "../crypto.js";
import { audit } from "../audit.js";
import { authenticationOptions, registrationOptions, verifyAuthentication, verifyRegistration } from "../auth/webauthn.js";
import { log } from "../log.js";

let setupCode: string | null = null;
let pendingTotp: string | null = null;

export async function ensureSetupCode() {
  const db = await getDb();
  const user = await db.selectFrom("auth_user").select("id").executeTakeFirst();
  if (user) { setupCode = null; return null; }
  setupCode ??= process.env.SETUP_CODE || crypto.randomInt(100000, 999999).toString() + crypto.randomInt(100000, 999999).toString();
  log.warn(`FIRST-RUN SETUP CODE: ${setupCode}  (enter it in the app with your new password)`);
  return setupCode;
}
export const getSetupCode = () => setupCode;

async function user() {
  const db = await getDb();
  return db.selectFrom("auth_user").selectAll().executeTakeFirst();
}

const loginLimit = { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } };

export async function authRoutes(app: FastifyInstance) {
  app.get("/api/auth/status", async () => {
    const u = await user();
    const db = await getDb();
    const passkeys = await db.selectFrom("webauthn_credentials").select("id").execute();
    return { setupRequired: !u, totpEnabled: u?.totp_enabled === 1, passkeys: passkeys.length };
  });

  app.post("/api/auth/setup", loginLimit, async (req) => {
    const b = parse(z.object({ setupCode: z.string(), password: z.string() }), req.body);
    if (await user()) throw new HttpError(409, "Already set up");
    if (!setupCode || !crypto.timingSafeEqual(Buffer.from(b.setupCode.padEnd(64)), Buffer.from(setupCode.padEnd(64)))) throw new HttpError(403, "Wrong setup code");
    const problem = passwordProblems(b.password);
    if (problem) throw new HttpError(400, problem);
    const db = await getDb();
    await db.insertInto("auth_user").values({ id: uid(), password_hash: hashPassword(b.password), totp_secret_enc: null, totp_enabled: 0, created_at: now() }).execute();
    setupCode = null;
    await audit("user", "auth.setup", null, null);
    return createSession(String(req.headers["user-agent"] ?? ""));
  });

  app.post("/api/auth/login", loginLimit, async (req) => {
    const b = parse(z.object({ password: z.string(), totp: z.string().optional() }), req.body);
    const u = await user();
    if (!u?.password_hash || !verifyPassword(b.password, u.password_hash)) {
      await audit("user", "auth.login_failed", null, null);
      throw new HttpError(401, "Wrong password");
    }
    if (u.totp_enabled) {
      if (!b.totp) throw new HttpError(401, "Authenticator code required", { totpRequired: true });
      if (!verifyTotp(decrypt(u.totp_secret_enc!), b.totp)) throw new HttpError(401, "Wrong authenticator code", { totpRequired: true });
    }
    await audit("user", "auth.login", null, null, { method: "password" });
    return createSession(String(req.headers["user-agent"] ?? ""));
  });

  app.post("/api/auth/refresh", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const b = parse(z.object({ refreshToken: z.string() }), req.body);
    const s = await refreshSession(b.refreshToken);
    if (!s) throw new HttpError(401, "Session expired");
    return s;
  });

  app.post("/api/auth/logout", async (req: Req) => {
    if (req.sessionId) await revokeSession(req.sessionId);
    return { ok: true };
  });

  app.post("/api/auth/totp/start", async () => {
    pendingTotp = newTotpSecret();
    return { secret: pendingTotp, uri: otpauthUri(pendingTotp, "owner") };
  });
  app.post("/api/auth/totp/confirm", async (req) => {
    const b = parse(z.object({ code: z.string() }), req.body);
    if (!pendingTotp || !verifyTotp(pendingTotp, b.code)) throw new HttpError(400, "Code did not match; try again");
    const db = await getDb();
    await db.updateTable("auth_user").set({ totp_secret_enc: encrypt(pendingTotp), totp_enabled: 1 }).execute();
    pendingTotp = null;
    await audit("user", "auth.totp_enabled", null, null);
    return { ok: true };
  });
  app.post("/api/auth/password", async (req) => {
    const b = parse(z.object({ current: z.string(), next: z.string() }), req.body);
    const u = await user();
    if (!u?.password_hash || !verifyPassword(b.current, u.password_hash)) throw new HttpError(401, "Wrong password");
    const problem = passwordProblems(b.next);
    if (problem) throw new HttpError(400, problem);
    const db = await getDb();
    await db.updateTable("auth_user").set({ password_hash: hashPassword(b.next) }).execute();
    await audit("user", "auth.password_changed", null, null);
    return { ok: true };
  });

  // passkeys
  app.post("/api/auth/passkey/register/options", async () => registrationOptions());
  app.post("/api/auth/passkey/register/verify", async (req) => {
    const b = parse(z.object({ response: z.any(), label: z.string().nullable().optional() }), req.body);
    await verifyRegistration(b.response, b.label ?? null);
    await audit("user", "auth.passkey_added", null, null);
    return { ok: true };
  });
  app.post("/api/auth/passkey/login/options", loginLimit, async () => authenticationOptions());
  app.post("/api/auth/passkey/login/verify", loginLimit, async (req) => {
    const b = parse(z.object({ response: z.any() }), req.body);
    try { await verifyAuthentication(b.response); } catch (e) { throw new HttpError(401, (e as Error).message); }
    await audit("user", "auth.login", null, null, { method: "passkey" });
    return createSession(String(req.headers["user-agent"] ?? ""));
  });

  app.get("/api/auth/sessions", async () => {
    const db = await getDb();
    return db.selectFrom("sessions").select(["id", "device", "created_at", "last_used_at"]).where("revoked_at", "is", null)
      .where("expires_at", ">", now()).orderBy("last_used_at", "desc").execute();
  });
  app.delete("/api/auth/sessions/:id", async (req) => {
    await revokeSession((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post("/api/events/ticket", async (req: Req) => ({ ticket: signTicket(req.sessionId!) }));
}
