/** Test harness: fresh in-memory database + fresh mock providers for each test file. */
import { resetEnv } from "../src/config.js";
import { createDb, migrate, setDb, now, uid } from "../src/db/index.js";
import { setProviders } from "../src/providers/index.js";
import { MockMailProvider } from "../src/providers/mail/mock.js";
import { MockCalendarProvider } from "../src/providers/calendar/mock.js";
import { MockLlmProvider } from "../src/providers/llm/mock.js";
import { MOCK_OWNER } from "../src/providers/mail/fixtures.js";

export async function setup(opts: { seed?: boolean } = {}) {
  resetEnv({ NODE_ENV: "test", MOCK_MODE: "true", DATABASE_URL: "sqlite::memory:", SETUP_CODE: "999999" });
  const db = createDb("sqlite::memory:");
  await migrate(db);
  setDb(db);
  const mail = new MockMailProvider(opts.seed ?? true);
  const calendar = new MockCalendarProvider();
  const llm = new MockLlmProvider();
  setProviders({ mail, calendar, llm });
  const accountId = uid();
  await db.insertInto("accounts").values({ id: accountId, email: MOCK_OWNER, provider: "mock", display_name: "Matthew Menard", enabled: 1,
    tokens_enc: null, history_id: null, send_as_json: "[]", status: "ok", last_sync_at: null, last_error: null, created_at: now() }).execute();
  return { db, mail, calendar, llm, accountId };
}

export async function authedServer() {
  const { buildServer } = await import("../src/server.js");
  const { ensureSetupCode } = await import("../src/routes/auth.js");
  await ensureSetupCode();
  const app = await buildServer();
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupCode: "999999", password: "a long test password" } });
  const { accessToken, refreshToken } = res.json();
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, payload: payload as object, headers: { authorization: `Bearer ${accessToken}` } });
  return { app, call, accessToken, refreshToken };
}
