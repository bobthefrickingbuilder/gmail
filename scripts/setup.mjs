/**
 * ONE-COMMAND SETUP:  npm run setup
 * - creates .env from .env.example with fresh random secrets (encryption key,
 *   session secret, VAPID push keys) — existing values are never overwritten
 * - installs the git pre-commit secrets scan
 * - builds the web app
 * Then prints what to fill in by hand (Anthropic key, Google OAuth client).
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const envPath = `${root}.env`;
const example = fs.readFileSync(`${root}.env.example`, "utf8");
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const current = Object.fromEntries(existing.split("\n").filter((l) => /^\w+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]));

let vapid = { publicKey: "", privateKey: "" };
try { vapid = (await import("web-push")).default.generateVAPIDKeys(); } catch { /* deps not installed yet */ }
const generated = {
  ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
  SESSION_SECRET: crypto.randomBytes(48).toString("base64"),
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  DOWNLOAD_PASSWORD: crypto.randomBytes(9).toString("base64url"),
  CRON_SECRET: crypto.randomBytes(24).toString("base64url"),
};
const out = example.split("\n").map((line) => {
  const m = line.match(/^(\w+)=(.*)$/);
  if (!m) return line;
  const [, k, v] = m;
  if (current[k] !== undefined && current[k] !== "") return `${k}=${current[k]}`;
  if (generated[k]) return `${k}=${generated[k]}`;
  return `${k}=${v}`;
}).join("\n");
fs.writeFileSync(envPath, out, { mode: 0o600 });
console.log(existing ? "Updated .env (kept your existing values)." : "Created .env with fresh secrets.");

try { execSync("git config core.hooksPath scripts/hooks", { cwd: root }); console.log("Installed pre-commit secrets scan."); } catch { /* not a git checkout */ }
try { execSync("npm run build -w web", { cwd: root, stdio: "inherit" }); } catch { console.log("Web build failed — run `npm install` first."); }

const missing = ["ANTHROPIC_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "PUBLIC_URL"].filter((k) => !(out.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1] ?? "").trim() || /example\.com/.test(out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? ""));
console.log(`
Next steps (details in docs/INSTALL.md):
${missing.length ? `  1. Edit .env and fill in: ${missing.join(", ")}` : "  1. .env looks complete."}
  2. Try it with fake data first:   MOCK_MODE=true npm run dev     (or: npm run mock)
  3. Real mail:                     docker compose up -d   (home server)
  The first start prints a one-time SETUP CODE in the log; enter it in the app with your new password.
`);
