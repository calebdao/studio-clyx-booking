// Studio Clyx — booking domain types, constants, and seed data.
// All data is in-memory for the Phase 1 prototype. Future: Supabase + Google Calendar.

export type SpaceId = "studio-1" | "studio-2" | "studio-3" | "lincoln-apartment";

export type ActivityId = "production" | "meeting" | "event";

export type BookingStatus = "held" | "pending" | "confirmed";

export interface Space {
  id: SpaceId;
  name: string;
  shortName: string;
  description: string;
  swatch: string; // tailwind text class for the space's calendar swatch (used in admin)
  hex: string;
}

export interface Activity {
  id: ActivityId;
  name: string;
  rate: number; // dollars per hour
  description: string;
}

export interface Booking {
  id: string;
  spaceId: SpaceId;
  activityId: ActivityId;
  // ISO strings, anchored to 30-minute boundaries
  start: string;
  end: string;
  status: BookingStatus;
  guest: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
  };
  // For held bookings: epoch ms when the hold expires
  holdExpiresAt?: number;
  createdAt: number;
  // For mock booked entries that came from external platforms
  source?: "internal" | "peerspace" | "giggster" | "google";
}

export const SPACES: Space[] = [
  {
    id: "studio-1",
    name: "Studio 1",
    shortName: "S1",
    description: "Cyc wall, hard infinity. Best for product, fashion, and music video.",
    swatch: "bg-[#BC7518]", // brass
    hex: "#BC7518",
  },
  {
    id: "studio-2",
    name: "Studio 2",
    shortName: "S2",
    description: "Daylight bay with blackout. Suited for natural-light editorial and interviews.",
    swatch: "bg-[#3F6B6E]", // teal-grey
    hex: "#3F6B6E",
  },
  {
    id: "studio-3",
    name: "Studio 3",
    shortName: "S3",
    description: "Soundstage with tie-line and low-ceiling kit. Best for podcasts and small live sets.",
    swatch: "bg-[#7A4A2E]", // burnt sienna
    hex: "#7A4A2E",
  },
  {
    id: "lincoln-apartment",
    name: "Lincoln Apartment",
    shortName: "LA",
    description: "Furnished location apartment. Kitchen, living room, two bedrooms.",
    swatch: "bg-[#3D4A5A]", // slate
    hex: "#3D4A5A",
  },
];

export const ACTIVITIES: Activity[] = [
  { id: "production", name: "Production", rate: 60, description: "Photo, video, and recording sessions." },
  { id: "meeting", name: "Meeting", rate: 80, description: "Workshops, casting, client meetings." },
  { id: "event", name: "Event", rate: 80, description: "Receptions, screenings, private gatherings." },
];

// Booking rules
export const SLOT_MINUTES = 30;
export const MIN_LEAD_HOURS = 7;
export const MIN_DURATION_HOURS = 2;
export const BOOKING_WINDOW_MONTHS = 12;
export const HOLD_DURATION_MINUTES = 30;

export const ZELLE_RECIPIENT = "calebdao@gmail.com";
export const STUDIO_OWNER_EMAIL = "theriotmachinex@gmail.com";

// Helpers
export function spaceById(id: SpaceId): Space {
  return SPACES.find((s) => s.id === id)!;
}
export function activityById(id: ActivityId): Activity {
  return ACTIVITIES.find((a) => a.id === id)!;
}

// Round a Date down to the nearest 30-minute boundary
export function floorToSlot(d: Date): Date {
  const ms = d.getTime();
  const step = SLOT_MINUTES * 60 * 1000;
  return new Date(Math.floor(ms / step) * step);
}

export function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60 * 1000);
}

export function isoSlot(d: Date): string {
  return floorToSlot(d).toISOString();
}

// Build seed data anchored relative to "now" so the prototype always feels fresh.
// Generates a realistic spread of confirmed and pending bookings across the next 14 days.
export function buildSeedBookings(now: Date = new Date()): Booking[] {
  const today = floorToSlot(now);
  // Reset to today at 00:00 local
  const day0 = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);

  const make = (
    spaceId: SpaceId,
    activityId: ActivityId,
    dayOffset: number,
    startHour: number, // 24h, may include .5
    durationHours: number,
    status: BookingStatus,
    guest: Booking["guest"],
    source: Booking["source"] = "internal"
  ): Booking => {
    const start = new Date(day0);
    start.setDate(start.getDate() + dayOffset);
    start.setHours(Math.floor(startHour), (startHour % 1) * 60, 0, 0);
    const end = addMinutes(start, durationHours * 60);
    return {
      id: `seed-${spaceId}-${dayOffset}-${startHour}-${Math.random().toString(36).slice(2, 7)}`,
      spaceId,
      activityId,
      start: start.toISOString(),
      end: end.toISOString(),
      status,
      guest,
      createdAt: now.getTime() - 3600_000 * 24,
      source,
      holdExpiresAt:
        status === "held" ? now.getTime() + 18 * 60 * 1000 : undefined,
    };
  };

  return [
    // --- Today / tomorrow: confirmed bookings (locked in) ---
    make(
      "studio-1",
      "production",
      0,
      10,
      4,
      "confirmed",
      { firstName: "Maya", lastName: "Okafor", email: "maya@northlightstudio.com", phone: "415-555-0182" },
      "peerspace"
    ),
    make(
      "studio-2",
      "production",
      0,
      14,
      3,
      "confirmed",
      { firstName: "Jordan", lastName: "Reyes", email: "jordan@reyesfilm.co" },
      "giggster"
    ),
    make(
      "studio-3",
      "meeting",
      0,
      18,
      2,
      "confirmed",
      { firstName: "Priya", lastName: "Shah", email: "priya@shahcollective.com", phone: "718-555-0144" },
      "internal"
    ),
    make(
      "lincoln-apartment",
      "event",
      1,
      19,
      4,
      "confirmed",
      { firstName: "Carmen", lastName: "Ali", email: "carmen.ali@example.com" },
      "internal"
    ),
    make(
      "studio-1",
      "production",
      1,
      9,
      5,
      "confirmed",
      { firstName: "Theo", lastName: "Brand", email: "theo@brandhouse.tv" },
      "peerspace"
    ),

    // --- Day 2-4: a mix ---
    make(
      "studio-2",
      "event",
      2,
      17,
      4,
      "confirmed",
      { firstName: "Ines", lastName: "Larsson", email: "ines@nordicpop.se" },
      "peerspace"
    ),
    make(
      "studio-3",
      "production",
      3,
      11,
      3.5,
      "confirmed",
      { firstName: "Marcus", lastName: "Oduya", email: "marcus@oduyamusic.com" },
      "giggster"
    ),
    make(
      "lincoln-apartment",
      "production",
      3,
      13,
      6,
      "confirmed",
      { firstName: "Saoirse", lastName: "Doyle", email: "saoirse@example.com" },
      "internal"
    ),
    make(
      "studio-1",
      "meeting",
      4,
      15,
      2.5,
      "confirmed",
      { firstName: "Kenji", lastName: "Watanabe", email: "kenji@watanabearch.com" },
      "internal"
    ),

    // --- Held + Pending (active holds awaiting payment) ---
    make(
      "studio-2",
      "production",
      2,
      10,
      3,
      "held",
      { firstName: "Lila", lastName: "Bennett", email: "lila.bennett@example.com" },
      "internal"
    ),
    make(
      "studio-3",
      "event",
      5,
      20,
      4,
      "pending",
      { firstName: "Devon", lastName: "Park", email: "devon@parkstudios.io", phone: "212-555-0169" },
      "internal"
    ),
    make(
      "lincoln-apartment",
      "meeting",
      6,
      14,
      2,
      "pending",
      { firstName: "Anya", lastName: "Volkov", email: "anya.volkov@example.com" },
      "internal"
    ),

    // --- Further out, scattered ---
    make("studio-1", "production", 7, 12, 4, "confirmed", { firstName: "Ravi", lastName: "Iyer", email: "ravi@iyerco.com" }, "peerspace"),
    make("studio-2", "production", 8, 9, 3, "confirmed", { firstName: "Noor", lastName: "Hassan", email: "noor@hassanvisual.com" }, "internal"),
    make("studio-3", "production", 10, 16, 5, "confirmed", { firstName: "Eli", lastName: "Mendez", email: "eli@mendezsound.fm" }, "giggster"),
    make("lincoln-apartment", "event", 11, 18, 6, "confirmed", { firstName: "Tess", lastName: "Galloway", email: "tess.g@example.com" }, "internal"),
    make("studio-1", "meeting", 13, 11, 2, "confirmed", { firstName: "Aiko", lastName: "Tanaka", email: "aiko@tanakapress.jp" }, "internal"),
  ];
}

// Compute price for a given activity and number of 30-minute slots
export function computePrice(activity: Activity, slots: number): number {
  return activity.rate * (slots * 0.5);
}

// Format a Date as a 30-min slot label, e.g. "10:00", "10:30", "00:00"
export function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}
export function fmtTime12(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}
export function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
export function fmtDayLong(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
export function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

// Slot occupancy: returns set of slot ISO strings that are taken (held/pending/confirmed)
// for a given space. Each booking is expanded into its constituent 30-min slots.
export function bookingsToOccupiedSlots(
  bookings: Booking[],
  spaceId: SpaceId
): Map<string, Booking> {
  const map = new Map<string, Booking>();
  for (const b of bookings) {
    if (b.spaceId !== spaceId) continue;
    let cursor = new Date(b.start);
    const end = new Date(b.end);
    while (cursor < end) {
      map.set(cursor.toISOString(), b);
      cursor = addMinutes(cursor, SLOT_MINUTES);
    }
  }
  return map;
}

// Generate the slot grid for a specific day: 48 slots from 00:00 to 23:30
export function daySlots(day: Date): Date[] {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  const slots: Date[] = [];
  for (let i = 0; i < 48; i++) {
    slots.push(addMinutes(start, i * SLOT_MINUTES));
  }
  return slots;
}
