/** SETTINGS ROUTES — app settings, style guide, model mapping, triage rules, signatures, sender rules. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb, now, uid } from "../db/index.js";
import { HttpError, parse } from "../http.js";
import { getModels, getSettings, getSignatureConfig, getStyleGuide, getTriageRules, saveModelOverrides, saveSettings, saveSignatureConfig,
  saveStyleGuide, saveTriageRules, getSettingRaw } from "../settings.js";
import { audit } from "../audit.js";
import { CATEGORIES } from "../providers/llm/schemas.js";

const time = z.string().regex(/^\d{2}:\d{2}$/);
const SettingsPatch = z.object({
  default_model: z.string(), start_on_sonnet: z.boolean(),
  escalation_rules: z.object({ senders: z.array(z.string()), labels: z.array(z.string()), categories: z.array(z.string()), model: z.string() }),
  draft_categories: z.array(z.enum(CATEGORIES)), auto_draft: z.boolean(), auto_apply_profile_updates: z.boolean(),
  urgent_keywords: z.array(z.string()), vip_emails: z.array(z.string()),
  working_hours: z.object({ start: time, end: time, days: z.array(z.number().min(0).max(6)) }),
  buffer_minutes: z.number().min(0).max(240), travel_buffer_minutes: z.number().min(0).max(240), travel_notes: z.string().max(2000),
  no_go_windows: z.array(z.object({ day: z.number().min(0).max(6).nullable(), start: time, end: time, label: z.string().optional() })),
  calendars: z.array(z.string()), polling_interval_seconds: z.number().min(30).max(3600),
  notifications: z.object({ urgent: z.boolean(), drafts: z.boolean(), quiet_hours: z.object({ start: time, end: time }).nullable() }),
  monthly_budget_usd: z.number().min(0).max(10000), retention_days: z.number().min(0).max(3650), idle_lock_minutes: z.number().min(1).max(240),
  theme: z.enum(["system", "light", "dark"]), timezone: z.string(), reply_all_default: z.boolean(), seed_months: z.number().min(1).max(36),
}).partial();

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async () => {
    const models = await getModels();
    return {
      settings: await getSettings(),
      models: { default_draft_model: models.default_draft_model, escalation_order: models.escalation_order,
        models: Object.fromEntries(Object.entries(models.models).map(([k, m]) => [k, { id: m.id, label: m.label, blurb: m.blurb, input_per_mtok: m.input_per_mtok, output_per_mtok: m.output_per_mtok }])) },
      triage_rules: await getTriageRules(),
      signatures: await getSignatureConfig(),
      categories: CATEGORIES,
    };
  });
  app.put("/api/settings", async (req) => {
    const patch = parse(SettingsPatch, req.body);
    if (patch.default_model !== undefined) {
      if (!(await getModels()).models[patch.default_model]) throw new HttpError(400, `Unknown model "${patch.default_model}"`);
      (patch as { default_model_chosen?: boolean }).default_model_chosen = true;
    }
    const s = await saveSettings(patch);
    await audit("user", "settings.update", null, null, { keys: Object.keys(patch) });
    return s;
  });
  app.get("/api/settings/style-guide", async () => ({ text: await getStyleGuide() }));
  app.put("/api/settings/style-guide", async (req) => {
    const b = parse(z.object({ text: z.string().min(10).max(50_000) }), req.body);
    await saveStyleGuide(b.text);
    await audit("user", "style.edit", null, null);
    return { ok: true };
  });
  app.put("/api/settings/models", async (req) => {
    const b = parse(z.record(z.string(), z.string().regex(/^claude-[a-z0-9-]+$/)), req.body);
    const cur = (await getSettingRaw<Record<string, string>>("model_id_overrides")) ?? {};
    await saveModelOverrides({ ...cur, ...b });
    await audit("user", "settings.models", null, null, { keys: Object.keys(b) });
    return { ok: true };
  });
  app.put("/api/settings/triage-rules", async (req) => {
    const b = parse(z.object({ noreply_patterns: z.array(z.string()), bulk_sender_domains: z.array(z.string()), skip_labels: z.array(z.string()),
      urgent_deadline_hours: z.number() }).partial(), req.body);
    for (const p of b.noreply_patterns ?? []) new RegExp(p, "i"); // validate
    await saveTriageRules({ ...(await getSettingRaw<object>("triage_rules")), ...b });
    return { ok: true };
  });
  app.put("/api/settings/signatures", async (req) => {
    const b = parse(z.object({ default: z.string(), groups: z.record(z.string(), z.object({ label: z.string(), text: z.string() })), prefer_gmail_signature: z.boolean() }).partial(), req.body);
    await saveSignatureConfig({ ...(await getSettingRaw<object>("signatures")), ...b });
    return { ok: true };
  });

  app.get("/api/sender-rules", async () => (await getDb()).selectFrom("sender_rules").selectAll().orderBy("created_at").execute());
  app.post("/api/sender-rules", async (req) => {
    const b = parse(z.object({ match: z.string().min(2), action: z.enum(["skip", "vip", "escalate", "category"]), value: z.string().nullable().optional() }), req.body);
    const id = uid();
    await (await getDb()).insertInto("sender_rules").values({ id, match: b.match.toLowerCase(), action: b.action, value: b.value ?? null, created_at: now() }).execute();
    await audit("user", "rules.add", "sender_rule", id, { action: b.action });
    return { id };
  });
  app.delete("/api/sender-rules/:id", async (req) => {
    await (await getDb()).deleteFrom("sender_rules").where("id", "=", (req.params as { id: string }).id).execute();
    return { ok: true };
  });
}
