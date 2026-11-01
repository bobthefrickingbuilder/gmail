import { describe, it, expect } from "vitest";
import { findAvailability, checkProposed, normalizeEventTitle } from "../src/calendar/availability.js";
import { zonedToUtc, zoneOffsetMinutes } from "../src/time.js";

const TZ = "America/Toronto";
const c = { timeZone: TZ, workingHours: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] }, bufferMinutes: 30, noGo: [], notBefore: new Date("2026-01-01T00:00:00Z") };

describe("time zones", () => {
  it("handles DST", () => {
    expect(zoneOffsetMinutes(new Date("2026-07-01T12:00:00Z"), TZ)).toBe(-240);
    expect(zoneOffsetMinutes(new Date("2026-12-01T12:00:00Z"), TZ)).toBe(-300);
    expect(zonedToUtc("2026-11-02", "09:00", TZ).toISOString()).toBe("2026-11-02T14:00:00.000Z"); // day after DST ends
    expect(zonedToUtc("2026-10-30", "09:00", TZ).toISOString()).toBe("2026-10-30T13:00:00.000Z");
  });
});

describe("find_availability", () => {
  it("returns whole working day when free, skips weekends", () => {
    const s = findAvailability({ from: "2026-11-06", to: "2026-11-09" }, 60, [], c); // Fri..Mon
    expect(s.map((x) => x.start)).toEqual(["2026-11-06T14:00:00.000Z", "2026-11-09T14:00:00.000Z"]);
    expect(s[0].end).toBe("2026-11-06T22:00:00.000Z");
    expect(s[0].label).toMatch(/Friday, November 6, 9 am–5 pm/);
  });
  it("removes busy time plus buffer, and travel time for events with a location", () => {
    const busy = [{ start: "2026-11-09T16:00:00Z", end: "2026-11-09T17:00:00Z" }]; // 11–12 local
    const s = findAvailability({ from: "2026-11-09", to: "2026-11-09" }, 60, busy, c);
    expect(s.map((x) => [x.start, x.end])).toEqual([["2026-11-09T14:00:00.000Z", "2026-11-09T15:30:00.000Z"], ["2026-11-09T17:30:00.000Z", "2026-11-09T22:00:00.000Z"]]);
    const s2 = findAvailability({ from: "2026-11-09", to: "2026-11-09" }, 60, [{ ...busy[0], hasLocation: true }], { ...c, travelBufferMinutes: 30 });
    expect(s2[0].end).toBe("2026-11-09T15:00:00.000Z");
  });
  it("respects no-go windows and minimum duration", () => {
    const s = findAvailability({ from: "2026-11-09", to: "2026-11-09" }, 120, [], { ...c, noGo: [{ day: 1, start: "10:00", end: "16:00" }] });
    expect(s).toEqual([]); // 9-10 and 16-17 are both < 2h
    const s2 = findAvailability({ from: "2026-11-10", to: "2026-11-10" }, 120, [], { ...c, noGo: [{ day: 1, start: "10:00", end: "16:00" }] });
    expect(s2).toHaveLength(1); // Tuesday unaffected
  });
  it("never offers time in the past", () => {
    const s = findAvailability({ from: "2026-11-09", to: "2026-11-09" }, 60, [], { ...c, notBefore: new Date("2026-11-09T19:07:00Z") });
    expect(s[0].start).toBe("2026-11-09T19:15:00.000Z");
  });
  it("output contains only times, no event details", () => {
    const s = findAvailability({ from: "2026-11-09", to: "2026-11-09" }, 60, [{ start: "2026-11-09T16:00:00Z", end: "2026-11-09T17:00:00Z" }], c);
    expect(Object.keys(s[0]).sort()).toEqual(["end", "label", "start"]);
  });
  it("checks proposed times", () => {
    const busy = [{ start: "2026-11-09T16:00:00Z", end: "2026-11-09T17:00:00Z" }];
    expect(checkProposed("2026-11-09T16:30:00Z", null, 60, busy)).toBe("conflict");
    expect(checkProposed("2026-11-09T18:00:00Z", null, 60, busy)).toBe("free");
    expect(checkProposed("nonsense", null, 60, busy)).toBe("unknown");
  });
});

describe("event title rule", () => {
  it("only concerts say concert; rehearsals say Rehearsal", () => {
    expect(normalizeEventTitle("Concert rehearsal – Messiah", "rehearsal")).toBe("Rehearsal: Messiah");
    expect(normalizeEventTitle("Messiah dress rehearsal", "rehearsal")).toBe("Rehearsal: Messiah dress rehearsal");
    expect(normalizeEventTitle("Messiah concert", "concert")).toBe("Messiah concert");
    expect(normalizeEventTitle("Pre-concert meeting", "meeting")).toBe("Pre-meeting");
  });
});
