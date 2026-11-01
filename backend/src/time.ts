/**
 * TIME-ZONE HELPERS (no external library)
 * Converts between UTC instants and wall-clock time in a named zone such as
 * America/Toronto, including daylight-saving changes.
 */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** "2026-11-03" + "13:30" in zone → UTC Date. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let off = zoneOffsetMinutes(new Date(guess), timeZone);
  let result = guess - off * 60000;
  const off2 = zoneOffsetMinutes(new Date(result), timeZone); // DST edge correction
  if (off2 !== off) result = guess - off2 * 60000;
  return new Date(result);
}

/** Local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}
export function localWeekday(instant: Date, timeZone: string): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(instant);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function formatLocal(instant: Date, timeZone: string, opts: Intl.DateTimeFormatOptions, locale = "en-CA"): string {
  return new Intl.DateTimeFormat(locale, { timeZone, ...opts }).format(instant);
}
export function todayString(timeZone: string, at = new Date()): string {
  return `${formatLocal(at, timeZone, { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} (${timeZone})`;
}
