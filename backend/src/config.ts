/**
 * CONFIG — plain-language overview
 * ---------------------------------
 * Everything the backend needs to know at start-up comes from two places:
 *   1. Environment variables (secrets and deployment details; see .env.example).
 *   2. The /config folder (models.json, style-guide.md, triage-rules.json,
 *      signature.json) — human-editable behaviour settings.
 * Nothing secret is ever read from /config, and nothing here is sent to the apps
 * except the non-secret parts the Settings screen shows.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo root: backend/src/.. /.. (also works from backend/dist). */
export const REPO_ROOT = path.resolve(here, "..", "..");
export const CONFIG_DIR = process.env.CONFIG_DIR ?? path.join(REPO_ROOT, "config");

const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("0.0.0.0"),
  /** Public URL of the backend, e.g. https://mail.example.com (used for OAuth redirect + WebAuthn). */
  PUBLIC_URL: z.string().default("http://localhost:8787"),
  /** Comma-separated list of origins allowed to call the API (the web app). */
  APP_ORIGINS: z.string().default("http://localhost:5173,http://localhost:8787,capacitor://localhost,https://localhost"),
  /** sqlite:./data/assistant.sqlite  or  postgres://user:pass@host/db */
  DATABASE_URL: z.string().default("sqlite:./data/assistant.sqlite"),
  /** 32-byte key, base64. Encrypts OAuth tokens and the TOTP secret at rest. */
  ENCRYPTION_KEY: z.string().optional(),
  /** Secret for signing short-lived access tokens. */
  SESSION_SECRET: z.string().optional(),
  MOCK_MODE: bool(false),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  POLL_INTERVAL_SECONDS: z.coerce.number().default(120),
  WORKER_ENABLED: bool(true),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@example.com"),
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
  /** Directory that holds the APK + releases.json for the download page. */
  RELEASES_DIR: z.string().default("./data/releases"),
  /** Basic-auth password for the APK download page. */
  DOWNLOAD_PASSWORD: z.string().optional(),
  WEB_DIST_DIR: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  /** Vercel only: shared secret Vercel Cron sends to /api/cron/poll. */
  CRON_SECRET: z.string().optional(),
  TIMEZONE: z.string().default("America/Toronto"),
});

export type Env = z.infer<typeof EnvSchema>;

let cachedEnv: Env | null = null;
export function env(): Env {
  if (!cachedEnv) cachedEnv = EnvSchema.parse(process.env);
  return cachedEnv;
}
/** Tests use this to change env between cases. */
export function resetEnv(overrides: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  cachedEnv = null;
}

// ---------- /config files ----------

export const ModelEntry = z.object({
  id: z.string(),
  label: z.string(),
  input_per_mtok: z.number(),
  output_per_mtok: z.number(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  serverFallback: z.boolean().default(false),
});
export const ModelsConfig = z.object({
  default_draft_model: z.string(),
  triage_model: z.string(),
  profile_model: z.string(),
  learning_model: z.string(),
  /** Model for the in-app chat (you can pick another per chat). */
  chat_model: z.string().default("opus"),
  escalation_order: z.array(z.string()),
  models: z.record(z.string(), ModelEntry),
  max_output_tokens: z.object({ draft: z.number(), triage: z.number(), profile: z.number(), learn: z.number(), chat: z.number().default(8000) }),
});
export type ModelsConfig = z.infer<typeof ModelsConfig>;
export type ModelKey = string;

export const TriageRulesConfig = z.object({
  skip_if_header_present: z.array(z.string()),
  skip_precedence_values: z.array(z.string()),
  skip_auto_submitted: z.boolean(),
  noreply_patterns: z.array(z.string()),
  bulk_sender_domains: z.array(z.string()),
  skip_labels: z.array(z.string()),
  categories: z.array(z.string()),
  draft_categories: z.array(z.string()),
  urgent_keywords: z.array(z.string()),
  urgent_deadline_hours: z.number(),
});
export type TriageRulesConfig = z.infer<typeof TriageRulesConfig>;

export const SignatureConfig = z.object({
  default: z.string(),
  groups: z.record(z.string(), z.object({ label: z.string(), text: z.string() })),
  prefer_gmail_signature: z.boolean(),
});
export type SignatureConfig = z.infer<typeof SignatureConfig>;

function readJson(name: string) {
  return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, name), "utf8"));
}
export const loadModels = (): ModelsConfig => ModelsConfig.parse(readJson("models.json"));
export const loadTriageRules = (): TriageRulesConfig => TriageRulesConfig.parse(readJson("triage-rules.json"));
export const loadSignatures = (): SignatureConfig => SignatureConfig.parse(readJson("signature.json"));
export const loadStyleGuideFile = (): string => fs.readFileSync(path.join(CONFIG_DIR, "style-guide.md"), "utf8");
