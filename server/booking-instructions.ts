import { storage } from "./storage";

// ---------------------------------------------------------------------------
// Booking-confirmation handling: when Peerspace emails that a guest booked a
// space, detect it, figure out which studio + the start time, and select the
// exact entry-instruction template to send.
//
// The templates contain door/lockbox codes, so they live ONLY in the database
// (app_settings key "booking_instructions"), entered via the admin "Access
// Instructions" editor — never in this repo (it's public).
// ---------------------------------------------------------------------------

const SETTING_KEY = "booking_instructions";

export type StudioKey =
  | "studio-1"
  | "studio-2"
  | "studio-3"
  | "lincoln-apartment";

export interface BookingInfo {
  studio: StudioKey | null;
  startMinutes: number | null; // minutes since midnight (NY local), from the booking start time
  dateTimeText: string | null; // human-readable date/time for display
  spaceText: string | null; // the "Space" line from the email
  guestNote: string | null; // any message the guest included with the booking
  attendees: number | null;
  isEvent: boolean; // looks like an event (DJ/party/etc. or large group)
}

// Appended to entry instructions for events / after-hours bookings (no door codes
// — safe here).
export const EVENT_SECURITY_NOTE =
  "\n\n— Building security —\n" +
  "You're welcome to prop the building's main doors open during your session for " +
  "easy guest access. When your session ends, please close the building's main " +
  "doors and return the keys to the lockbox, then send us photos confirming both " +
  "— this helps keep the whole building secure.";

// Event signals come from the GUEST'S note (and attendee count) — never the
// listing name, since Studio 3's listing literally contains "Event Loft".
const EVENT_KEYWORDS = [
  /\bevent\b/i,
  /\bparty\b/i,
  /\bdj\b/i,
  /birthday/i,
  /celebrat/i,
  /\bshower\b/i,
  /reception/i,
  /wedding/i,
  /anniversary/i,
  /\blaunch\b/i,
  /activation/i,
  /pop[\s-]?up/i,
  /screening/i,
  /\bmixer\b/i,
  /gathering/i,
  /fundraiser/i,
  /networking/i,
  /\brave\b/i,
];

function parseAttendees(text: string): number | null {
  const m = text.match(/Attendees\s*\n+\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function looksLikeEvent(
  guestNote: string | null,
  attendees: number | null,
  startMinutes: number | null
): boolean {
  const note = guestNote || "";
  if (EVENT_KEYWORDS.some((re) => re.test(note))) return true;
  if (attendees != null && attendees >= 20) return true;
  // After-hours (starts before 9 AM or at/after 3 PM) — treat as an event for the
  // building-security note, since the building is otherwise locked up.
  if (startMinutes != null && (startMinutes < 9 * 60 || startMinutes >= 15 * 60))
    return true;
  return false;
}

// A confirmed-booking email has a "Booking details" block AND the
// confirmation-only signals "View booking" / "Payment details". Inquiries say
// "Inquiry details" / "Estimated payout"; booking *reminders* ("is coming up")
// also have "Booking details" + "Payout" but NOT these — so requiring them keeps
// us from re-sending instructions on a reminder. Also gate on isBookingReminder.
export function isBookingEmail(text: string | null): boolean {
  if (!text) return false;
  if (isBookingReminder(text)) return false;
  if (!/(^|\n)\s*Booking details/i.test(text)) return false;
  return /view booking/i.test(text) || /payment details/i.test(text);
}

// Peerspace booking reminders ("… is coming up" / "… starts soon") — not a new
// booking and not a guest message, so the agent should ignore them entirely.
export function isBookingReminder(text: string | null): boolean {
  if (!text) return false;
  return (
    /\bis coming up\b/i.test(text) ||
    /\bstarts soon\b/i.test(text) ||
    /your booking starts\b/i.test(text) ||
    /make sure to greet\b/i.test(text) ||
    /finalize any last[\s-]*minute details/i.test(text)
  );
}

function valueAfter(text: string, label: string): string | null {
  const re = new RegExp(
    label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\n+\\s*([^\\n]+)",
    "i"
  );
  const m = text.match(re);
  return m ? m[1].trim().replace(/^\*+|\*+$/g, "").trim() || null : null;
}

// Identify the studio from the email — try the "STUDIO CLYX I/II/III" roman
// numeral first, then the address/unit, then the listing name. Returns null if
// we can't tell (caller flags it for a human rather than guessing a door code).
function detectStudio(text: string): StudioKey | null {
  const rn = text.match(/studio\s*clyx\s*(iii|ii|i)\b/i);
  if (rn) {
    const r = rn[1].toLowerCase();
    if (r === "iii") return "studio-3";
    if (r === "ii") return "studio-2";
    if (r === "i") return "studio-1";
  }
  if (/#\s*321\b/.test(text) || /\bunit\s*#?\s*321\b/i.test(text)) return "studio-1";
  if (/#\s*118\b/.test(text) || /\bunit\s*#?\s*118\b/i.test(text)) return "studio-2";
  if (/lincoln\s+place/i.test(text)) return "lincoln-apartment";
  const lc = text.toLowerCase();
  if (lc.includes("natural light minimalist loft")) return "studio-1";
  if (lc.includes("designer minimalist loft")) return "studio-2";
  if (lc.includes("sunlit photo") || lc.includes("studio clyx iii")) return "studio-3";
  if (lc.includes("cosy mid century") || lc.includes("mid century modern apartment"))
    return "lincoln-apartment";
  return null;
}

// Pull the booking START time (minutes since midnight, NY local) from the
// "Date and time" block, e.g. "1:00 PM - 4:00 PM EDT" → 13:00 → 780.
function parseStartMinutes(text: string): number | null {
  const idx = text.search(/Date and time/i);
  const region = idx !== -1 ? text.slice(idx, idx + 240) : text;
  const m = region.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function parseDateTimeText(text: string): string | null {
  const idx = text.search(/Date and time/i);
  if (idx === -1) return null;
  const after = text.slice(idx + "Date and time".length);
  const lines = after
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // First two non-empty lines are typically the date then the time range.
  const parts = lines.slice(0, 2).filter((l) => !/^https?:\/\//i.test(l));
  return parts.length ? parts.join(" ") : null;
}

function parseGuestNote(text: string): string | null {
  const t = text.replace(/\r\n?/g, "\n");
  const cut = t.search(/\n\s*(Send message|Reply to this email|Booking details)/i);
  if (cut === -1) return null;
  const note = t
    .slice(0, cut)
    .split("\n")
    .filter((l) => !/^https?:\/\//i.test(l.trim()) && !/^<http/i.test(l.trim()))
    .join("\n")
    .trim();
  return note.length >= 3 ? note.slice(0, 2000) : null;
}

export function parseBooking(text: string): BookingInfo {
  const spaceText = valueAfter(text, "Space");
  const guestNote = parseGuestNote(text);
  const attendees = parseAttendees(text);
  const startMinutes = parseStartMinutes(text);
  return {
    studio: detectStudio(text),
    startMinutes,
    dateTimeText: parseDateTimeText(text),
    spaceText,
    guestNote,
    attendees,
    isEvent: looksLikeEvent(guestNote, attendees, startMinutes),
  };
}

// ----- Instruction templates (DB-stored) -----

function loadTemplates(): Record<string, string> {
  const raw = storage.getSetting(SETTING_KEY);
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function getInstructionTemplates(): Record<string, string> {
  return loadTemplates();
}

export function saveInstructionTemplates(map: Record<string, string>): void {
  storage.setSetting(SETTING_KEY, JSON.stringify(map));
}

const DAY_START = 9 * 60; // 9:00 AM
const DAY_END = 15 * 60; // 3:00 PM

// Choose the exact template for a booking. Studio 1 & 2 depend on the start time
// (day vs after-hours); Studio 3 & Lincoln have a single set. Returns text=null
// (with a reason) when we can't resolve it — caller flags for a human.
export function selectInstruction(
  studio: StudioKey,
  startMinutes: number | null
): { text: string | null; key: string | null; reason?: string } {
  const all = loadTemplates();
  const needsTime = studio === "studio-1" || studio === "studio-2";
  let key: string;
  if (needsTime) {
    if (startMinutes == null) {
      return { text: null, key: null, reason: "couldn't read the booking start time" };
    }
    const isDay = startMinutes >= DAY_START && startMinutes < DAY_END;
    key = `${studio}-${isDay ? "day" : "after"}`;
  } else {
    key = studio;
  }
  const text = (all[key] ?? "").trim() || null;
  return {
    text,
    key,
    reason: text ? undefined : `no saved instructions for "${key}" — add them in the Access Instructions tab`,
  };
}
