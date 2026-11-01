import { describe, it, expect, beforeEach } from "vitest";
import { setup, authedServer } from "./helpers.js";
import { totpCode, verifyTotp, base32Decode, base32Encode, newTotpSecret } from "../src/auth/totp.js";
import { signAccess, verifyAccess } from "../src/auth/sessions.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { encrypt, decrypt } from "../src/crypto.js";

describe("crypto + auth primitives", () => {
  it("TOTP matches RFC 6238 test vector", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpCode(secret, 59_000).slice(-6)).toBe("287082");
    expect(verifyTotp(secret, totpCode(secret, Date.now() - 30000))).toBe(true); // one step drift OK
    expect(verifyTotp(secret, "000000x")).toBe(false);
    expect(base32Decode(base32Encode(Buffer.from("hello"))).toString()).toBe("hello");
  });
  it("access tokens expire and reject tampering", () => {
    const t = signAccess("sid", 60, 1000);
    expect(verifyAccess(t, 1030)).toEqual({ sid: "sid" });
    expect(verifyAccess(t, 2000)).toBeNull();
    expect(verifyAccess(t.slice(0, -2) + "xx", 1030)).toBeNull();
  });
  it("password hashing and token encryption", () => {
    const h = hashPassword("long password here");
    expect(verifyPassword("long password here", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
    const c = encrypt("refresh-token-value");
    expect(c).not.toContain("refresh");
    expect(decrypt(c)).toBe("refresh-token-value");
  });
});

describe("login flow over HTTP", () => {
  beforeEach(async () => { await setup(); });
  it("setup needs the code; then password + TOTP; refresh rotates; reuse revokes", async () => {
    const { buildServer } = await import("../src/server.js");
    const { ensureSetupCode } = await import("../src/routes/auth.js");
    await ensureSetupCode();
    const app = await buildServer();
    expect((await app.inject({ method: "GET", url: "/api/threads" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupCode: "111111", password: "a long test password" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupCode: "999999", password: "short" } })).statusCode).toBe(400);
    const s = (await app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupCode: "999999", password: "a long test password" } })).json();
    const auth = { authorization: `Bearer ${s.accessToken}` };
    const start = (await app.inject({ method: "POST", url: "/api/auth/totp/start", headers: auth })).json();
    expect((await app.inject({ method: "POST", url: "/api/auth/totp/confirm", headers: auth, payload: { code: totpCode(start.secret) } })).statusCode).toBe(200);
    const noCode = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "a long test password" } });
    expect(noCode.statusCode).toBe(401); expect(noCode.json().totpRequired).toBe(true);
    const ok = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "a long test password", totp: totpCode(start.secret) } });
    expect(ok.statusCode).toBe(200);
    const r1 = (await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: ok.json().refreshToken } })).json();
    expect(r1.refreshToken).not.toBe(ok.json().refreshToken);
    // reusing the old refresh token = theft signal → session revoked
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: ok.json().refreshToken } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: r1.refreshToken } })).statusCode).toBe(401);
    void newTotpSecret;
  });
  it("rejects disallowed origins and sets security headers", async () => {
    const { call, app, accessToken } = await authedServer();
    const r = await app.inject({ method: "POST", url: "/api/sync/now", headers: { authorization: `Bearer ${accessToken}`, origin: "https://evil.example" } });
    expect(r.statusCode).toBe(403);
    const h = (await call("GET", "/api/health")).headers;
    expect(h["strict-transport-security"]).toContain("max-age=31536000");
    expect(h["x-content-type-options"]).toBe("nosniff");
    const pre = await app.inject({ method: "OPTIONS", url: "/api/threads", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
