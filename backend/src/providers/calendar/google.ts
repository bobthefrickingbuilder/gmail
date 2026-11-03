/** GOOGLE CALENDAR PROVIDER — free/busy, events, and creating tentative events you ask for. */
import { google, type calendar_v3 } from "googleapis";
import { authorizedClient, isAuthError } from "../../google/oauth.js";
import { withRetry } from "../../retry.js";
import { AuthExpiredError } from "../mail/types.js";
import type { BusyInterval, CalendarEvent, CalendarInfo, CalendarProvider, NewEvent } from "./types.js";

export class GoogleCalendarProvider implements CalendarProvider {
  private api: calendar_v3.Calendar | null = null;
  constructor(private accountId: string) {}
  private async call<T>(fn: (c: calendar_v3.Calendar) => Promise<T>): Promise<T> {
    if (!this.api) this.api = google.calendar({ version: "v3", auth: await authorizedClient(this.accountId) });
    try { return await withRetry(() => fn(this.api!)); } catch (e) { if (isAuthError(e)) throw new AuthExpiredError(); throw e; }
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const r = await this.call((c) => c.calendarList.list({ maxResults: 250 }));
    return (r.data.items ?? []).map((i) => ({ id: i.id!, summary: i.summaryOverride ?? i.summary ?? i.id!, primary: Boolean(i.primary), timeZone: i.timeZone ?? null }));
  }

  async freeBusy(calendarIds: string[], timeMin: string, timeMax: string): Promise<BusyInterval[]> {
    const ids = calendarIds.length ? calendarIds : ["primary"];
    const r = await this.call((c) => c.freebusy.query({ requestBody: { timeMin, timeMax, items: ids.map((id) => ({ id })) } }));
    const out: BusyInterval[] = [];
    for (const cal of Object.values(r.data.calendars ?? {})) for (const b of cal.busy ?? []) if (b.start && b.end) out.push({ start: b.start, end: b.end });
    return out;
  }

  async listEvents(calendarIds: string[], timeMin: string, timeMax: string): Promise<CalendarEvent[]> {
    const ids = calendarIds.length ? calendarIds : ["primary"];
    const out: CalendarEvent[] = [];
    for (const calendarId of ids) {
      let pageToken: string | undefined;
      do {
        const r = await this.call((c) => c.events.list({ calendarId, timeMin, timeMax, singleEvents: true, orderBy: "startTime", maxResults: 250, pageToken }));
        for (const e of r.data.items ?? []) {
          if (e.status === "cancelled") continue;
          const allDay = Boolean(e.start?.date);
          out.push({ id: e.id!, calendarId, summary: e.summary ?? "(busy)", allDay,
            start: e.start?.dateTime ?? `${e.start?.date}T00:00:00`, end: e.end?.dateTime ?? `${e.end?.date}T00:00:00`,
            location: e.location ?? null, status: e.status ?? "confirmed", transparency: e.transparency ?? null });
        }
        pageToken = r.data.nextPageToken ?? undefined;
      } while (pageToken);
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  async createEvent(calendarId: string, ev: NewEvent) {
    const r = await this.call((c) => c.events.insert({ calendarId, requestBody: {
      summary: ev.summary, description: ev.description, location: ev.location, status: ev.tentative ? "tentative" : "confirmed",
      ...(ev.allDay ? { start: { date: ev.start }, end: { date: ev.end } }
        : { start: { dateTime: ev.start, timeZone: ev.timeZone }, end: { dateTime: ev.end, timeZone: ev.timeZone } }),
    } }));
    return { id: r.data.id!, htmlLink: r.data.htmlLink ?? null };
  }
}
