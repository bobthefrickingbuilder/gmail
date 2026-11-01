/**
 * CALENDAR INVITES (ICS)
 * Minimal reader for the text/calendar part of a meeting invitation: pulls
 * out summary, start, end, location and organizer of the first VEVENT.
 */
export interface IcsEvent { summary: string | null; start: string | null; end: string | null; location: string | null; organizer: string | null; method: string | null }

function unfold(ics: string) { return ics.replace(/\r?\n[ \t]/g, ""); }

function icsDate(v: string, params: string): string | null {
  // 20261105T190000Z | 20261105T190000 (floating/TZID) | 20261105 (all-day)
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", z] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${z ? "Z" : ""}`;
  // TZID local times are returned without offset; the UI labels them with the TZID.
  return params.includes("VALUE=DATE") ? `${y}-${mo}-${d}` : iso;
}

export function parseIcs(ics: string): IcsEvent | null {
  const text = unfold(ics);
  const method = text.match(/^METHOD:(.+)$/m)?.[1]?.trim() ?? null;
  const ev = text.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/);
  if (!ev) return null;
  const get = (name: string) => {
    const m = ev[1].match(new RegExp(`^${name}((?:;[^:]*)?):(.*)$`, "m"));
    return m ? { params: m[1] ?? "", value: m[2].trim() } : null;
  };
  const unescape = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
  const dtStart = get("DTSTART"), dtEnd = get("DTEND");
  return {
    summary: get("SUMMARY") ? unescape(get("SUMMARY")!.value) : null,
    start: dtStart ? icsDate(dtStart.value, dtStart.params) : null,
    end: dtEnd ? icsDate(dtEnd.value, dtEnd.params) : null,
    location: get("LOCATION") ? unescape(get("LOCATION")!.value) : null,
    organizer: get("ORGANIZER")?.value.replace(/^mailto:/i, "") ?? null,
    method,
  };
}
