/** CALENDAR ROUTES — agenda/week/month events, availability preview, quick-add / tentative events (only on your tap),
 *  and "scan emails for events" (POST /api/calendar/scan: lists candidates only; adding is a separate tap per event). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, HttpError } from "../http.js";
import { addTentativeEvent, availabilityFor, primaryAccount } from "../calendar/service.js";
import { calendarFor } from "../providers/index.js";
import { scanEmailsForEvents } from "../calendar/scan.js";
import { getSettings } from "../settings.js";

export async function calendarRoutes(app: FastifyInstance) {
  const acc = async () => { const a = await primaryAccount(); if (!a) throw new HttpError(409, "Connect Google first"); return a; };

  app.get("/api/calendar/calendars", async () => {
    const a = await acc(); const s = await getSettings();
    return (await calendarFor(a).listCalendars()).map((c) => ({ ...c, included: s.calendars.length ? s.calendars.includes(c.id) : c.primary }));
  });

  app.get("/api/calendar/events", async (req) => {
    const q = parse(z.object({ from: z.string(), to: z.string() }), req.query);
    const a = await acc(); const s = await getSettings();
    // Your own events, shown only to you inside the app (never sent to the model unless you allow it per draft).
    return calendarFor(a).listEvents(s.calendars, new Date(q.from).toISOString(), new Date(q.to).toISOString());
  });

  app.get("/api/calendar/availability", async (req) => {
    const q = parse(z.object({ from: z.string().optional(), to: z.string().optional(), duration: z.coerce.number().min(15).max(600).default(60) }), req.query);
    const r = await availabilityFor(await acc(), { from: q.from, to: q.to, durationMinutes: q.duration });
    return { slots: r.slots, timezone: r.timezone };
  });

  app.post("/api/calendar/events", async (req) => {
    const b = parse(z.object({ title: z.string().min(1).max(200), kind: z.enum(["concert", "rehearsal", "meeting", "lesson", "deadline", "other"]).default("other"),
      start: z.string(), end: z.string().nullable().optional(), durationMinutes: z.number().optional(), description: z.string().max(2000).optional(),
      location: z.string().max(300).optional(), calendarId: z.string().optional(), allDay: z.boolean().optional() }), req.body);
    return addTentativeEvent(b);
  });

  app.post("/api/calendar/scan", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req) => {
    const b = parse(z.object({ days: z.number().int().min(1).max(60).default(14) }), req.body ?? {});
    return scanEmailsForEvents({ days: b.days });
  });
}
