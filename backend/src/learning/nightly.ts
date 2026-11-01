/**
 * LEARNING FROM YOUR EDITS
 * Every night: look at drafts you edited before saving/sending, compare
 * the model's version with yours, and ask the model to summarise recurring
 * patterns ("removes the closing pleasantry", "shortens the first
 * paragraph"). The result is a PROPOSED style-guide change that you approve
 * or reject in the app. Nothing is ever applied silently.
 */
import { diffWords } from "diff";
import { getDb, now, uid } from "../db/index.js";
import { getLlm } from "../providers/index.js";
import { StyleLearningOutput } from "../providers/llm/schemas.js";
import { getModels, getStyleGuide, saveStyleGuide } from "../settings.js";
import { recordUsage } from "../usage/cost.js";
import { audit } from "../audit.js";

export function summarizeDiff(a: string, b: string): string {
  return diffWords(a, b).filter((p) => p.added || p.removed).slice(0, 40)
    .map((p) => `${p.added ? "+" : "-"} ${p.value.replace(/\s+/g, " ").trim().slice(0, 160)}`).join("\n");
}

export async function runLearning(opts: { minEdits?: number; days?: number } = {}) {
  const db = await getDb();
  const since = new Date(Date.now() - (opts.days ?? 30) * 86400_000).toISOString();
  const drafts = await db.selectFrom("drafts").select(["id", "original_version_id", "final_body"])
    .where("edit_class", "=", "edited").where("updated_at", ">=", since).where("final_body", "is not", null).limit(40).execute();
  if (drafts.length < (opts.minEdits ?? 3)) return { proposed: false, reason: `Only ${drafts.length} edited drafts in the period` };
  const pairs: string[] = [];
  for (const d of drafts) {
    const orig = await db.selectFrom("draft_versions").select("body").where("id", "=", d.original_version_id!).executeTakeFirst();
    if (orig && d.final_body) pairs.push(`<edit>\n${summarizeDiff(orig.body, d.final_body)}\n</edit>`);
  }
  const guide = await getStyleGuide();
  const models = await getModels();
  const res = await getLlm().complete({
    modelKey: models.learning_model, purpose: "learn", schemaName: "style_learning", schema: StyleLearningOutput, maxTokens: models.max_output_tokens.learn,
    system: "You study how Matthew edits AI-written email drafts. Lines starting with '-' were removed by Matthew, '+' were added. Identify recurring patterns (at least 2 occurrences) and propose a minimal edit to his style guide that would prevent them. Keep all existing rules unless an edit clearly contradicts one. Return only JSON.",
    user: `<style_guide>\n${guide}\n</style_guide>\n\n${pairs.join("\n")}`,
  });
  await recordUsage({ purpose: "learn", modelKey: res.modelKey, modelId: res.modelId, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd });
  const id = uid();
  const summary = `${res.data.summary}\n${res.data.patterns.map((p) => `• ${p.pattern} (${p.evidence_count}×)`).join("\n")}`;
  await db.insertInto("style_proposals").values({ id, summary, proposed_text: res.data.proposed_style_guide, status: "pending", created_at: now() }).execute();
  await audit("worker", "learning.propose", "style_proposal", id, { edits: drafts.length });
  return { proposed: true, id };
}

export async function decideProposal(id: string, accept: boolean) {
  const db = await getDb();
  const p = await db.selectFrom("style_proposals").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  if (p.status !== "pending") throw new Error("Already decided");
  if (accept) await saveStyleGuide(p.proposed_text);
  await db.updateTable("style_proposals").set({ status: accept ? "accepted" : "rejected" }).where("id", "=", id).execute();
  await audit("user", accept ? "style.accept" : "style.reject", "style_proposal", id);
}
