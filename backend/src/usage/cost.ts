/**
 * USAGE & COST
 * Every model call is recorded with its token counts and dollar cost
 * (prices from config/models.json). The monthly budget cap only pauses
 * AUTOMATIC drafting; buttons you press always work.
 */
import { getDb, now, uid } from "../db/index.js";
import { getModels, getSettings } from "../settings.js";
import { sql } from "kysely";

export async function priceFor(modelKey: string, inputTokens: number, outputTokens: number): Promise<number> {
  const m = (await getModels()).models[modelKey];
  if (!m) return 0;
  return (inputTokens * m.input_per_mtok + outputTokens * m.output_per_mtok) / 1_000_000;
}

export async function recordUsage(u: { purpose: string; modelKey: string; modelId: string; inputTokens: number; outputTokens: number;
  costUsd: number; threadId?: string | null; draftId?: string | null }) {
  const db = await getDb();
  await db.insertInto("usage").values({
    id: uid(), ts: now(), purpose: u.purpose, model_key: u.modelKey, model_id: u.modelId, input_tokens: u.inputTokens,
    output_tokens: u.outputTokens, cost_usd: u.costUsd, thread_id: u.threadId ?? null, draft_id: u.draftId ?? null,
  }).execute();
}

export function monthStart(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export async function monthToDateCost(): Promise<number> {
  const db = await getDb();
  const r = await db.selectFrom("usage").select(sql<number>`coalesce(sum(cost_usd),0)`.as("c")).where("ts", ">=", monthStart()).executeTakeFirst();
  return Number(r?.c ?? 0);
}

/** True when automatic drafting must pause for the rest of the month. */
export async function budgetExceeded(): Promise<boolean> {
  const s = await getSettings();
  if (!s.monthly_budget_usd || s.monthly_budget_usd <= 0) return false;
  return (await monthToDateCost()) >= s.monthly_budget_usd;
}

export async function usageSummary(days = 30) {
  const db = await getDb();
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await db.selectFrom("usage").select(["ts", "model_key", "purpose", "input_tokens", "output_tokens", "cost_usd"])
    .where("ts", ">=", since).execute();
  const byDay: Record<string, { cost: number; input: number; output: number; byModel: Record<string, number> }> = {};
  const byModel: Record<string, { cost: number; input: number; output: number; calls: number }> = {};
  for (const r of rows) {
    const day = r.ts.slice(0, 10);
    byDay[day] ??= { cost: 0, input: 0, output: 0, byModel: {} };
    byDay[day].cost += r.cost_usd; byDay[day].input += r.input_tokens; byDay[day].output += r.output_tokens;
    byDay[day].byModel[r.model_key] = (byDay[day].byModel[r.model_key] ?? 0) + r.cost_usd;
    byModel[r.model_key] ??= { cost: 0, input: 0, output: 0, calls: 0 };
    byModel[r.model_key].cost += r.cost_usd; byModel[r.model_key].input += r.input_tokens;
    byModel[r.model_key].output += r.output_tokens; byModel[r.model_key].calls++;
  }
  const quality = await db.selectFrom("drafts").select(["edit_class", sql<number>`count(*)`.as("n")])
    .where("edit_class", "is not", null).groupBy("edit_class").execute();
  return {
    days, byDay, byModel,
    monthToDate: await monthToDateCost(),
    budget: (await getSettings()).monthly_budget_usd,
    quality: Object.fromEntries(quality.map((q) => [q.edit_class, Number(q.n)])),
  };
}
