/**
 * AUDIT LOG — a permanent record of every action (fetch, draft, redraft,
 * profile edit, calendar write, send…). Only IDs and small metadata are
 * stored, never email content. Shown in Settings → Security → Audit log.
 */
import { getDb, now, uid, j } from "./db/index.js";

export type Actor = "user" | "worker" | "system";

/** Keys that must never appear in audit metadata. */
const FORBIDDEN = /body|content|text|html|snippet|token|password|secret/i;

export async function audit(actor: Actor, action: string, targetType?: string | null, targetId?: string | null,
  meta: Record<string, unknown> = {}) {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (FORBIDDEN.test(k)) continue;
    clean[k] = typeof v === "string" && v.length > 200 ? v.slice(0, 200) : v;
  }
  const db = await getDb();
  await db.insertInto("audit_log").values({
    id: uid(), ts: now(), actor, action, target_type: targetType ?? null, target_id: targetId ?? null, meta_json: j(clean),
  }).execute();
}
