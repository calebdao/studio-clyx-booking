// ---------------------------------------------------------------------------
// Does a booking block its slot?
//
// One definition, imported by the server's conflict checks, the public
// availability feed, and the client scheduler. Keeping these in step matters:
// the server used to exclude rejected bookings from conflict checks while the
// public feed still shipped them and the scheduler drew every row it received,
// so a rejected booking stayed visibly blocked for guests forever.
//
// Pure module (no drizzle, no DB) so both sides can import it.
// ---------------------------------------------------------------------------

export function bookingBlocksAvailability(booking: {
  status: string;
  holdActive?: boolean;
}): boolean {
  // Declined or rejected: the slot is free and must look free.
  if (booking.status === "rejected") return false;

  // An expired hold stops blocking. The row deliberately survives as a pending
  // request until an operator confirms or rejects it (see the hold lifecycle),
  // but it must not keep the slot off the market in the meantime. This also
  // covers an out-of-hours request whose 24-hour hold lapses unanswered —
  // without it, that slot would be blocked indefinitely.
  //
  // Checked against `false` explicitly: Google-sourced entries carry no
  // holdActive at all and must keep blocking.
  if (
    (booking.status === "held" || booking.status === "pending") &&
    booking.holdActive === false
  ) {
    return false;
  }

  return true;
}
