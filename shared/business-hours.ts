// ---------------------------------------------------------------------------
// Standard booking hours, and which bookings need the operator to say yes.
//
// Sessions that sit entirely inside standard hours behave as they always have:
// book, pay, confirmed. A session with ANY half-hour outside standard hours is
// not blocked — it becomes a REQUEST that an operator accepts or declines, so
// an overnight or very early start can't auto-confirm itself while nobody is
// around to staff it.
//
// Pure module (no drizzle, no DB) so the client and the server can both import
// it and can never disagree about where the boundary is.
// ---------------------------------------------------------------------------

/** Earliest a standard session may START (New York local). */
export const STANDARD_HOURS_START_HOUR = 8; // 8:00 AM
/** Latest a standard session may END (New York local). 24 = midnight. */
export const STANDARD_HOURS_END_HOUR = 24; // 12:00 AM

/**
 * How long a request holds its slot. Much longer than the 60-minute payment
 * hold: a 3 AM request may sit until morning, and if the hold lapsed first the
 * slot would reopen and could be sold twice while the request was still live.
 */
export const REQUEST_HOLD_DURATION_MINUTES = 24 * 60;

export const BOOKING_SLOT_MINUTES = 30;

const NY_TIME_ZONE = "America/New_York";

/** Minutes since New York midnight for an instant (DST-correct). */
export function nyMinutesOfDay(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TIME_ZONE,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return NaN;
  return hour * 60 + minute;
}

/**
 * True when any half-hour of [start, end) falls outside standard hours, i.e.
 * the booking needs operator approval.
 *
 * Each slot is judged in its own New York day, so a session that crosses
 * midnight is handled without special cases: 11:00 PM-1:00 AM has two in-hours
 * slots and two out-of-hours ones, and needs approval. A session ending exactly
 * at midnight is fully standard.
 *
 * Returns false for an unparseable or empty window — callers treat that as
 * "nothing unusual" and the normal booking-rule validation rejects it.
 */
export function requiresApprovalForWindow(
  startIso: string,
  endIso: string
): boolean {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return false;
  }
  const stepMs = BOOKING_SLOT_MINUTES * 60 * 1000;
  const openMinute = STANDARD_HOURS_START_HOUR * 60;
  const closeMinute = STANDARD_HOURS_END_HOUR * 60;
  for (let t = start; t < end; t += stepMs) {
    const minutes = nyMinutesOfDay(new Date(t));
    if (!Number.isFinite(minutes)) return false;
    if (minutes < openMinute) return true;
    if (minutes + BOOKING_SLOT_MINUTES > closeMinute) return true;
  }
  return false;
}

/** "8:00 AM" / "12:00 AM" — for guest-facing copy. */
function hourLabel(hour24: number): string {
  const h = hour24 % 24;
  const suffix = h < 12 ? "AM" : "PM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${suffix}`;
}

/** e.g. "8:00 AM to 12:00 AM" — single source for the copy. */
export const STANDARD_HOURS_LABEL = `${hourLabel(
  STANDARD_HOURS_START_HOUR
)} to ${hourLabel(STANDARD_HOURS_END_HOUR)}`;
