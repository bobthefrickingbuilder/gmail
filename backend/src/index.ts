/**
 * ENTRY POINT — starts the database, the HTTP server and the background worker.
 *   npm run dev        (development, auto-reload)
 *   npm run mock       (from repo root: everything fake, no credentials needed)
 */
import fs from "node:fs";
import path from "node:path";
import { env, REPO_ROOT, resetEnv } from "./config.js";
import { getDb, now, uid } from "./db/index.js";
import { buildServer } from "./server.js";
import { startWorker } from "./worker/index.js";
import { ensureSetupCode } from "./routes/auth.js";
import { log } from "./log.js";
import { MOCK_OWNER } from "./providers/mail/fixtures.js";

async function main() {
  // Load .env from the repo root (Docker passes variables directly instead).
  const envFile = path.join(REPO_ROOT, ".env");
  if (fs.existsSync(envFile)) { process.loadEnvFile(envFile); resetEnv(); }
  const e = env();
  const db = await getDb();
  if (e.MOCK_MODE) {
    const acc = await db.selectFrom("accounts").select("id").where("provider", "=", "mock").executeTakeFirst();
    if (!acc) await db.insertInto("accounts").values({ id: uid(), email: MOCK_OWNER, provider: "mock", display_name: "Matthew Menard", enabled: 1, tokens_enc: null,
      history_id: null, send_as_json: "[]", status: "ok", last_sync_at: null, last_error: null, created_at: now() }).execute();
    log.warn("MOCK MODE: fake Gmail, Calendar and Claude. Nothing leaves this machine.");
  } else {
    for (const k of ["ENCRYPTION_KEY", "SESSION_SECRET", "ANTHROPIC_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const)
      if (!e[k]) log.warn(`${k} is not set — see .env.example`);
  }
  await ensureSetupCode();
  const app = await buildServer();
  await app.listen({ port: e.PORT, host: e.HOST });
  log.info(`Backend listening on http://${e.HOST}:${e.PORT} (public URL ${e.PUBLIC_URL})`);
  if (e.WORKER_ENABLED) await startWorker();
  const shutdown = async () => { await app.close(); await db.destroy(); process.exit(0); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}
main().catch((err) => { console.error(err); process.exit(1); });
