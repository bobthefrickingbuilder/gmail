/**
 * WHICH MODEL? (button logic from the brief, section 5.5)
 *  - No draft yet:        "Draft with Haiku" (toggle: start on Sonnet)
 *  - Haiku draft exists:  "Redraft with Sonnet"
 *  - Sonnet draft exists: "Redraft with Opus" + plain "Redraft"
 * Auto-escalation rules (Settings) can start specific senders, labels or
 * categories on Sonnet.
 */
import { getModels, getSettings } from "../settings.js";
import { ruleMatches } from "../triage/rules.js";

export function modelFromStatus(draftStatus: string): string | null {
  return draftStatus.startsWith("drafted:") ? draftStatus.slice(8) : null;
}

export async function nextModel(current: string | null): Promise<string> {
  const m = await getModels();
  const order = m.escalation_order;
  if (!current) return m.default_draft_model;
  const i = order.indexOf(current);
  return order[Math.min(i + 1, order.length - 1)] ?? current;
}

export async function buttonState(draftStatus: string) {
  const models = await getModels();
  const cur = modelFromStatus(draftStatus);
  const label = (k: string) => models.models[k]?.label ?? k;
  if (!cur) return { primary: { action: "draft", model: models.default_draft_model, label: `Draft with ${label(models.default_draft_model)}` },
    toggle: { model: "sonnet", label: "Start on Sonnet" }, secondary: null };
  const next = await nextModel(cur);
  if (next === cur) return { primary: { action: "redraft", model: cur, label: "Redraft" }, toggle: null, secondary: null };
  return {
    primary: { action: "redraft", model: next, label: `Redraft with ${label(next)}` }, toggle: null,
    secondary: cur !== models.default_draft_model ? { action: "redraft", model: cur, label: "Redraft" } : null,
  };
}

/** Model for an automatic (worker) draft, applying escalation rules. */
export async function autoModelFor(ctx: { fromEmail: string; labels: string[]; category: string; personEscalate: string | null; ruleEscalate: string | null }) {
  const s = await getSettings();
  if (ctx.ruleEscalate) return ctx.ruleEscalate;
  if (ctx.personEscalate) return ctx.personEscalate;
  const er = s.escalation_rules;
  if (er.senders.some((m) => ruleMatches(m, ctx.fromEmail, ctx.labels)) || er.labels.some((l) => ctx.labels.includes(l)) || er.categories.includes(ctx.category))
    return er.model;
  return s.start_on_sonnet ? "sonnet" : s.default_model;
}
