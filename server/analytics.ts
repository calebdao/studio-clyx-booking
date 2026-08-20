// Studio Clyx — booking analytics over real history.
//
// The public availability feed only looks 24h into the past (it exists to block
// future slots), which is why day-of-week analysis off that feed misses older
// external bookings. This module instead queries Google Calendar for a
// configurable lookback (default 12 months) and merges it with the database's
// own bookings, so the operator gets a true historical picture.
//
// Everything is bucketed by NEW YORK wall-clock (the studio's timezone), never
// UTC or the server's zone.

import type { BookingDto } from "@shared/schema";
import { storage } from "./storage";
import {
  listEventsForSpace,
  isCalendarLiveForSpace,
  SPACE_CALENDAR_ENV,
} from "./google-calendar";

const NY_TZ = "America/New_York";
const weekdayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ,
  weekday: "long",
});
// en-CA renders YYYY-MM-DD, so slicing to 7 chars gives a NY-local "YYYY-MM".
const monthFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: NY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

// A session that counts as a real booking for analytics: at least 45 min (drops
// the 30-min buffer blocks) and at most 24h (drops multi-day calendar blocks /
// all-day "unavailable" placeholders that aren't single bookings).
const MIN_SESSION_HOURS = 0.75;
const MAX_SESSION_HOURS = 24;

export interface WeekdayBucket {
  weekday: string;
  count: number;
  hours: number;
  web: number; // direct/website (DB) booking count
  external: number; // Peerspace/Giggster etc. (Google Calendar) count
  webHours: number;
  externalHours: number;
}
export interface MonthBucket {
  month: string; // "YYYY-MM" (NY)
  count: number;
  hours: number;
  web: number;
  external: number;
  webHours: number;
  externalHours: number;
}
export interface StudioBucket {
  spaceId: string;
  count: number;
  hours: number;
}
export interface BookingAnalytics {
  lookbackMonths: number;
  generatedAt: string;
  rangeStart: string;
  rangeEnd: string;
  totals: { sessions: number; hours: number; web: number; external: number };
  // How far back each source actually has data (independent of the requested
  // window) — tells the operator whether a full year is really available.
  coverage: {
    earliestInternal: string | null;
    earliestExternal: string | null;
  };
  byWeekday: WeekdayBucket[];
  byMonth: MonthBucket[];
  byStudio: StudioBucket[];
  // Non-fatal notes (e.g. a space whose calendar query failed).
  warnings: string[];
}

function hoursBetween(startIso: string, endIso: string): number {
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / 3_600_000;
}

function isRealSession(startIso: string, endIso: string): boolean {
  const h = hoursBetween(startIso, endIso);
  return h > MIN_SESSION_HOURS && h <= MAX_SESSION_HOURS;
}

/**
 * Build a historical booking analysis over the last `lookbackMonths` months
 * (clamped 1–24). Combines DB bookings (website/direct) with Google Calendar
 * events (external channels), de-duplicating the calendar events we ourselves
 * pushed for website bookings.
 */
export async function getBookingAnalytics(
  lookbackMonths = 12
): Promise<BookingAnalytics> {
  const months = Math.min(24, Math.max(1, Math.floor(lookbackMonths) || 12));
  const now = Date.now();
  const rangeStartDate = new Date(now);
  rangeStartDate.setMonth(rangeStartDate.getMonth() - months);
  const rangeStart = rangeStartDate.getTime();
  const warnings: string[] = [];

  type Session = {
    start: string;
    end: string;
    spaceId: string;
    channel: "web" | "external";
  };
  const sessions: Session[] = [];
  let earliestInternal: number | null = null;
  let earliestExternal: number | null = null;

  // --- DB bookings (website / direct). Confirmed only, historical window. ---
  const dbBookings: BookingDto[] = await storage.listBookings();
  const ownedEventIds = new Set(
    dbBookings.map((b) => b.googleEventId).filter((x): x is string => Boolean(x))
  );
  for (const b of dbBookings) {
    if (b.status !== "confirmed") continue;
    const t = new Date(b.start).getTime();
    if (!Number.isFinite(t)) continue;
    if (earliestInternal === null || t < earliestInternal) earliestInternal = t;
    if (t < rangeStart || t >= now) continue; // historical window only
    if (!isRealSession(b.start, b.end)) continue;
    sessions.push({ start: b.start, end: b.end, spaceId: b.spaceId, channel: "web" });
  }

  // --- Google Calendar (external channels), one query per live space. ---
  const spaceIds = Object.keys(SPACE_CALENDAR_ENV) as BookingDto["spaceId"][];
  await Promise.all(
    spaceIds.filter(isCalendarLiveForSpace).map(async (spaceId) => {
      const result = await listEventsForSpace(
        spaceId,
        new Date(rangeStart),
        new Date(now)
      );
      if (!result.ok) {
        if (result.reason === "error") {
          warnings.push(`Calendar query failed for ${spaceId}: ${result.error}`);
        }
        return;
      }
      for (const ev of result.events) {
        // Skip the calendar events we created for our own website bookings, so
        // those aren't counted twice (once as web, once as external).
        if (ownedEventIds.has(ev.id)) continue;
        const t = new Date(ev.start).getTime();
        if (!Number.isFinite(t)) continue;
        if (earliestExternal === null || t < earliestExternal) earliestExternal = t;
        if (!isRealSession(ev.start, ev.end)) continue;
        sessions.push({ start: ev.start, end: ev.end, spaceId, channel: "external" });
      }
    })
  );

  // --- Aggregate ---
  const weekdayMap = new Map<string, WeekdayBucket>(
    WEEKDAYS.map((d) => [
      d,
      { weekday: d, count: 0, hours: 0, web: 0, external: 0, webHours: 0, externalHours: 0 },
    ])
  );
  const monthMap = new Map<string, MonthBucket>();
  const studioMap = new Map<string, StudioBucket>();
  let totalHours = 0;
  let totalWeb = 0;
  let totalExternal = 0;

  for (const s of sessions) {
    const h = hoursBetween(s.start, s.end);
    const d = new Date(s.start);
    const wd = weekdayFmt.format(d);
    const month = monthFmt.format(d).slice(0, 7);

    const wb = weekdayMap.get(wd)!;
    wb.count++;
    wb.hours += h;
    if (s.channel === "web") {
      wb.web++;
      wb.webHours += h;
    } else {
      wb.external++;
      wb.externalHours += h;
    }

    let mb = monthMap.get(month);
    if (!mb) {
      mb = { month, count: 0, hours: 0, web: 0, external: 0, webHours: 0, externalHours: 0 };
      monthMap.set(month, mb);
    }
    mb.count++;
    mb.hours += h;
    if (s.channel === "web") {
      mb.web++;
      mb.webHours += h;
    } else {
      mb.external++;
      mb.externalHours += h;
    }

    let sb = studioMap.get(s.spaceId);
    if (!sb) {
      sb = { spaceId: s.spaceId, count: 0, hours: 0 };
      studioMap.set(s.spaceId, sb);
    }
    sb.count++;
    sb.hours += h;

    totalHours += h;
    if (s.channel === "web") totalWeb++;
    else totalExternal++;
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;
  const byWeekday = WEEKDAYS.map((d) => {
    const b = weekdayMap.get(d)!;
    return {
      ...b,
      hours: round1(b.hours),
      webHours: round1(b.webHours),
      externalHours: round1(b.externalHours),
    };
  });
  const byMonth = Array.from(monthMap.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((b) => ({
      ...b,
      hours: round1(b.hours),
      webHours: round1(b.webHours),
      externalHours: round1(b.externalHours),
    }));
  const byStudio = Array.from(studioMap.values())
    .sort((a, b) => b.count - a.count)
    .map((b) => ({ ...b, hours: round1(b.hours) }));

  return {
    lookbackMonths: months,
    generatedAt: new Date(now).toISOString(),
    rangeStart: new Date(rangeStart).toISOString(),
    rangeEnd: new Date(now).toISOString(),
    totals: {
      sessions: sessions.length,
      hours: round1(totalHours),
      web: totalWeb,
      external: totalExternal,
    },
    coverage: {
      earliestInternal:
        earliestInternal !== null ? new Date(earliestInternal).toISOString() : null,
      earliestExternal:
        earliestExternal !== null ? new Date(earliestExternal).toISOString() : null,
    },
    byWeekday,
    byMonth,
    byStudio,
    warnings,
  };
}
