/** MOCK CALENDAR — a few invented events relative to "now", plus an events log. */
import type { BusyInterval, CalendarEvent, CalendarInfo, CalendarProvider, NewEvent } from "./types.js";

export class MockCalendarProvider implements CalendarProvider {
  events: CalendarEvent[] = [];
  created: (NewEvent & { calendarId: string; id: string })[] = [];

  constructor(base = new Date()) {
    const at = (dayOffset: number, hLocal: number, mins: number, summary: string, location: string | null = null): CalendarEvent => {
      const s = new Date(base); s.setUTCDate(s.getUTCDate() + dayOffset); s.setUTCHours(hLocal + 5, 0, 0, 0); // ~Toronto (EST)
      const e = new Date(s.getTime() + mins * 60000);
      return { id: `ev${this.events.length + 1}`, calendarId: "primary", summary, start: s.toISOString(), end: e.toISOString(),
        allDay: false, location, status: "confirmed", transparency: null };
    };
    this.events.push(at(1, 19, 150, "Opera Lyra rehearsal", "National Arts Centre"));
    this.events.push(at(2, 10, 60, "Doctor appointment", "Clinic"));
    this.events.push(at(3, 14, 120, "ORYC staff meeting", "St. Paul's Hall"));
    for (let w = 0; w < 4; w++) this.events.push(at(16 + w, 19, 180, `Concert run – Messiah performance ${w + 1}`, "Dominion-Chalmers"));
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return [{ id: "primary", summary: "Matthew Menard", primary: true, timeZone: "America/Toronto" },
      { id: "choir@group.calendar.example", summary: "ORYC", primary: false, timeZone: "America/Toronto" }];
  }
  async freeBusy(_ids: string[], timeMin: string, timeMax: string): Promise<BusyInterval[]> {
    return (await this.listEvents(_ids, timeMin, timeMax)).filter((e) => e.transparency !== "transparent").map((e) => ({ start: e.start, end: e.end }));
  }
  async listEvents(_ids: string[], timeMin: string, timeMax: string): Promise<CalendarEvent[]> {
    return this.events.filter((e) => e.end > timeMin && e.start < timeMax).sort((a, b) => a.start.localeCompare(b.start));
  }
  async createEvent(calendarId: string, ev: NewEvent) {
    const id = `new${this.created.length + 1}`;
    this.created.push({ ...ev, calendarId, id });
    this.events.push({ id, calendarId, summary: ev.summary, start: ev.start, end: ev.end, allDay: Boolean(ev.allDay), location: ev.location ?? null,
      status: ev.tentative ? "tentative" : "confirmed", transparency: null });
    return { id, htmlLink: null };
  }
}
