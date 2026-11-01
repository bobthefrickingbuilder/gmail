/**
 * VERCEL ENTRY POINT (alternative hosting; see docs/INSTALL.md → "Option B").
 * Vercel runs the API as a serverless function. There is no always-on worker,
 * so Vercel Cron calls /api/cron/poll on a schedule instead. Use Postgres
 * (DATABASE_URL=postgres://…) because serverless functions have no disk.
 * Live updates (SSE) are not reliable on serverless; the app falls back to
 * pull-to-refresh.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildServer } from "./server.js";
import { getDb } from "./db/index.js";
import { ensureSetupCode } from "./routes/auth.js";

let ready: ReturnType<typeof buildServer> | null = null;
async function app() {
  if (!ready) ready = (async () => { await getDb(); await ensureSetupCode(); const a = await buildServer(); await a.ready(); return a; })();
  return ready;
}
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const a = await app();
  a.server.emit("request", req, res);
}
