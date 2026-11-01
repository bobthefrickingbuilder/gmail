/**
 * DEAD-LETTER QUEUE ("Needs attention")
 * When something fails after retries (a draft, a sync, a profile update),
 * it's recorded here and shown in the app's Needs-attention list, where you
 * can retry or dismiss it. Errors are stored without email content.
 */
import { getDb, now, uid } from "../db/index.js";
import { emit } from "../notify/sse.js";

export async function deadLetter(kind: string, refId: string | null, err: unknown) {
  const db = await getDb();
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  const existing = await db.selectFrom("dead_letters").selectAll().where("kind", "=", kind).where("ref_id", refId === null ? "is" : "=", refId as string)
    .where("resolved_at", "is", null).executeTakeFirst();
  if (existing) {
    await db.updateTable("dead_letters").set({ attempts: existing.attempts + 1, error: message, updated_at: now() }).where("id", "=", existing.id).execute();
  } else {
    await db.insertInto("dead_letters").values({ id: uid(), kind, ref_id: refId, error: message, attempts: 1, created_at: now(), updated_at: now(), resolved_at: null }).execute();
  }
  if (kind === "draft" && refId) await db.updateTable("threads").set({ needs_attention: 1 }).where("id", "=", refId).execute();
  emit("attention", { kind });
}

export async function resolveDeadLetter(id: string) {
  const db = await getDb();
  await db.updateTable("dead_letters").set({ resolved_at: now() }).where("id", "=", id).execute();
}

export async function openDeadLetters() {
  const db = await getDb();
  return db.selectFrom("dead_letters").selectAll().where("resolved_at", "is", null).orderBy("updated_at", "desc").execute();
}
