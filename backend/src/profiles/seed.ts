/**
 * PROFILE SEEDING (one-time import)
 * ---------------------------------
 * Scans the last N months of your SENT mail, counts who you write to most,
 * stores those messages (so your own replies can serve as voice examples),
 * then builds a starting profile for the top correspondents.
 * Resumable (progress saved after every step), pausable, and rate-limited.
 */
import { getDb, now, uid, j, pj } from "../db/index.js";
import { mailFor } from "../providers/index.js";
import { parseGmailMessage } from "../mail/parse.js";
import { storeMessage } from "../mail/store.js";
import { myAddresses } from "../mail/sync.js";
import { findOrCreatePerson, proposeUpdate } from "./service.js";
import { emit } from "../notify/sse.js";
import { audit } from "../audit.js";
import { log } from "../log.js";

interface SeedCursor {
  phase: "scan" | "profiles" | "done";
  pageToken: string | null;
  scanned: number;
  counts: Record<string, { n: number; name: string | null }>;
  queue: string[];
  profiled: number;
  months: number;
  top: number;
}

export async function startSeedJob(months = 12, top = 40) {
  const db = await getDb();
  const running = await db.selectFrom("jobs").selectAll().where("kind", "=", "seed").where("status", "in", ["pending", "running", "paused"]).executeTakeFirst();
  if (running) return running.id;
  const id = uid();
  const cursor: SeedCursor = { phase: "scan", pageToken: null, scanned: 0, counts: {}, queue: [], profiled: 0, months, top };
  await db.insertInto("jobs").values({ id, kind: "seed", status: "pending", cursor: j(cursor), progress_json: j({ phase: "scan", scanned: 0, profiled: 0, total: top }),
    error: null, created_at: now(), updated_at: now() }).execute();
  await audit("user", "seed.start", "job", id, { months, top });
  return id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run (or continue) one seed job. Returns when done, paused, or failed. */
export async function runSeedJob(jobId: string, opts: { delayMs?: number; maxSteps?: number } = {}) {
  const db = await getDb();
  const delay = opts.delayMs ?? 1500;
  let steps = 0;
  await db.updateTable("jobs").set({ status: "running", updated_at: now() }).where("id", "=", jobId).execute();
  const acc = await db.selectFrom("accounts").selectAll().where("enabled", "=", 1).orderBy("created_at").executeTakeFirstOrThrow();
  const mail = mailFor(acc);
  const mine = myAddresses(acc);

  const save = async (c: SeedCursor, status = "running") => {
    await db.updateTable("jobs").set({ cursor: j(c), status, updated_at: now(),
      progress_json: j({ phase: c.phase, scanned: c.scanned, profiled: c.profiled, total: c.queue.length + c.profiled || c.top }) }).where("id", "=", jobId).execute();
    emit("job", { jobId });
  };
  try {
    for (;;) {
      const job = await db.selectFrom("jobs").selectAll().where("id", "=", jobId).executeTakeFirstOrThrow();
      if (job.status === "paused") return "paused";
      const c = pj<SeedCursor>(job.cursor, {} as SeedCursor);
      if (opts.maxSteps && steps++ >= opts.maxSteps) { await save(c, "paused"); return "paused"; }

      if (c.phase === "scan") {
        const page = await mail.listMessageIds(`in:sent newer_than:${c.months}m`, 50, c.pageToken ?? undefined);
        for (const id of page.ids) {
          const parsed = parseGmailMessage(await mail.getMessage(id));
          await storeMessage(acc.id, parsed, mine);
          for (const a of [...parsed.to, ...parsed.cc]) {
            if (mine.includes(a.email)) continue;
            c.counts[a.email] ??= { n: 0, name: a.name };
            c.counts[a.email].n++; c.counts[a.email].name ??= a.name;
          }
          c.scanned++;
        }
        c.pageToken = page.nextPageToken ?? null;
        if (!c.pageToken) {
          c.phase = "profiles";
          c.queue = Object.entries(c.counts).sort((a, b) => b[1].n - a[1].n).slice(0, c.top).map(([e]) => e);
        }
        await save(c);
        continue;
      }
      if (c.phase === "profiles") {
        const email = c.queue.shift();
        if (!email) { c.phase = "done"; await save(c, "done"); await audit("worker", "seed.done", "job", jobId, { profiled: c.profiled }); return "done"; }
        const person = await findOrCreatePerson(email, c.counts[email]?.name ?? null);
        const msgs = await db.selectFrom("messages").innerJoin("threads", "threads.id", "messages.thread_id")
          .select(["messages.from_name", "messages.from_email", "messages.is_from_me", "messages.subject", "messages.stripped_text", "messages.date"])
          .where((eb) => eb.or([eb("messages.from_email", "=", email), eb("messages.to_json", "like", `%"${email}"%`)]))
          .orderBy("messages.date", "desc").limit(12).execute();
        if (msgs.length) {
          const context = msgs.map((m) => `[${m.date.slice(0, 10)}] ${m.is_from_me ? "Matthew" : m.from_name ?? m.from_email} — ${m.subject}\n${(m.stripped_text ?? "").slice(0, 800)}`).join("\n---\n");
          await proposeUpdate(person.id, [`Display name: ${person.display_name}`, `Matthew wrote to them ${c.counts[email]?.n ?? 0} times in ${c.months} months`], context, { source: "seed" });
          await sleep(delay); // rate limit
        }
        c.profiled++;
        await save(c);
        continue;
      }
      return "done";
    }
  } catch (e) {
    log.warn({ job: jobId, err: (e as Error).message }, "seed job failed");
    await db.updateTable("jobs").set({ status: "failed", error: (e as Error).message.slice(0, 300), updated_at: now() }).where("id", "=", jobId).execute();
    return "failed";
  }
}
