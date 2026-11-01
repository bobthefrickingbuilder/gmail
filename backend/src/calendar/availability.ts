/**
 * AVAILABILITY
 * ------------
 * find_availability(date_range, duration, constraints) → candidate free slots.
 * It starts from your working hours each day, removes every busy period
 * (plus a buffer before and after, and extra travel time around events that
 * have a location), removes your "no-go" windows, and keeps the gaps that are
 * at least `duration` long.
 *
 * PRIVACY: the output is start/end times only. Event names, places and
 * attendees never leave this module unless you turn on "share details" for
 * one specific draft (see eventDetailsForSharing).
 */
import { addDays, formatLocal, localWeekday, zonedToUtc } from "../time.js";

export interface Busy { start: string; end: string; hasLocation?: boolean }
export interface Constraints {
  timeZone: string;
  workingHours: { start: string; end: string; days: number[] };
  bufferMinutes: number;
  travelBufferMinutes?: number;
  noGo: { day: number | null; start: string; end: string }[];
  /** Earliest moment a slot may start (default: now). */
  notBefore?: Date;
  maxSlots?: number;
}
export interface Slot { start: string; end: string; label: string }

type Interval = [number, number];

function subtract(free: Interval[], cut: Interval): Interval[] {
  const out: Interval[] = [];
  for (const [s, e] of free) {
    if (cut[1] <= s || cut[0] >= e) { out.push([s, e]); continue; }
    if (cut[0] > s) out.push([s, cut[0]]);
    if (cut[1] < e) out.push([cut[1], e]);
  }
  return out;
}

export function slotLabel(start: Date, end: Date, timeZone: string, locale = "en-CA"): string {
  const day = formatLocal(start, timeZone, { weekday: "long", day: "numeric", month: "long" }, locale);
  const t = (d: Date) => formatLocal(d, timeZone, { hour: "numeric", minute: "2-digit", hour12: locale.startsWith("en") }, locale)
    .replace(":00", "").replace(/\s?([ap])\.?m\.?/i, " $1m").replace(/ /g, " ");
  return `${day}, ${t(start)}–${t(end)}`;
}

/** Dates are local "YYYY-MM-DD" (inclusive). */
export function findAvailability(range: { from: string; to: string }, durationMinutes: number, busy: Busy[], c: Constraints): Slot[] {
  const notBefore = (c.notBefore ?? new Date()).getTime();
  const dur = durationMinutes * 60000;
  const busyIntervals: Interval[] = busy.map((b) => {
    const pad = (c.bufferMinutes + (b.hasLocation ? c.travelBufferMinutes ?? 0 : 0)) * 60000;
    return [new Date(b.start).getTime() - pad, new Date(b.end).getTime() + pad] as Interval;
  });
  const slots: Slot[] = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
    const dayStart = zonedToUtc(day, c.workingHours.start, c.timeZone);
    const wd = localWeekday(new Date(dayStart.getTime() + 3600_000), c.timeZone);
    if (!c.workingHours.days.includes(wd)) continue;
    let free: Interval[] = [[dayStart.getTime(), zonedToUtc(day, c.workingHours.end, c.timeZone).getTime()]];
    for (const b of busyIntervals) free = subtract(free, b);
    for (const n of c.noGo) {
      if (n.day !== null && n.day !== wd) continue;
      free = subtract(free, [zonedToUtc(day, n.start, c.timeZone).getTime(), zonedToUtc(day, n.end, c.timeZone).getTime()]);
    }
    free = subtract(free, [0, notBefore]);
    for (const [s, e] of free) {
      if (e - s < dur) continue;
      // round start up to the next quarter hour for readability
      const q = 15 * 60000;
      const rs = Math.ceil(s / q) * q;
      if (e - rs < dur) continue;
      slots.push({ start: new Date(rs).toISOString(), end: new Date(e).toISOString(), label: slotLabel(new Date(rs), new Date(e), c.timeZone) });
    }
  }
  return slots.slice(0, c.maxSlots ?? 12);
}

/** Is a specific proposed time free? Used by the scheduling card. */
export function checkProposed(start: string, end: string | null, durationMinutes: number, busy: Busy[]): "free" | "conflict" | "unknown" {
  const s = new Date(start).getTime();
  if (isNaN(s)) return "unknown";
  const e = end ? new Date(end).getTime() : s + durationMinutes * 60000;
  return busy.some((b) => new Date(b.start).getTime() < e && new Date(b.end).getTime() > s) ? "conflict" : "free";
}

/**
 * Event title rule: the word "concert" only for real concerts; rehearsals are
 * titled "Rehearsal: …" and never contain "concert".
 */
export function normalizeEventTitle(title: string, kind: string): string {
  let t = title.trim();
  if (kind !== "concert") t = t.replace(/\bconcerts?\b\s*/gi, "").replace(/\s{2,}/g, " ").replace(/^[\s:–-]+|[\s:–-]+$/g, "").trim();
  if (kind === "rehearsal") {
    t = t.replace(/^rehearsal\s*[:–-]?\s*/i, "");
    t = t ? `Rehearsal: ${t}` : "Rehearsal";
  }
  return t || (kind === "concert" ? "Concert" : "Event");
}
