import {
  calendarIdForSpace,
  deleteEvent,
  insertSimpleEvent,
  isCalendarLiveForSpace,
  listEventsForSpace,
} from "./google-calendar";
import type { BookingDto } from "@shared/schema";

// ---------------------------------------------------------------------------
// Booking buffers: place a 30-min buffer event before and after a booking on the
// studio's Google Calendar — so Peerspace, Giggster, and our own site all see the
// buffer as busy. Buffers are trimmed so they never overlap a real booking, and
// tagged so re-runs replace our own buffers rather than stacking them. Triggered
// by Giggster confirmation emails (below) and by confirmed studioclyx.com bookings
// (applyBookingBuffers, called from the confirm flow in routes.ts).
// ---------------------------------------------------------------------------

type SpaceId = BookingDto["spaceId"];

export const BUFFER_TAG = "Studio Clyx buffer";
const BUFFER_SUMMARY = `${BUFFER_TAG} — do not book (setup/teardown buffer)`;

export function bufferMinutes(): number {
  const n = Number(
    process.env.AGENT_BUFFER_MINUTES ||
      process.env.AGENT_GIGGSTER_BUFFER_MINUTES ||
      30
  );
  return Math.max(0, Number.isFinite(n) ? n : 30);
}

export function isGiggsterEmail(fromAddress: string | null | undefined): boolean {
  return Boolean(fromAddress) && /giggster\.com/i.test(fromAddress as string);
}

// A Giggster confirmed-booking email (vs. messages, payouts, etc.).
export function isGiggsterConfirmation(
  subject: string | null,
  text: string | null
): boolean {
  const s = `${subject || ""}\n${text || ""}`;
  if (/confirmed booking details/i.test(s)) return true;
  return /your booking[^\n]{0,40}is confirmed/i.test(s);
}

// ----- Parsing -----

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function detectStudio(text: string): SpaceId | null {
  const rn = text.match(/studio\s*clyx\s*(iii|ii|i)\b/i);
  if (rn) {
    const r = rn[1].toLowerCase();
    if (r === "iii") return "studio-3";
    if (r === "ii") return "studio-2";
    if (r === "i") return "studio-1";
  }
  if (/lincoln/i.test(text) || /mid[\s-]?century modern apartment/i.test(text))
    return "lincoln-apartment";
  return null;
}

function parseDate(text: string): { y: number; mo: number; d: number } | null {
  const m = text.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i
  );
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
  if (mo === undefined) return null;
  return { y: parseInt(m[3], 10), mo, d: parseInt(m[2], 10) };
}

function to24(h: number, ap: string): number {
  return (h % 12) + (/pm/i.test(ap) ? 12 : 0);
}

function parseTimeRange(
  text: string
): { sh: number; sm: number; eh: number; em: number } | null {
  const m = text.match(
    /(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i
  );
  if (!m) return null;
  return {
    sh: to24(parseInt(m[1], 10), m[3]),
    sm: parseInt(m[2], 10),
    eh: to24(parseInt(m[4], 10), m[6]),
    em: parseInt(m[5], 10),
  };
}

// Minutes that America/New_York is offset from UTC at a given instant (handles
// EDT/EST), using Intl so we don't need a tz library.
function nyOffsetMinutes(utc: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(utc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return (asIfUtc - utc.getTime()) / 60000;
}

// Convert a New York wall-clock time to a UTC epoch (ms), DST-correct.
function nyWallToEpoch(y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  let off = nyOffsetMinutes(new Date(guess));
  let epoch = guess - off * 60000;
  off = nyOffsetMinutes(new Date(epoch)); // refine across DST edges
  epoch = guess - off * 60000;
  return epoch;
}

export interface GiggsterBooking {
  studio: SpaceId;
  startEpoch: number;
  endEpoch: number;
}

export function parseGiggsterConfirmation(
  subject: string | null,
  text: string | null
): GiggsterBooking | null {
  const blob = `${subject || ""}\n${text || ""}`;
  const studio = detectStudio(blob);
  const date = parseDate(blob);
  const time = parseTimeRange(text || subject || "");
  if (!studio || !date || !time) return null;
  const startEpoch = nyWallToEpoch(date.y, date.mo, date.d, time.sh, time.sm);
  let endEpoch = nyWallToEpoch(date.y, date.mo, date.d, time.eh, time.em);
  if (endEpoch <= startEpoch) endEpoch += 24 * 60 * 60 * 1000; // crosses midnight
  return { studio, startEpoch, endEpoch };
}

// ----- Buffer engine -----

function isOurBuffer(summary?: string): boolean {
  return Boolean(summary && summary.includes(BUFFER_TAG));
}

const iso = (epoch: number) => new Date(epoch).toISOString();

// Place trimmed buffer events around a booking; replace our own existing buffers
// in the window first. Never overlaps a real (non-buffer) event. Used for both
// Giggster bookings and confirmed studioclyx.com bookings.
export async function applyBookingBuffers(
  studio: SpaceId,
  startEpoch: number,
  endEpoch: number
): Promise<{ ok: boolean; created: number; reason?: string }> {
  const calendarId = calendarIdForSpace(studio);
  if (!isCalendarLiveForSpace(studio) || !calendarId) {
    return { ok: false, created: 0, reason: `calendar not live for ${studio}` };
  }
  const bm = bufferMinutes();
  if (bm <= 0) return { ok: true, created: 0, reason: "buffer disabled (0 min)" };

  const preStartRaw = startEpoch - bm * 60000;
  const postEndRaw = endEpoch + bm * 60000;

  const res = await listEventsForSpace(
    studio,
    new Date(preStartRaw - 5 * 60000),
    new Date(postEndRaw + 5 * 60000)
  );
  if (!res.ok) {
    return { ok: false, created: 0, reason: `calendar read failed: ${res.reason}` };
  }
  const events = res.events.map((e) => ({
    id: e.id,
    summary: e.summary,
    s: new Date(e.start).getTime(),
    e: new Date(e.end).getTime(),
  }));
  const real = events.filter((e) => !isOurBuffer(e.summary));
  const ours = events.filter((e) => isOurBuffer(e.summary));

  // Trim pre-buffer [start-bm, start] up to the latest real event end inside it.
  let preStart = preStartRaw;
  for (const e of real) {
    if (e.e > preStartRaw && e.s < startEpoch) preStart = Math.max(preStart, e.e);
  }
  // Trim post-buffer [end, end+bm] down to the earliest real event start inside it.
  let postEnd = postEndRaw;
  for (const e of real) {
    if (e.s < postEndRaw && e.e > endEpoch) postEnd = Math.min(postEnd, e.s);
  }

  // Replace our own overlapping buffers (idempotent re-runs).
  for (const b of ours) {
    if (b.e > preStartRaw && b.s < postEndRaw) {
      await deleteEvent(b.id, calendarId).catch(() => {});
    }
  }

  let created = 0;
  if (preStart < startEpoch) {
    const r = await insertSimpleEvent(studio, BUFFER_SUMMARY, iso(preStart), iso(startEpoch), {
      studioClyxBuffer: "1",
    });
    if (r.ok) created++;
    else console.error("[buffers] pre-buffer insert failed:", r.error || r.reason);
  }
  if (endEpoch < postEnd) {
    const r = await insertSimpleEvent(studio, BUFFER_SUMMARY, iso(endEpoch), iso(postEnd), {
      studioClyxBuffer: "1",
    });
    if (r.ok) created++;
    else console.error("[buffers] post-buffer insert failed:", r.error || r.reason);
  }
  return { ok: true, created };
}

// Remove our buffer events around a booking window (e.g. when the booking is
// cancelled/released and its calendar event is removed). Best-effort.
export async function removeBookingBuffers(
  studio: SpaceId,
  startEpoch: number,
  endEpoch: number
): Promise<void> {
  const calendarId = calendarIdForSpace(studio);
  if (!isCalendarLiveForSpace(studio) || !calendarId) return;
  const bm = bufferMinutes();
  const winStartMs = startEpoch - bm * 60000;
  const winEndMs = endEpoch + bm * 60000;
  const res = await listEventsForSpace(
    studio,
    new Date(winStartMs - 5 * 60000),
    new Date(winEndMs + 5 * 60000)
  );
  if (!res.ok) return;
  for (const e of res.events) {
    if (!isOurBuffer(e.summary)) continue;
    const es = new Date(e.start).getTime();
    const ee = new Date(e.end).getTime();
    if (ee > winStartMs && es < winEndMs) {
      await deleteEvent(e.id, calendarId).catch(() => {});
    }
  }
}

// Entry point from the inbound poller for a Giggster email.
export async function handleGiggsterEmail(
  subject: string | null,
  text: string | null
): Promise<void> {
  if (!isGiggsterConfirmation(subject, text)) {
    console.log("[giggster] non-confirmation Giggster email; ignoring");
    return;
  }
  const booking = parseGiggsterConfirmation(subject, text);
  if (!booking) {
    console.warn("[giggster] confirmation email but couldn't parse studio/date/time; skipping");
    return;
  }
  const result = await applyBookingBuffers(
    booking.studio,
    booking.startEpoch,
    booking.endEpoch
  );
  console.log(
    `[giggster] ${booking.studio} ${new Date(booking.startEpoch).toISOString()}–${new Date(
      booking.endEpoch
    ).toISOString()}: ${result.ok ? `placed ${result.created} buffer(s)` : `skipped (${result.reason})`}`
  );
}
