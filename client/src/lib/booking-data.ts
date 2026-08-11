// Studio Clyx — booking domain types, constants, and seed data.
// All data is in-memory for the Phase 1 prototype. Future: Supabase + Google Calendar.

import { applyPromo } from "@shared/schema";

export type SpaceId = "studio-1" | "studio-2" | "studio-3" | "lincoln-apartment";

export type ActivityId = "production" | "meeting" | "event";

export type BookingStatus = "held" | "pending" | "confirmed" | "rejected";

export type PaymentMethod = "zelle" | "card";

export type AddOnPriceType = "per_item" | "flat";

export type AddOnCategory =
  | "furniture"
  | "grip"
  | "lighting"
  | "expendables"
  | "computers"
  | "production"
  | "camera-video"
  | "sound";

export interface AddOnCatalogItem {
  id: string;
  name: string;
  description?: string | null;
  price: number;
  priceType: AddOnPriceType;
  imageUrl?: string | null;
  quantityAvailable?: number | null;
  category?: AddOnCategory | null;
  active: boolean;
  sortOrder?: number;
}

export interface SelectedAddOn {
  addOnId: string;
  name: string;
  price: number;
  priceType: AddOnPriceType;
  quantity: number;
  lineTotal: number;
}

export interface Space {
  id: SpaceId;
  name: string;
  shortName: string;
  description: string;
  swatch: string; // tailwind text class for the space's calendar swatch (used in admin)
  hex: string;
  // Photo shown on the booking page so guests recognize the room. Either a full
  // URL (e.g. a hosted Peerspace/Squarespace image) or a path to a file in
  // client/public (e.g. "/studios/studio-1.jpg"). Optional — falls back to a
  // colored block with the short name until a photo is set.
  image?: string;
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
  guestCount: number;
  alcohol: boolean;
  addons: SelectedAddOn[];
  // For held bookings: epoch ms when the hold expires
  holdExpiresAt?: number;
  holdActive?: boolean;
  reminderSentAt?: number;
  googleEventId?: string;
  googleCalendarId?: string;
  paymentMethod?: PaymentMethod;
  promoCode?: string | null;
  cardFeeAmount?: number;
  paidAt?: number;
  stripePaymentIntentId?: string;
  createdAt: number;
  // For mock booked entries that came from external platforms
  source?: "internal" | "peerspace" | "giggster" | "google";
}

export const SPACES: Space[] = [
  {
    id: "studio-1",
    name: "Studio 1",
    shortName: "S1",
    description:
      "Minimal editorial studio with soft earth tones, refined finishes, and French doors to Studio 3 for expanded shoots.",
    swatch: "bg-[#BC7518]", // brass
    hex: "#BC7518",
    image:
      "https://images.squarespace-cdn.com/content/v1/666b23ff5801013aa6a66b6f/556b1650-266b-47e3-b49d-241eb977262a/2026+copy2.jpg?format=1000w",
  },
  {
    id: "studio-2",
    name: "Studio 2",
    shortName: "S2",
    description:
      "850 sq ft luxury set with velvet textures, rich tones, mid-century pieces, drapery, and a signature wood accent wall.",
    swatch: "bg-[#3F6B6E]", // teal-grey
    hex: "#3F6B6E",
    image:
      "https://images.squarespace-cdn.com/content/v1/666b23ff5801013aa6a66b6f/792cec7d-843f-4539-bae6-8fb8450d45b1/DSC00935+copy.jpg?format=1000w",
  },
  {
    id: "studio-3",
    name: "Studio 3",
    shortName: "S3",
    description:
      "Sun-drenched lifestyle loft with marble, velvet, travertine, burl wood, and a sculptural bar for events and campaigns.",
    swatch: "bg-[#7A4A2E]", // burnt sienna
    hex: "#7A4A2E",
    image:
      "https://images.squarespace-cdn.com/content/v1/666b23ff5801013aa6a66b6f/93f792d6-fa9a-4808-b970-b64c842debe4/DSC00460+copy.jpg?format=1000w",
  },
  {
    id: "lincoln-apartment",
    name: "Lincoln Apartment",
    shortName: "LA",
    description:
      "Curated mid-century two-bedroom apartment with living room, kitchen, natural light, blush bedroom, and artful details.",
    swatch: "bg-[#3D4A5A]", // slate
    hex: "#3D4A5A",
    image:
      "https://images.squarespace-cdn.com/content/v1/666b23ff5801013aa6a66b6f/a5f39162-8558-4781-995c-e303911e2371/IMG_6918+2+copy.jpg?format=1000w",
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
export const HOLD_DURATION_MINUTES = 60;

// Guest tier + extra fee constants — must mirror shared/schema.ts.
export const GUEST_MIN = 1;
export const GUEST_MAX = 40;
export const GUEST_TIER_15_RATE = 0;
export const GUEST_TIER_25_RATE = 10;
export const GUEST_TIER_40_RATE = 20;
export const EVENT_CLEANING_FEE = 75;
export const ALCOHOL_FEE = 50;

// Stripe card-fee constants. Kept in sync with shared/schema.ts. Used for the
// live preview the customer sees when they pick "credit card". Server is still
// authoritative — the amount charged to Stripe is recomputed server-side.
export const STRIPE_FEE_PERCENT = 0.029;
export const STRIPE_FEE_FIXED = 0.3;

export function computeCardSurcharge(baseTotal: number): number {
  if (!Number.isFinite(baseTotal) || baseTotal <= 0) return 0;
  const gross = (baseTotal + STRIPE_FEE_FIXED) / (1 - STRIPE_FEE_PERCENT);
  return Math.round((gross - baseTotal) * 100) / 100;
}

export function guestSurchargeRate(count: number): number {
  if (count <= 15) return GUEST_TIER_15_RATE;
  if (count <= 25) return GUEST_TIER_25_RATE;
  if (count <= GUEST_MAX) return GUEST_TIER_40_RATE;
  return GUEST_TIER_40_RATE;
}

export function guestTierLabel(count: number): string {
  if (count <= 15) return "1\u201315 guests";
  if (count <= 25) return "16\u201325 guests";
  return "26\u201340 guests";
}

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
      guestCount: 1,
      alcohol: false,
      addons: [],
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

// Compute price for a given activity and number of 30-minute slots (legacy: hourly base only)
export function computePrice(activity: Activity, slots: number): number {
  return activity.rate * (slots * 0.5);
}

export interface PriceLine {
  label: string;
  detail?: string;
  amount: number;
}

export interface PriceBreakdown {
  hours: number;
  base: number;
  guestSurcharge: number;
  guestSurchargeRate: number;
  cleaningFee: number;
  alcoholFee: number;
  addonsTotal: number;
  promoDiscount: number;
  promoApplied: boolean;
  cardFee: number;
  subtotal: number; // total without card fee (what merchant nets)
  total: number; // what the customer owes (includes card fee if applicable)
  lines: PriceLine[];
}

export interface PriceInput {
  activity: Activity;
  slots: number;
  guestCount: number;
  alcohol: boolean;
  activityId: ActivityId;
  addons: SelectedAddOn[];
  paymentMethod?: PaymentMethod;
  promoCode?: string | null; // typed promo code (validated against the session date)
  startIso?: string | null; // session start ISO, needed to validate the promo window
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeAddOnLineTotal(item: AddOnCatalogItem, quantity: number): number {
  if (item.priceType === "flat") return round2(item.price);
  return round2(item.price * quantity);
}

export function selectedFromCatalog(
  item: AddOnCatalogItem,
  quantity: number
): SelectedAddOn {
  return {
    addOnId: item.id,
    name: item.name,
    price: item.price,
    priceType: item.priceType,
    quantity,
    lineTotal: computeAddOnLineTotal(item, quantity),
  };
}

export function computePriceBreakdown(input: PriceInput): PriceBreakdown {
  const { activity, slots, guestCount, alcohol, activityId, addons, paymentMethod, promoCode, startIso } = input;
  const hours = slots * 0.5;
  const base = round2(activity.rate * hours);
  const surchargeRate = guestSurchargeRate(guestCount);
  const guestSurcharge = round2(surchargeRate * hours);
  const cleaningFee = activityId === "event" ? EVENT_CLEANING_FEE : 0;
  const alcoholFee = alcohol ? ALCOHOL_FEE : 0;
  const addonsTotal = round2(
    addons.reduce((sum, a) => sum + (a.lineTotal ?? 0), 0)
  );
  // Promo: discount the hourly room rate (base) only, when a valid code is
  // entered AND it applies to this session (date window + activity).
  const promo =
    promoCode && startIso
      ? applyPromo({ base, hours, activityId, rawCode: promoCode, startIso })
      : null;
  const promoDiscount = promo?.discount ?? 0;
  const promoApplied = promoDiscount > 0;
  const subtotal = round2(
    base + guestSurcharge + cleaningFee + alcoholFee + addonsTotal - promoDiscount
  );
  const cardFee = paymentMethod === "card" ? computeCardSurcharge(subtotal) : 0;
  const total = round2(subtotal + cardFee);

  const lines: PriceLine[] = [
    {
      label: `${activity.name} rate`,
      detail: `$${activity.rate}/hr \u00d7 ${hours} hr`,
      amount: base,
    },
  ];
  if (surchargeRate > 0) {
    lines.push({
      label: `Guest surcharge (${guestTierLabel(guestCount)})`,
      detail: `$${surchargeRate}/hr \u00d7 ${hours} hr`,
      amount: guestSurcharge,
    });
  }
  if (cleaningFee > 0) {
    lines.push({ label: "Event cleaning fee", amount: cleaningFee });
  }
  if (alcoholFee > 0) {
    lines.push({ label: "Alcohol consumption fee", amount: alcoholFee });
  }
  for (const a of addons) {
    lines.push({
      label: a.name,
      detail:
        a.priceType === "flat"
          ? `flat \u00b7 $${a.price.toFixed(2)}`
          : `${a.quantity} \u00d7 $${a.price.toFixed(2)}`,
      amount: a.lineTotal,
    });
  }
  if (promo && promoDiscount > 0) {
    lines.push({
      label: `Promo (${promo.code})`,
      detail: promo.detail,
      amount: -promoDiscount,
    });
  }
  if (cardFee > 0) {
    lines.push({
      label: "Card processing fee",
      detail: "2.9% + $0.30 (Stripe, passed through)",
      amount: cardFee,
    });
  }
  return {
    hours,
    base,
    guestSurcharge,
    guestSurchargeRate: surchargeRate,
    cleaningFee,
    alcoholFee,
    addonsTotal,
    promoDiscount,
    promoApplied,
    cardFee,
    subtotal,
    total,
    lines,
  };
}

// ----- Studio timezone anchoring -----
// The studios are physical rooms in Brooklyn, so every slot the guest sees and
// picks is New York wall-clock time — regardless of the guest's own browser
// timezone. A guest in Madrid and a guest in Brooklyn must see the SAME grid.
// These helpers translate between a NY wall-clock time and the absolute instant
// (UTC) we store, using Intl so DST is handled automatically. Never build a
// bookable instant with the local `new Date(y, m, d, h, min)` constructor — that
// silently uses the browser's zone and is exactly what caused wrong-time bookings.
export const NY_TZ = "America/New_York";

// Milliseconds to add to a UTC instant to get NY wall-clock fields at that
// instant (negative, since NY is behind UTC). Handles EST/EDT via Intl.
function nyOffsetMs(utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const m: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") m[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(m.year, m.month - 1, m.day, m.hour, m.minute, m.second);
  return asUtc - utcMs;
}

// The absolute instant for a given NY wall-clock time. `month0` is 0-based.
// (On the twice-a-year DST transition the 2–3am hour is degenerate; the single
// offset refinement resolves to the adjacent valid instant, which is fine for a
// booking grid — those middle-of-the-night slots are effectively never booked.)
export function nyWallToUtc(
  year: number,
  month0: number,
  day: number,
  hour = 0,
  minute = 0
): Date {
  const guess = Date.UTC(year, month0, day, hour, minute);
  const offset = nyOffsetMs(guess);
  let utc = guess - offset;
  const offset2 = nyOffsetMs(utc);
  if (offset2 !== offset) utc = guess - offset2;
  return new Date(utc);
}

export interface NyParts {
  year: number;
  month: number; // 1-based
  day: number;
  hour: number; // 0-23
  minute: number;
  weekday: string; // "Mon", "Tue", ...
}

// NY wall-clock fields of an absolute instant.
export function nyParts(d: Date): NyParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(d)) {
    if (p.type !== "literal") m[p.type] = p.value;
  }
  return {
    year: Number(m.year),
    month: Number(m.month),
    day: Number(m.day),
    hour: Number(m.hour),
    minute: Number(m.minute),
    weekday: m.weekday,
  };
}

// All time/day formatters render in New York time so labels are consistent for
// every viewer. They now receive absolute instants everywhere (the scheduler was
// updated to build NY-anchored instants), so forcing the zone here is safe.
// Format a Date as a 30-min slot label, e.g. "10:00", "10:30", "00:00"
export function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { timeZone: NY_TZ, hour: "2-digit", minute: "2-digit", hour12: false });
}
export function fmtTime12(d: Date): string {
  return d.toLocaleTimeString("en-US", { timeZone: NY_TZ, hour: "numeric", minute: "2-digit", hour12: true });
}
// Compact on-the-hour label for the scheduler rail, e.g. "9 AM", "12 PM", "11 PM"
export function fmtHour12(d: Date): string {
  return d.toLocaleTimeString("en-US", { timeZone: NY_TZ, hour: "numeric", hour12: true });
}
export function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-US", { timeZone: NY_TZ, weekday: "short", month: "short", day: "numeric" });
}
export function fmtDayLong(d: Date): string {
  return d.toLocaleDateString("en-US", { timeZone: NY_TZ, weekday: "long", month: "long", day: "numeric", year: "numeric" });
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
  const SLOT_MS = SLOT_MINUTES * 60 * 1000;
  for (const b of bookings) {
    if (b.spaceId !== spaceId) continue;
    const startMs = new Date(b.start).getTime();
    const endMs = new Date(b.end).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
      continue;
    // Mark every 30-min slot the booking OVERLAPS, not just exact-boundary
    // matches. Google Calendar events (manual blocks, synced Peerspace/Giggster
    // events, all-day blocks) can start/end at off-grid times like 9:15; flooring
    // the start to the slot grid ensures those still block the slots they cover.
    // Epoch 0 sits on a 30-min boundary, so flooring the ms epoch yields keys
    // that align with the scheduler's :00/:30 slot cells.
    let cursorMs = Math.floor(startMs / SLOT_MS) * SLOT_MS;
    while (cursorMs < endMs) {
      map.set(new Date(cursorMs).toISOString(), b);
      cursorMs += SLOT_MS;
    }
  }
  return map;
}

// ----- Night-hours notice -----
// "Night hours" for the guest-facing heads-up: any time at/after 8 PM or before
// 6 AM, New York time. Single source of truth for the definition — change these
// to shift what counts as a night booking.
export const NIGHT_START_HOUR = 20; // 8 PM ET
export const NIGHT_END_HOUR = 6; // 6 AM ET

// True when any 30-minute slot of [start, end) falls within night hours (NY
// time). Drives the non-blocking "runs into night hours" notice in the summary.
export function bookingIncludesNightHours(start: Date, end: Date): boolean {
  const stepMs = SLOT_MINUTES * 60 * 1000;
  for (let t = start.getTime(); t < end.getTime(); t += stepMs) {
    const h = nyParts(new Date(t)).hour;
    if (h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR) return true;
  }
  return false;
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
