import type { BookingDto } from "@shared/schema";

// ---------------------------------------------------------------------------
// Deciding what a Google Calendar event means for availability.
//
// Extracted from routes.ts as a pure function so the rules can be tested
// directly — a mistake here either hides a real booking (double-booking a
// guest) or blocks a studio nobody is in.
//
// There is one Google calendar per space. An event on a space's calendar is one
// of three things:
//
//   1. OURS, on the calendar we recorded  -> ignore. The booking row already
//      blocks the slot; rendering the event too would duplicate it.
//   2. OURS, on a DIFFERENT space's calendar -> the operator dragged it to
//      another studio. Google is the source of truth for where it now lives, so
//      the booking row gets re-homed to match.
//   3. NOT ours -> an external booking (Peerspace / Giggster / a manual block).
//      Render it so the slot shows as taken.
//
// Case 2 is the one that used to be wrong: the old code matched on event id
// alone, so a moved event satisfied case 1 on its NEW calendar and was skipped,
// while the stale row kept blocking the OLD space. That left the old studio
// blocked with nobody in it and the new studio bookable on top of a real guest.
// ---------------------------------------------------------------------------

export interface CalendarEventLite {
  id: string;
  start: string;
  end: string;
  summary?: string;
}

export interface SpaceEvents {
  spaceId: BookingDto["spaceId"];
  events: CalendarEventLite[];
}

export interface PlannedMove {
  bookingId: string;
  fromSpaceId: BookingDto["spaceId"];
  toSpaceId: BookingDto["spaceId"];
}

export interface PlannedRetime {
  bookingId: string;
  fromStart: string;
  fromEnd: string;
  toStart: string;
  toEnd: string;
}

export interface MergePlan {
  /** Events belonging to no known booking — render these as busy. */
  externals: Array<{ spaceId: BookingDto["spaceId"]; event: CalendarEventLite }>;
  /** Our bookings discovered on another space's calendar. */
  moves: PlannedMove[];
  /** Our bookings whose event was dragged to a different time. */
  retimes: PlannedRetime[];
}

// Google returns times as ISO strings that may differ in format or offset while
// representing the same instant, so compare epochs with a tolerance rather than
// comparing strings. Below this, treat the times as unchanged.
const RETIME_TOLERANCE_MS = 60_000;

function sameInstant(a: string, b: string): boolean {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return true; // unparseable: don't act
  return Math.abs(ta - tb) < RETIME_TOLERANCE_MS;
}

export function planCalendarMerge(args: {
  internal: BookingDto[];
  eventsBySpace: SpaceEvents[];
}): MergePlan {
  // Rejected bookings don't own their event any more — if an id lingers on a
  // calendar, treat it as external so the slot still reads as busy rather than
  // being silently dropped.
  const ownedByEventId = new Map<string, BookingDto>();
  for (const booking of args.internal) {
    if (booking.googleEventId && booking.status !== "rejected") {
      ownedByEventId.set(booking.googleEventId, booking);
    }
  }

  const externals: MergePlan["externals"] = [];
  const moves: PlannedMove[] = [];
  const retimes: PlannedRetime[] = [];
  // An event id can only live on one calendar, but guard anyway so a duplicate
  // reading can't queue two conflicting updates for the same booking.
  const touchedBookingIds = new Set<string>();

  for (const { spaceId, events } of args.eventsBySpace) {
    for (const event of events) {
      const owner = ownedByEventId.get(event.id);
      if (!owner) {
        externals.push({ spaceId, event });
        continue;
      }
      if (touchedBookingIds.has(owner.id)) continue;

      if (owner.spaceId !== spaceId) {
        // Case 2: the operator dragged it to another studio's calendar.
        touchedBookingIds.add(owner.id);
        moves.push({
          bookingId: owner.id,
          fromSpaceId: owner.spaceId,
          toSpaceId: spaceId,
        });
        continue;
      }

      // Case 1: ours, on the expected calendar. Still check the clock — the
      // operator may have dragged it to a different time, in which case the row
      // is stale and would block the OLD slot while leaving the new one
      // bookable. Duration drives price, so the caller logs the delta.
      if (
        !sameInstant(owner.start, event.start) ||
        !sameInstant(owner.end, event.end)
      ) {
        touchedBookingIds.add(owner.id);
        retimes.push({
          bookingId: owner.id,
          fromStart: owner.start,
          fromEnd: owner.end,
          toStart: event.start,
          toEnd: event.end,
        });
      }
    }
  }

  return { externals, moves, retimes };
}
