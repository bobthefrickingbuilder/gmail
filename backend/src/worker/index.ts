/**
 * THE WORKER (background loop)
 * ----------------------------
 * Every 2 minutes (Settings → polling interval):
 *   for each connected mailbox: sync new mail → triage → auto-draft.
 * Also: wakes snoozed threads, runs the nightly learning + retention jobs at
 * ~3 am, continues an unfinished profile-seeding job, and raises an alert if
 * Google authorization expires or polling stops working.
 *
 * SAFETY: this module and everything it imports can create/update DRAFTS
 * only. It never imports drafting/send.ts (enforced by a test).
 */
import { getDb, now } from "../db/index.js";
import { syncAccount } from "../mail/sync.js";
import { processNewMessage } from "./process.js";
import { getSettings } from "../settings.js";
import { AuthExpiredError } from "../providers/mail/types.js";
import { markReauth } from "../google/oauth.js";
import { sendPush } from "../notify/push.js";
import { deadLetter } from "./deadletter.js";
import { emit } from "../notify/sse.js";
import { runLearning } from "../learning/nightly.js";
import { purgeOldBodies } from "../ops/retention.js";
import { runSeedJob } from "../profiles/seed.js";
import { audit } from "../audit.js";
import { log } from "../log.js";
import { localDate } from "../time.js";

export const workerState = {
  running: false,
  started: false,
  lastPollAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastError: null as string | null,
  lastNightlyDate: null as string | null,
  processed: 0,
  alerts: { auth: false, stalled: false },
};

let timer: NodeJS.Timeout | null = null;
let watchdog: NodeJS.Timeout | null = null;

export async function pollOnce(): Promise<{ accounts: number; newMessages: number; drafted: number }> {
  if (workerState.running) return { accounts: 0, newMessages: 0, drafted: 0 };
  workerState.running = true;
  workerState.lastPollAt = now();
  const db = await getDb();
  let newMessages = 0, drafted = 0, accounts = 0, hadError = false;
  try {
    const accs = await db.selectFrom("accounts").selectAll().where("enabled", "=", 1).execute();
    for (const acc of accs) {
      if (acc.status === "reauth_required") continue;
      accounts++;
      try {
        const fresh = await syncAccount(acc);
        newMessages += fresh.length;
        for (const m of fresh) {
          const r = await processNewMessage(m.messageId, m.threadId);
          if (r === "drafted") drafted++;
          workerState.processed++;
        }
        if (fresh.length) await audit("worker", "fetch", "account", acc.id, { new_messages: fresh.length });
      } catch (e) {
        hadError = true;
        workerState.lastError = (e as Error).message;
        if (e instanceof AuthExpiredError) {
          await markReauth(acc.id, (e as Error).message);
          if (!workerState.alerts.auth) {
            workerState.alerts.auth = true;
            await sendPush({ title: "Reconnect Google", body: "Gmail/Calendar access expired. Open the app to reconnect.", critical: true }).catch(() => undefined);
          }
        } else {
          await deadLetter("sync", acc.id, e);
        }
      }
    }
    drafted += await catchUpUntriaged();
    await wakeSnoozed();
    if (!hadError) { workerState.lastSuccessAt = now(); workerState.lastError = null; workerState.alerts.stalled = false; }
    emit("sync", { newMessages, drafted });
    return { accounts, newMessages, drafted };
  } finally {
    workerState.running = false;
  }
}

/**
 * Catch-up: incoming mail that was stored but never triaged, e.g. because the
 * server stopped part-way through a batch (sync only hands back NEW messages,
 * so these would otherwise be stuck forever). Last 14 days only, oldest first,
 * a bounded batch per poll. A message whose triage failed has an open
 * dead letter and is left for the Needs-attention list instead of retried here.
 */
export const CATCH_UP_BATCH = 25;
export async function catchUpUntriaged(): Promise<number> {
  const db = await getDb();
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const stuck = await db.selectFrom("messages as m")
    .innerJoin("accounts as a", "a.id", "m.account_id")
    .select(["m.id", "m.thread_id"])
    .where("a.enabled", "=", 1).where("a.status", "!=", "reauth_required")
    .where("m.is_from_me", "=", 0).where("m.date", ">=", since)
    .where((eb) => eb.not(eb.exists(eb.selectFrom("triage as t").select("t.id").whereRef("t.message_id", "=", "m.id"))))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("dead_letters as d").select("d.id")
      .where("d.kind", "=", "triage").whereRef("d.ref_id", "=", "m.id").where("d.resolved_at", "is", null))))
    .orderBy("m.date", "asc").limit(CATCH_UP_BATCH).execute();
  let drafted = 0;
  for (const m of stuck) {
    if ((await processNewMessage(m.id, m.thread_id)) === "drafted") drafted++;
    workerState.processed++;
  }
  if (stuck.length) log.info({ count: stuck.length }, "caught up on untriaged mail");
  return drafted;
}

async function wakeSnoozed() {
  const db = await getDb();
  const res = await db.updateTable("threads").set({ state: "open", snooze_until: null, updated_at: now() })
    .where("state", "=", "snoozed").where("snooze_until", "<=", now()).executeTakeFirst();
  if (Number(res.numUpdatedRows)) emit("thread", {});
}

async function nightly() {
  const s = await getSettings();
  const today = localDate(new Date(), s.timezone);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  if (workerState.lastNightlyDate === today || hour < 3) return;
  workerState.lastNightlyDate = today;
  try { await purgeOldBodies(); } catch (e) { await deadLetter("retention", null, e); }
  try { await runLearning(); } catch (e) { await deadLetter("learning", null, e); }
}

async function resumeJobs() {
  const db = await getDb();
  const jobs = await db.selectFrom("jobs").select(["id", "kind"]).where("status", "in", ["pending", "running"]).execute();
  for (const j of jobs) if (j.kind === "seed") void runSeedJob(j.id);
}

async function loop() {
  try { await pollOnce(); await nightly(); } catch (e) { log.error({ err: (e as Error).message }, "worker tick failed"); }
  const s = await getSettings().catch(() => ({ polling_interval_seconds: 120 }));
  timer = setTimeout(loop, Math.max(30, s.polling_interval_seconds) * 1000);
}

export async function startWorker() {
  if (workerState.started) return;
  workerState.started = true;
  await resumeJobs();
  void loop();
  // Watchdog: alert if no successful poll for 3 intervals.
  watchdog = setInterval(async () => {
    const s = await getSettings();
    const last = workerState.lastSuccessAt ? new Date(workerState.lastSuccessAt).getTime() : null;
    if (last && Date.now() - last > 3 * s.polling_interval_seconds * 1000 && !workerState.alerts.stalled) {
      workerState.alerts.stalled = true;
      await sendPush({ title: "Email assistant stalled", body: "No successful mail check recently. Open Status for details.", critical: true }).catch(() => undefined);
    }
  }, 60_000);
}

export function stopWorker() {
  if (timer) clearTimeout(timer);
  if (watchdog) clearInterval(watchdog);
  timer = watchdog = null;
  workerState.started = false;
}
