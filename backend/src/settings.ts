/**
 * SETTINGS
 * App settings live in the `settings` table so they can be edited from the
 * app. Each setting has a default here (or in /config). Reading a setting
 * returns the saved value if any, else the default.
 */
import { getDb, now, j, pj } from "./db/index.js";
import { loadModels, loadStyleGuideFile, loadTriageRules, loadSignatures, env } from "./config.js";

export interface AppSettings {
  /** Model for new drafts (automatic and by tap); you can pick another per draft. */
  default_model: string;
  /** True once you choose a default in Settings; until then the default follows config/models.json. */
  default_model_chosen: boolean;
  start_on_sonnet: boolean;
  escalation_rules: { senders: string[]; labels: string[]; categories: string[]; model: string };
  draft_categories: string[];
  auto_draft: boolean;
  auto_apply_profile_updates: boolean;
  urgent_keywords: string[];
  vip_emails: string[];
  working_hours: { start: string; end: string; days: number[] }; // days 0=Sun..6=Sat
  buffer_minutes: number;
  travel_buffer_minutes: number;
  travel_notes: string;
  no_go_windows: { day: number | null; start: string; end: string; label?: string }[];
  calendars: string[]; // calendar IDs included in availability; empty = primary
  polling_interval_seconds: number;
  notifications: { urgent: boolean; drafts: boolean; quiet_hours: { start: string; end: string } | null };
  monthly_budget_usd: number;
  retention_days: number;
  idle_lock_minutes: number;
  theme: "system" | "light" | "dark";
  timezone: string;
  reply_all_default: boolean;
  seed_months: number;
}

export function defaultSettings(): AppSettings {
  const models = loadModels();
  const rules = loadTriageRules();
  return {
    default_model: models.default_draft_model,
    default_model_chosen: false,
    start_on_sonnet: false,
    escalation_rules: { senders: [], labels: [], categories: [], model: "sonnet" },
    draft_categories: rules.draft_categories,
    auto_draft: true,
    auto_apply_profile_updates: false,
    urgent_keywords: rules.urgent_keywords,
    vip_emails: [],
    working_hours: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] },
    buffer_minutes: 30,
    travel_buffer_minutes: 30,
    travel_notes: "",
    no_go_windows: [],
    calendars: [],
    polling_interval_seconds: env().POLL_INTERVAL_SECONDS,
    notifications: { urgent: true, drafts: false, quiet_hours: { start: "22:00", end: "07:30" } },
    monthly_budget_usd: 20,
    retention_days: 90,
    idle_lock_minutes: 10,
    theme: "system",
    timezone: env().TIMEZONE,
    reply_all_default: true,
    seed_months: 12,
  };
}

export async function getSettings(): Promise<AppSettings> {
  const db = await getDb();
  const row = await db.selectFrom("settings").select("value_json").where("key", "=", "app").executeTakeFirst();
  const s = { ...defaultSettings(), ...pj<Partial<AppSettings>>(row?.value_json, {}) };
  // A default you never picked yourself follows models.json (so a new recommended default reaches you).
  if (!s.default_model_chosen) s.default_model = loadModels().default_draft_model;
  return s;
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const merged = { ...(await getSettings()), ...patch };
  await setRaw("app", merged);
  return merged;
}

async function setRaw(key: string, value: unknown) {
  const db = await getDb();
  const ts = now();
  await db.insertInto("settings").values({ key, value_json: j(value), updated_at: ts })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value_json: j(value), updated_at: ts })).execute();
}
async function getRaw<T>(key: string): Promise<T | undefined> {
  const db = await getDb();
  const row = await db.selectFrom("settings").select("value_json").where("key", "=", key).executeTakeFirst();
  return row ? pj<T | undefined>(row.value_json, undefined) : undefined;
}

/** Style guide: app-edited copy wins over config/style-guide.md. */
export async function getStyleGuide(): Promise<string> {
  return (await getRaw<string>("style_guide")) ?? loadStyleGuideFile();
}
export const saveStyleGuide = (text: string) => setRaw("style_guide", text);

/** Model mapping: models.json, with optional overrides of the IDs from Settings. */
export async function getModels() {
  const base = loadModels();
  const overrides = (await getRaw<Record<string, string>>("model_id_overrides")) ?? {};
  for (const [k, id] of Object.entries(overrides)) if (base.models[k]) base.models[k].id = id;
  return base;
}
export const saveModelOverrides = (o: Record<string, string>) => setRaw("model_id_overrides", o);

export async function getTriageRules() {
  return { ...loadTriageRules(), ...((await getRaw<object>("triage_rules")) ?? {}) };
}
export const saveTriageRules = (r: object) => setRaw("triage_rules", r);

export async function getSignatureConfig() {
  return { ...loadSignatures(), ...((await getRaw<object>("signatures")) ?? {}) };
}
export const saveSignatureConfig = (s: object) => setRaw("signatures", s);

export { getRaw as getSettingRaw, setRaw as setSettingRaw };
