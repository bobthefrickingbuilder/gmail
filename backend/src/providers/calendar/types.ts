/** CALENDAR PROVIDER INTERFACE — Google Calendar today, swappable later. */
export interface CalendarInfo { id: string; summary: string; primary: boolean; timeZone: string | null }
export interface BusyInterval { start: string; end: string }
export interface CalendarEvent {
  id: string; calendarId: string; summary: string; start: string; end: string;
  allDay: boolean; location: string | null; status: string; transparency: string | null;
}
/** allDay: start/end are dates (YYYY-MM-DD), end exclusive. */
export interface NewEvent { summary: string; start: string; end: string; description?: string; location?: string; tentative: boolean; timeZone: string; allDay?: boolean }

export interface CalendarProvider {
  listCalendars(): Promise<CalendarInfo[]>;
  freeBusy(calendarIds: string[], timeMin: string, timeMax: string): Promise<BusyInterval[]>;
  listEvents(calendarIds: string[], timeMin: string, timeMax: string): Promise<CalendarEvent[]>;
  createEvent(calendarId: string, ev: NewEvent): Promise<{ id: string; htmlLink: string | null }>;
}
