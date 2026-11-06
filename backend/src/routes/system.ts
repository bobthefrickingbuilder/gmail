/**
 * SYSTEM ROUTES — health/status, live events, usage, audit log, needs-attention,
 * export & wipe, push subscriptions, style-guide proposals, Google connect,
 * app-version check, private APK download page, mock-mode helpers.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "kysely";
import { env, REPO_ROOT } from "../config.js";
import { getDb, now, uid } from "../db/index.js";
import { HttpError, parse } from "../http.js";
import { workerState, pollOnce } from "../worker/index.js";
import { openDeadLetters, resolveDeadLetter } from "../worker/deadletter.js";
import { usageSummary } from "../usage/cost.js";
import { addClient, clientCount } from "../notify/sse.js";
import { verifyTicket, sessionActive } from "../auth/sessions.js";
import { subscribe, sentLog } from "../notify/push.js";
import { decideProposal, runLearning } from "../learning/nightly.js";
import { consentUrl, exchangeCode, encryptTokens } from "../google/oauth.js";
import { resetProviderCache, getMockMail } from "../providers/index.js";
import { refreshSendAs } from "../mail/sync.js";
import { mailFor } from "../providers/index.js";
import { AI_LABELS } from "../drafting/gmail.js";
import { audit } from "../audit.js";
import { draftThread } from "../drafting/pipeline.js";
import { processNewMessage } from "../worker/process.js";
import { verifyPassword } from "../auth/password.js";
import { emit } from "../notify/sse.js";

const oauthStates = new Map<string, number>();

function readReleases(): { version: string; file: string; date: string; notes: string }[] {
  const f = path.join(path.resolve(env().RELEASES_DIR), "releases.json");
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; }
}

export async function systemRoutes(app: FastifyInstance) {
  app.get("/api/health", async () => {
    const db = await getDb();
    await sql`select 1`.execute(db);
    const stale = workerState.lastSuccessAt ? Date.now() - new Date(workerState.lastSuccessAt).getTime() > 15 * 60_000 : false;
    return { ok: !stale, version: appVersion(), mock: env().MOCK_MODE, lastSuccessfulPoll: workerState.lastSuccessAt };
  });

  app.get("/api/status", async () => {
    const db = await getDb();
    const accounts = await db.selectFrom("accounts").select(["id", "email", "provider", "status", "last_sync_at", "last_error", "enabled"]).execute();
    const attention = await openDeadLetters();
    const pendingTriage = await db.selectFrom("messages").leftJoin("triage", "triage.message_id", "messages.id")
      .select(sql<number>`count(*)`.as("n")).where("triage.id", "is", null).where("messages.is_from_me", "=", 0).executeTakeFirst();
    const llmErrors = attention.filter((a) => a.kind === "draft" || a.kind === "triage").slice(0, 5).map((a) => ({ at: a.updated_at, error: a.error }));
    return { worker: workerState, accounts, queueDepth: Number(pendingTriage?.n ?? 0), attention: attention.length, recentErrors: llmErrors,
      sseClients: clientCount(), lastPushes: sentLog.slice(-5), mock: env().MOCK_MODE, version: appVersion() };
  });

  app.post("/api/sync/now", async () => pollOnce());

  // Server-sent events. EventSource cannot send headers, so it uses a 60-second ticket from /api/events/ticket.
  app.get("/api/events", async (req, reply) => {
    const { ticket } = parse(z.object({ ticket: z.string() }), req.query);
    const t = verifyTicket(ticket);
    if (!t || !(await sessionActive(t.sid))) throw new HttpError(401, "Not signed in");
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive",
      "Access-Control-Allow-Origin": String(req.headers.origin ?? "") });
    const done = addClient(reply.raw);
    req.raw.on("close", done);
    return reply.hijack();
  });

  app.get("/api/usage", async (req) => usageSummary(parse(z.object({ days: z.coerce.number().default(30) }), req.query).days));

  app.get("/api/audit", async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().max(500).default(200) }), req.query);
    return (await getDb()).selectFrom("audit_log").selectAll().orderBy("ts", "desc").limit(q.limit).execute();
  });

  app.get("/api/attention", async () => openDeadLetters());
  app.post("/api/attention/:id/resolve", async (req) => { await resolveDeadLetter((req.params as { id: string }).id); return { ok: true }; });
  app.post("/api/attention/:id/retry", async (req) => {
    const db = await getDb();
    const d = await db.selectFrom("dead_letters").selectAll().where("id", "=", (req.params as { id: string }).id).executeTakeFirstOrThrow();
    if (d.kind === "draft" && d.ref_id) await draftThread(d.ref_id, { actor: "user" });
    else if (d.kind === "triage" && d.ref_id) {
      const m = await db.selectFrom("messages").select(["id", "thread_id"]).where("id", "=", d.ref_id).executeTakeFirstOrThrow();
      await processNewMessage(m.id, m.thread_id);
    } else await pollOnce();
    await resolveDeadLetter(d.id);
    return { ok: true };
  });

  // ---- export & wipe ----
  app.get("/api/export", async (req, reply) => {
    const db = await getDb();
    const tables = ["accounts", "threads", "messages", "triage", "triage_corrections", "drafts", "draft_versions", "people", "person_addresses",
      "profile_versions", "pinned_docs", "sender_rules", "usage", "settings", "audit_log", "style_proposals",
      "chat_conversations", "chat_messages", "chat_actions"] as const;
    const out: Record<string, unknown[]> = {};
    for (const t of tables) out[t] = await db.selectFrom(t).selectAll().execute();
    out.accounts = (out.accounts as Record<string, unknown>[]).map((a) => ({ ...a, tokens_enc: undefined })); // never export tokens
    await audit("user", "data.export", null, null);
    return reply.header("Content-Disposition", `attachment; filename="assistant-export-${now().slice(0, 10)}.json"`).send({ exportedAt: now(), version: appVersion(), data: out });
  });

  app.post("/api/wipe", { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } }, async (req) => {
    const b = parse(z.object({ confirm: z.literal("DELETE EVERYTHING"), password: z.string(), includeLogin: z.boolean().default(false) }), req.body);
    const db = await getDb();
    const u = await db.selectFrom("auth_user").selectAll().executeTakeFirst();
    if (!u?.password_hash || !verifyPassword(b.password, u.password_hash)) throw new HttpError(401, "Wrong password");
    const tables = ["draft_attachments", "chat_actions", "chat_messages", "chat_conversations", "send_confirmations", "push_subscriptions", "style_proposals", "jobs", "dead_letters", "usage", "sender_rules", "pinned_docs",
      "profile_versions", "person_addresses", "people", "draft_versions", "drafts", "triage_corrections", "triage", "messages", "threads", "accounts", "settings"] as const;
    for (const t of tables) await db.deleteFrom(t).execute();
    if (b.includeLogin) for (const t of ["sessions", "webauthn_credentials", "auth_user", "audit_log"] as const) await db.deleteFrom(t).execute();
    else await audit("user", "data.wipe", null, null);
    resetProviderCache();
    return { ok: true };
  });

  // ---- push ----
  app.get("/api/push/vapid", async () => ({ publicKey: env().VAPID_PUBLIC_KEY ?? null, fcm: Boolean(env().FCM_SERVICE_ACCOUNT_JSON) }));
  app.post("/api/push/subscribe", async (req) => {
    const b = parse(z.object({ kind: z.enum(["webpush", "fcm"]), endpoint: z.string().min(10), keys: z.record(z.string(), z.string()).optional() }), req.body);
    await subscribe(b.kind, b.endpoint, b.keys ?? {});
    return { ok: true };
  });

  // ---- style-guide proposals ----
  app.get("/api/style-proposals", async () => (await getDb()).selectFrom("style_proposals").selectAll().orderBy("created_at", "desc").limit(20).execute());
  app.post("/api/style-proposals/:id/:decision", async (req) => {
    const { id, decision } = req.params as { id: string; decision: string };
    await decideProposal(id, decision === "accept");
    return { ok: true };
  });
  app.post("/api/learning/run", async () => runLearning({ minEdits: 1 }));

  // ---- Google connect ----
  app.get("/api/google/connect", async () => {
    if (env().MOCK_MODE) return { url: null, mock: true };
    const state = crypto.randomBytes(16).toString("hex");
    oauthStates.set(state, Date.now() + 10 * 60_000);
    return { url: consentUrl(state) };
  });
  app.get("/api/google/callback", async (req, reply) => {
    const q = parse(z.object({ code: z.string().optional(), state: z.string(), error: z.string().optional() }), req.query);
    const exp = oauthStates.get(q.state);
    oauthStates.delete(q.state);
    const page = (msg: string) => reply.type("text/html").send(`<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:system-ui;padding:2rem"><h2>${msg}</h2><p><a href="/">Return to the app</a></p>`);
    if (!exp || exp < Date.now()) return page("Link expired. Start again from Settings → Accounts.");
    if (q.error || !q.code) return page(`Google sign-in was cancelled (${(q.error ?? "no code").replace(/[<>&"]/g, "")}).`);
    const { email, tokens } = await exchangeCode(q.code);
    const db = await getDb();
    const existing = await db.selectFrom("accounts").selectAll().where("email", "=", email).executeTakeFirst();
    let id = existing?.id;
    if (existing) await db.updateTable("accounts").set({ tokens_enc: encryptTokens(tokens), status: "ok", last_error: null, enabled: 1 }).where("id", "=", existing.id).execute();
    else {
      id = uid();
      await db.insertInto("accounts").values({ id, email, provider: "google", display_name: null, enabled: 1, tokens_enc: encryptTokens(tokens), history_id: null,
        send_as_json: "[]", status: "ok", last_sync_at: null, last_error: null, created_at: now() }).execute();
    }
    resetProviderCache(id);
    workerState.alerts.auth = false;
    const acc = await db.selectFrom("accounts").selectAll().where("id", "=", id!).executeTakeFirstOrThrow();
    await refreshSendAs(acc, mailFor(acc)).catch(() => undefined);
    await mailFor(acc).ensureLabels(Object.values(AI_LABELS)).catch(() => undefined);
    await audit("user", "google.connect", "account", id);
    return page("Google connected. You can close this tab.");
  });
  app.post("/api/google/disconnect", async (req) => {
    const b = parse(z.object({ accountId: z.string() }), req.body);
    const db = await getDb();
    await db.updateTable("accounts").set({ tokens_enc: null, status: "disconnected", enabled: 0 }).where("id", "=", b.accountId).execute();
    resetProviderCache(b.accountId);
    await audit("user", "google.disconnect", "account", b.accountId);
    return { ok: true, note: "Also remove access at https://myaccount.google.com/permissions" };
  });

  // ---- Vercel Cron (serverless hosting has no long-running worker) ----
  app.get("/api/cron/poll", async (req) => {
    const secret = env().CRON_SECRET;
    const given = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!secret || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) throw new HttpError(401, "Not allowed");
    return pollOnce();
  });

  // ---- Gmail push webhook (Pub/Sub). Not enabled in v1; polling is the baseline. ----
  app.post("/api/webhooks/gmail", async (_req, reply) => { void pollOnce(); return reply.status(204).send(); });

  // ---- app version + private APK download ----
  app.get("/api/app/version", async () => {
    const latest = readReleases()[0];
    return { server: appVersion(), android: latest ? { version: latest.version, url: `/download/${latest.file}`, notes: latest.notes } : null };
  });
  const requireDownloadAuth = (header: string | undefined) => {
    const pw = env().DOWNLOAD_PASSWORD;
    if (!pw) throw new HttpError(404, "Not found");
    const given = header?.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
    const a = crypto.createHash("sha256").update(given).digest(), bb = crypto.createHash("sha256").update(pw).digest();
    if (!crypto.timingSafeEqual(a, bb)) throw Object.assign(new HttpError(401, "Password required"), { auth: true });
  };
  app.get("/download", async (req, reply) => {
    try { requireDownloadAuth(req.headers.authorization); } catch (e) {
      if ((e as { auth?: boolean }).auth) return reply.status(401).header("WWW-Authenticate", 'Basic realm="Email Assistant download"').send("Password required");
      throw e;
    }
    const rel = readReleases();
    const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
    return reply.type("text/html").header("Cache-Control", "no-store").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email Assistant – Android</title>
<style>body{font-family:system-ui;max-width:640px;margin:2rem auto;padding:0 1rem;line-height:1.5}a.btn{display:inline-block;background:#2f5d50;color:#fff;padding:.8rem 1.2rem;border-radius:10px;text-decoration:none}li{margin:.5rem 0}</style></head><body>
<h1>Email Assistant for Android</h1>${rel.length ? `<p><a class="btn" href="/download/${esc(rel[0].file)}">Download v${esc(rel[0].version)}</a></p>
<p>First install: Android will ask to allow installs from your browser (“Install unknown apps”). Allow it, then open the downloaded file.</p>
<h2>Changelog</h2><ul>${rel.map((r) => `<li><b>v${esc(r.version)}</b> (${esc(r.date)}) — ${esc(r.notes)}</li>`).join("")}</ul>` : "<p>No build published yet.</p>"}</body></html>`);
  });
  app.get("/download/:file", async (req, reply) => {
    requireDownloadAuth(req.headers.authorization);
    const file = (req.params as { file: string }).file;
    if (!/^[\w.\-]+\.apk$/.test(file)) throw new HttpError(404, "Not found");
    const full = path.join(path.resolve(env().RELEASES_DIR), file);
    if (!fs.existsSync(full)) throw new HttpError(404, "Not found");
    return reply.header("Content-Disposition", `attachment; filename="${file}"`).type("application/vnd.android.package-archive").send(fs.createReadStream(full));
  });

  // ---- mock mode helpers ----
  app.post("/api/mock/receive", async (req) => {
    if (!env().MOCK_MODE) throw new HttpError(404, "Not found");
    const b = parse(z.object({ from: z.string().default("Claire Dubois <claire.dubois@choir.example.org>"), subject: z.string().default("Quick question"),
      body: z.string().default("Hi Matthew, are you available next Tuesday evening for a two-hour rehearsal?") }), req.body);
    const id = `mock-${Date.now()}`;
    getMockMail().receive({ id, threadId: `t-${id}`, from: b.from, subject: b.subject, body: b.body, date: new Date().toUTCString(), messageId: `<${id}@mock>` });
    const r = await pollOnce();
    emit("sync", r);
    return r;
  });
}

let cachedVersion: string | null = null;
export function appVersion(): string {
  if (!cachedVersion) {
    try { cachedVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version; } catch { cachedVersion = "0.0.0"; }
  }
  return cachedVersion!;
}

