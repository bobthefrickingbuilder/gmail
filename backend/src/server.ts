/**
 * HTTP SERVER
 * -----------
 * Fastify app with: security headers (helmet, HSTS), strict CORS (only your
 * app's origins), rate limiting, an Origin check on every state-changing
 * request, bearer-token authentication on every /api route except the few
 * public ones, and a JSON error handler that never echoes email content.
 * Also serves the built web app (PWA) and the private APK download page.
 */
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { NoResultError } from "kysely";
import { env, REPO_ROOT } from "./config.js";
import { HttpError, type Req } from "./http.js";
import { verifyAccess, sessionActive } from "./auth/sessions.js";
import { SendConfirmationError } from "./drafting/send.js";
import { AuthExpiredError } from "./providers/mail/types.js";
import { LlmOutputError, LlmRefusalError } from "./providers/llm/types.js";
import { authRoutes } from "./routes/auth.js";
import { threadRoutes } from "./routes/threads.js";
import { draftRoutes } from "./routes/drafts.js";
import { peopleRoutes } from "./routes/people.js";
import { calendarRoutes } from "./routes/calendar.js";
import { settingsRoutes } from "./routes/settings.js";
import { systemRoutes } from "./routes/system.js";
import { log } from "./log.js";

/** Routes that do not need a login. Everything else under /api does. */
const PUBLIC = [/^\/api\/health$/, /^\/api\/auth\/(status|setup|login|refresh|passkey\/login\/(options|verify))$/, /^\/api\/google\/callback/,
  /^\/api\/app\/version$/, /^\/api\/events$/, /^\/api\/webhooks\//, /^\/api\/cron\/poll$/];

export async function buildServer(): Promise<FastifyInstance> {
  const e = env();
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  const origins = e.APP_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  const publicOrigin = new URL(e.PUBLIC_URL).origin;
  const allowed = new Set([...origins, publicOrigin]);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'", ...origins.filter((o) => o.startsWith("http"))], frameAncestors: ["'none'"], objectSrc: ["'none'"],
        workerSrc: ["'self'"], manifestSrc: ["'self'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    credentials: false, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], allowedHeaders: ["Authorization", "Content-Type"],
  });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });

  // Origin check (CSRF defence in depth): state-changing requests from a browser must come from our app.
  app.addHook("onRequest", async (req) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) throw new HttpError(403, "Origin not allowed");
  });

  // Authentication
  app.addHook("preHandler", async (req: Req) => {
    const url = req.url.split("?")[0];
    if (!url.startsWith("/api/") || PUBLIC.some((re) => re.test(url))) return;
    const h = req.headers.authorization ?? "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
    const v = tok ? verifyAccess(tok) : null;
    if (!v || !(await sessionActive(v.sid))) throw new HttpError(401, "Not signed in");
    req.sessionId = v.sid;
  });

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number };
    let status = 500, message = "Something went wrong", extra: Record<string, unknown> = {};
    if (err instanceof HttpError) { status = err.statusCode; message = err.message; extra = err.extra; }
    else if (err instanceof NoResultError) { status = 404; message = "Not found"; }
    else if (err instanceof SendConfirmationError) { status = 409; message = err.message; }
    else if (err instanceof AuthExpiredError) { status = 409; message = "Google access expired — reconnect in Settings → Accounts"; extra = { reauth: true }; }
    else if (err instanceof LlmOutputError) { status = 502; message = "The model returned an invalid draft twice; the email was left undrafted."; }
    else if (err instanceof LlmRefusalError) { status = 422; message = err.message; }
    else if (err.statusCode && err.statusCode < 500) { status = err.statusCode; message = err.message; }
    if (status >= 500) log.error({ url: req.url.split("?")[0], method: req.method, err: err.message, stack: err.stack?.split("\n").slice(0, 4).join(" | ") }, "request failed");
    reply.status(status).send({ error: message, ...extra });
  });

  await app.register(authRoutes);
  await app.register(threadRoutes);
  await app.register(draftRoutes);
  await app.register(peopleRoutes);
  await app.register(calendarRoutes);
  await app.register(settingsRoutes);
  await app.register(systemRoutes);

  // Serve the web app (PWA) if it has been built.
  const webDist = e.WEB_DIST_DIR ?? path.join(REPO_ROOT, "web", "dist");
  if (fs.existsSync(path.join(webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/", index: ["index.html"], setHeaders: (res, file) => {
      if (file.endsWith("sw.js") || file.endsWith("index.html") || file.endsWith(".webmanifest")) res.header("Cache-Control", "no-cache");
    } });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "Not found" });
      return reply.type("text/html").send(fs.readFileSync(path.join(webDist, "index.html")));
    });
  }
  return app;
}
