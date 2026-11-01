/**
 * CALENDAR SERVICE — connects the availability maths to Google Calendar and
 * builds the "scheduling card" shown above a draft.
 */
import { getDb, pj } from "../db/index.js";
import { calendarFor } from "../providers/index.js";
import { getSettings } from "../settings.js";
import { addDays, localDate } from "../time.js";
import { checkProposed, findAvailability, normalizeEventTitle, type Busy, type Slot } from "./availability.js";
import { audit } from "../audit.js";
import type { AccountsTable } from "../db/schema.js";

export async function primaryAccount(): Promise<AccountsTable | undefined> {
  const db = await getDb();
  return db.selectFrom("accounts").selectAll().where("enabled", "=", 1).orderBy("created_at").executeTakeFirst();
}

export async function busyIntervals(acc: AccountsTable, from: Date, to: Date): Promise<{ busy: Busy[]; details: string[] }> {
  const s = await getSettings();
  const cal = calendarFor(acc);
  const events = await cal.listEvents(s.calendars, from.toISOString(), to.toISOString());
  const busy = events.filter((e) => e.transparency !== "transparent" && e.status !== "cancelled")
    .map((e) => ({ start: e.start, end: e.end, hasLocation: Boolean(e.location) }));
  // details are only ever used when "share details" is switched on for one draft
  const details = events.map((e) => `${e.summary} — ${new Date(e.start).toLocaleString("en-CA", { timeZone: s.timezone })}${e.location ? ` @ ${e.location}` : ""}`);
  return { busy, details };
}

export async function availabilityFor(acc: AccountsTable, opts: { from?: string; to?: string; durationMinutes?: number } = {}):
  Promise<{ slots: Slot[]; timezone: string; details: string[] }> {
  const s = await getSettings();
  const today = localDate(new Date(), s.timezone);
  const from = opts.from && opts.from >= today ? opts.from : today;
  const to = opts.to ?? addDays(from, 13);
  const { busy, details } = await busyIntervals(acc, new Date(`${addDays(from, -1)}T00:00:00Z`), new Date(`${addDays(to, 2)}T00:00:00Z`));
  const slots = findAvailability({ from, to }, opts.durationMinutes ?? 60, busy, {
    timeZone: s.timezone, workingHours: s.working_hours, bufferMinutes: s.buffer_minutes, travelBufferMinutes: s.travel_buffer_minutes,
    noGo: s.no_go_windows,
  });
  return { slots, timezone: s.timezone, details };
}

/** Date range to search: explicit requested range, else around the proposed times, else the default 14 days. */
export function schedulingRange(sched: { proposed_times?: { start: string | null }[]; requested_range?: { from: string; to: string } | null }, timeZone: string) {
  const rr = sched.requested_range;
  if (rr && /^\d{4}-\d{2}-\d{2}$/.test(rr.from) && /^\d{4}-\d{2}-\d{2}$/.test(rr.to) && rr.from <= rr.to) return { from: rr.from, to: rr.to };
  const starts = (sched.proposed_times ?? []).map((p) => p.start).filter((x): x is string => Boolean(x) && !isNaN(new Date(x!).getTime())).sort();
  if (!starts.length) return { from: undefined, to: undefined };
  return { from: localDate(new Date(starts[0]), timeZone), to: addDays(localDate(new Date(starts[starts.length - 1]), timeZone), 1) };
}

export interface SchedulingCard {
  kind: string;
  durationMinutes: number;
  proposed: { text: string; start: string | null; end: string | null; status: "free" | "conflict" | "unknown" }[];
  suggestions: Slot[];
  timezone: string;
}

/** Card for the latest triaged message in a thread (null if no scheduling intent). */
export async function schedulingCard(threadId: string): Promise<SchedulingCard | null> {
  const db = await getDb();
  const t = await db.selectFrom("triage").innerJoin("messages", "messages.id", "triage.message_id")
    .select(["triage.scheduling_json", "triage.category"]).where("triage.thread_id", "=", threadId)
    .orderBy("messages.date", "desc").limit(1).executeTakeFirst();
  if (!t) return null;
  const sched = pj<{ detected?: boolean; kind?: string; proposed_times?: { text: string; start: string | null; end: string | null }[]; requested_range?: { from: string; to: string } | null; duration_minutes?: number | null }>(t.scheduling_json, {});
  if (!sched.detected && t.category !== "scheduling") return null;
  const acc = await primaryAccount();
  if (!acc) return null;
  const duration = sched.duration_minutes ?? 60;
  const proposedTimes = sched.proposed_times ?? [];
  const s = await getSettings();
  const range = schedulingRange(sched, s.timezone);
  const from = range.from, to = range.to;
  const avail = await availabilityFor(acc, { from, to, durationMinutes: duration });
  const { busy } = await busyIntervals(acc, new Date(Date.now() - 86400_000), new Date(Date.now() + 120 * 86400_000));
  return {
    kind: sched.kind ?? "availability_request", durationMinutes: duration, timezone: avail.timezone, suggestions: avail.slots,
    proposed: proposedTimes.map((p) => ({ ...p, status: p.start ? checkProposed(p.start, p.end, duration, busy) : "unknown" })),
  };
}

/** Only ever called from an explicit "Add to calendar" tap. */
export async function addTentativeEvent(input: { title: string; kind: string; start: string; end?: string | null; description?: string; location?: string; calendarId?: string; durationMinutes?: number }) {
  const acc = await primaryAccount();
  if (!acc) throw new Error("No account connected");
  const s = await getSettings();
  const end = input.end ?? new Date(new Date(input.start).getTime() + (input.durationMinutes ?? 120) * 60000).toISOString();
  const summary = normalizeEventTitle(input.title, input.kind);
  const res = await calendarFor(acc).createEvent(input.calendarId ?? "primary", { summary, start: new Date(input.start).toISOString(),
    end: new Date(end).toISOString(), description: input.description, location: input.location, tentative: true, timeZone: s.timezone });
  await audit("user", "calendar.create_event", "event", res.id, { kind: input.kind, tentative: true });
  return { ...res, summary };
}
