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

export interface MergePlan {
  /** Events belonging to no known booking — render these as busy. */
  externals: Array<{ spaceId: BookingDto["spaceId"]; event: CalendarEventLite }>;
  /** Our bookings discovered on another space's calendar. */
  moves: PlannedMove[];
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
  // An event id can only live on one calendar, but guard anyway so a duplicate
  // reading can't queue two conflicting re-homes for the same booking.
  const movedBookingIds = new Set<string>();

  for (const { spaceId, events } of args.eventsBySpace) {
    for (const event of events) {
      const owner = ownedByEventId.get(event.id);
      if (!owner) {
        externals.push({ spaceId, event });
        continue;
      }
      if (owner.spaceId === spaceId) continue; // case 1: ours, where expected
      if (movedBookingIds.has(owner.id)) continue;
      movedBookingIds.add(owner.id);
      moves.push({
        bookingId: owner.id,
        fromSpaceId: owner.spaceId,
        toSpaceId: spaceId,
      });
    }
  }

  return { externals, moves };
}
