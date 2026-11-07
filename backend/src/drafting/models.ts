/**
 * WHICH MODEL?
 * You choose the model for every draft: Haiku, Sonnet or Opus.
 *  - New drafts (automatic and by tap) use your default model
 *    (Settings → Models & drafting; Sonnet unless you pick another).
 *  - On a draft, the picker starts on the model that wrote the current
 *    version, so "Redraft" keeps the model you were using; tap another to switch.
 *  - Auto-escalation rules (Settings) can still start specific senders,
 *    labels or categories on a stronger model.
 * The old one-way ladder (Haiku → Sonnet → Opus) is gone: any model can be
 * used at any time, and every version records which model wrote it.
 */
import { getModels, getSettings } from "../settings.js";
import { ruleMatches } from "../triage/rules.js";

export function modelFromStatus(draftStatus: string): string | null {
  return draftStatus.startsWith("drafted:") ? draftStatus.slice(8) : null;
}

/** Your default drafting model (falls back to models.json if the setting names a model that no longer exists). */
export async function draftModelKey(): Promise<string> {
  const [m, s] = await Promise.all([getModels(), getSettings()]);
  return m.models[s.default_model] ? s.default_model : m.default_draft_model;
}

/** Next model up the order, for "escalate" actions (chat, swipe-to-escalate). */
export async function nextModel(current: string | null): Promise<string> {
  const m = await getModels();
  const order = m.escalation_order;
  if (!current) return draftModelKey();
  const i = order.indexOf(current);
  return order[Math.min(i + 1, order.length - 1)] ?? current;
}

/** What the draft panel shows: every model you can pick, which one is selected, and the button label. */
export async function buttonState(draftStatus: string) {
  const models = await getModels();
  const def = await draftModelKey();
  const cur = modelFromStatus(draftStatus);
  const options = models.escalation_order.filter((k) => models.models[k])
    .concat(Object.keys(models.models).filter((k) => !models.escalation_order.includes(k)))
    .map((k) => ({ key: k, label: models.models[k].label, blurb: models.models[k].blurb, default: k === def }));
  const selected = cur && models.models[cur] ? cur : def;
  const label = (k: string) => models.models[k]?.label ?? k;
  return {
    options, selected, default: def, current: cur,
    primary: { action: cur ? "redraft" : "draft", model: selected, label: `${cur ? "Redraft" : "Draft"} with ${label(selected)}` },
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
  return s.start_on_sonnet ? "sonnet" : draftModelKey();
}
