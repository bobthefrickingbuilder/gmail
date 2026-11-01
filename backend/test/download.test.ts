import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup, authedServer } from "./helpers.js";
import { resetEnv } from "../src/config.js";

describe("private APK download page, version check, cron", () => {
  it("is hidden without a password, requires basic auth, lists releases", async () => {
    await setup();
    let { app } = await authedServer();
    expect((await app.inject({ method: "GET", url: "/download" })).statusCode).toBe(404);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
    fs.writeFileSync(path.join(dir, "email-assistant-v0.2.0.apk"), "APK");
    fs.writeFileSync(path.join(dir, "releases.json"), JSON.stringify([{ version: "0.2.0", file: "email-assistant-v0.2.0.apk", date: "2026-11-01", notes: "First <b>build</b>" }]));
    resetEnv({ DOWNLOAD_PASSWORD: "s3cret-download", RELEASES_DIR: dir, CRON_SECRET: "cron-secret-value" });
    ({ app } = await authedServer());
    const noAuth = await app.inject({ method: "GET", url: "/download" });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.headers["www-authenticate"]).toContain("Basic");
    const auth = { authorization: `Basic ${Buffer.from("x:s3cret-download").toString("base64")}` };
    const page = await app.inject({ method: "GET", url: "/download", headers: auth });
    expect(page.body).toContain("Download v0.2.0");
    expect(page.body).toContain("First &lt;b&gt;build&lt;/b&gt;"); // escaped
    expect((await app.inject({ method: "GET", url: "/download/email-assistant-v0.2.0.apk", headers: auth })).body).toBe("APK");
    expect((await app.inject({ method: "GET", url: "/download/..%2F..%2Fetc%2Fpasswd", headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/app/version" })).json().android.version).toBe("0.2.0");
    expect((await app.inject({ method: "GET", url: "/api/cron/poll" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/cron/poll", headers: { authorization: "Bearer cron-secret-value" } })).statusCode).toBe(200);
    resetEnv({ DOWNLOAD_PASSWORD: undefined, RELEASES_DIR: undefined, CRON_SECRET: undefined });
  });
});
