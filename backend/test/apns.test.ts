import crypto from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { resetEnv } from "../src/config.js";
import { apnsBody, apnsConfigured, apnsJwt, sendApns } from "../src/notify/apns.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("APNs (iOS app push)", () => {
  afterAll(() => resetEnv({ APNS_KEY: undefined, APNS_KEY_ID: undefined, APNS_TEAM_ID: undefined }));

  it("is off until key, key id and team id are all set", () => {
    resetEnv({ APNS_KEY: undefined, APNS_KEY_ID: undefined, APNS_TEAM_ID: undefined });
    expect(apnsConfigured()).toBe(false);
    resetEnv({ APNS_KEY: pem.replace(/\n/g, "\\n"), APNS_KEY_ID: "ABC123DEFG", APNS_TEAM_ID: "TEAM123456" });
    expect(apnsConfigured()).toBe(true);
  });

  it("signs an ES256 token Apple can verify", () => {
    const jwt = apnsJwt(1_800_000_000_000);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iss: "TEAM123456", iat: 1_800_000_000 });
    const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
    expect(apnsJwt(1_800_000_000_000 + 10 * 60_000)).toBe(jwt); // reused within 50 minutes
  });

  it("sends only the short title and subject", () => {
    const b = apnsBody({ title: "Raj Patel", body: "Rehearsal Tuesday?", url: "/thread/t1", tag: "t1" });
    expect(b).toEqual({ aps: { alert: { title: "Raj Patel", body: "Rehearsal Tuesday?" }, sound: "default", "thread-id": "t1" }, url: "/thread/t1" });
  });

  it("rejects a malformed device token as dead without calling Apple", async () => {
    await expect(sendApns("not-a-token", { title: "a", body: "b" })).rejects.toMatchObject({ statusCode: 410 });
  });
});
