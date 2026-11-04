/**
 * EVERY UNSENT DRAFT — replies (drafts table) and new emails (compose_drafts),
 * newest first, optionally filtered by kind or text. Used by GET /api/drafts
 * and by the in-app chat's list_drafts tool. Read-only.
 */
import { getDb, pj } from "../db/index.js";
import type { Address } from "../mail/types.js";

const preview = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 240);

export async function listDrafts(opts: { kind?: "all" | "reply" | "new"; q?: string } = {}) {
  const kind = opts.kind ?? "all";
  const db = await getDb();
  const replies = kind === "new" ? [] : await db.selectFrom("drafts")
    .innerJoin("threads", "threads.id", "drafts.thread_id")
    .leftJoin("draft_versions", "draft_versions.id", "drafts.current_version_id")
    .leftJoin("people", "people.id", "threads.person_id")
    .select(["drafts.id", "drafts.thread_id", "drafts.status", "drafts.to_json", "drafts.provider_draft_id", "drafts.updated_at",
      "threads.subject as thread_subject", "people.display_name as person_name",
      "draft_versions.subject", "draft_versions.body", "draft_versions.origin", "draft_versions.model_key", "draft_versions.confidence",
      "draft_versions.flags_json", "draft_versions.open_questions_json", "draft_versions.created_at as version_at"])
    .where("drafts.status", "in", ["active", "saved"]).orderBy("drafts.updated_at", "desc").limit(200).execute();
  const composed = kind === "reply" ? [] : await db.selectFrom("compose_drafts").selectAll()
    .where("status", "in", ["open", "saved"]).orderBy("updated_at", "desc").limit(200).execute();

  const rows = [
    ...replies.map((d) => ({
      kind: "reply" as const, id: d.id, thread_id: d.thread_id as string | null, subject: d.subject || d.thread_subject, to: pj<Address[]>(d.to_json, []),
      person_name: d.person_name, preview: preview(d.body ?? ""), origin: d.origin, model_key: d.model_key, confidence: d.confidence,
      flags: pj<string[]>(d.flags_json, []), open_questions: pj<string[]>(d.open_questions_json, []).length,
      in_gmail: Boolean(d.provider_draft_id), updated_at: [d.updated_at, d.version_at ?? ""].sort().at(-1)!,
    })),
    ...composed.map((c) => ({
      kind: "new" as const, id: c.id, thread_id: null as string | null, subject: c.subject, to: pj<Address[]>(c.to_json, []), person_name: null as string | null,
      preview: preview(c.body), origin: "user" as string | null, model_key: null as string | null, confidence: null as string | null, flags: [] as string[], open_questions: 0,
      in_gmail: Boolean(c.provider_draft_id), updated_at: c.updated_at,
    })),
  ];
  const needle = opts.q?.trim().toLowerCase();
  return rows
    .filter((r) => !needle || [r.subject, r.preview, r.person_name ?? "", ...r.to.flatMap((a) => [a.name ?? "", a.email])].some((s) => s.toLowerCase().includes(needle)))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
