import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import {
  createHoldSchema,
  createAddOnSchema,
  updateAddOnSchema,
  agentDraftActionSchema,
  agentKnowledgeUpdateSchema,
  agentInstructionsUpdateSchema,
  EVENT_CLEANING_FEE,
  ALCOHOL_FEE,
  guestSurchargeRate,
  promoDiscountForBase,
  type BookingDto,
  type SelectedAddOn,
} from "@shared/schema";
import {
  integrationsStatus,
  pushBookingToCalendar,
  pushHoldToCalendar,
  removeCalendarEvent,
  sendConfirmationEmail,
  sendEntryInstructionsEmail,
  sendOwnerBookingAlert,
  startHoldExpirySweeper,
} from "./integrations";
import { gmailStatus } from "./gmail";
import {
  EVENT_SECURITY_NOTE,
  getInstructionTemplates,
  saveInstructionTemplates,
  selectInstruction,
  type StudioKey,
} from "./booking-instructions";
import { applyBookingBuffers, removeBookingBuffers } from "./booking-buffers";
import { startAddonReminderScheduler } from "./addon-reminders";
import {
  constructWebhookEvent,
  createDraftPaymentIntent,
  createPaymentIntentForBooking,
  decodeDraftMetadata,
  getStripePublishableKey,
  refundPaymentIntent,
  stripeStatus,
} from "./stripe";
import { sendSlotTakenRefundEmail } from "./integrations";
import {
  agentAutoSendInstructions,
  agentStatus,
  appendLearnedAnswer,
  deliverReply,
  getEffectiveKnowledge,
  getKnowledgeFileDefault,
  resetKnowledgeToFile,
  saveKnowledge,
} from "./agent";
import {
  gmailInboundStatus,
  startGmailInboundPoller,
} from "./gmail-inbound";
import {
  isCalendarLiveForSpace,
  listEventsForSpace,
  SPACE_CALENDAR_ENV,
} from "./google-calendar";
import { fromZodError } from "zod-validation-error";
import { ZodError } from "zod";

// Booking-domain rules (kept in sync with client/src/lib/booking-data.ts).
const SLOT_MINUTES = 30;
const MIN_LEAD_HOURS = 7;
const MIN_DURATION_HOURS = 2;
const BOOKING_WINDOW_MONTHS = 12;

function validateBookingRules(start: Date, end: Date) {
  // 30-minute increments
  if (start.getMinutes() % SLOT_MINUTES !== 0 || end.getMinutes() % SLOT_MINUTES !== 0) {
    throw httpError(400, "Bookings must align to 30-minute increments.");
  }
  // 2-hour minimum
  const ms = end.getTime() - start.getTime();
  if (ms < MIN_DURATION_HOURS * 60 * 60 * 1000) {
    throw httpError(400, "Minimum booking length is 2 hours.");
  }
  // 7-hour lead time
  const leadMs = MIN_LEAD_HOURS * 60 * 60 * 1000;
  if (start.getTime() - Date.now() < leadMs) {
    throw httpError(400, "Bookings need at least 7 hours of lead time.");
  }
  // 12-month window
  const windowMs = BOOKING_WINDOW_MONTHS * 31 * 24 * 60 * 60 * 1000;
  if (start.getTime() - Date.now() > windowMs) {
    throw httpError(400, "Bookings can only be made up to 12 months in advance.");
  }
}

function httpError(status: number, message: string) {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  return e;
}

// Twilio Voice webhook for the 56 Bogart St buzzer. The intercom is reprogrammed
// to dial a Twilio number; Twilio fetches this and we return TwiML that plays the
// door-open DTMF tone. Env:
//   DOOR_AUTO_OPEN_ENABLED   "true" => auto-open on any buzz; else forward to cell
//   DOOR_OPEN_DTMF           digit(s) that open the door (default "9")
//   DOOR_OPEN_PAUSE_SECONDS  pause before the tone so the line is up (default 1)
//   DOOR_FORWARD_NUMBER      your cell (E.164, e.g. +16463842698) for the fallback
//   DOOR_INTERCOM_CALLER     if set, only auto-open for calls FROM this number
//                            (last-10-digit match) — lets you forward your cell's
//                            missed calls here without other callers opening the door
// Note: hitting this URL directly does nothing — the door only opens when Twilio
// plays the tone on the live call the intercom placed.
function last10(n: string): string {
  return (n || "").replace(/\D/g, "").slice(-10);
}
// DTMF tone pairs (low Hz, high Hz) per key.
const DTMF_FREQS: Record<string, [number, number]> = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
  "0": [941, 1336], "*": [941, 1209], "#": [941, 1477],
};

// Generate a mono 8 kHz 16-bit PCM WAV of a single DTMF digit held for `seconds`.
// `<Play digits>` only emits a ~0.5s beep; an intercom latch usually needs the
// tone SUSTAINED (like holding the key), so we serve a long tone as audio.
function buildDtmfWav(digit: string, seconds: number): Buffer {
  const sampleRate = 8000;
  const n = Math.floor(sampleRate * seconds);
  const [f1, f2] = DTMF_FREQS[digit] || DTMF_FREQS["9"];
  const data = Buffer.alloc(n * 2);
  // Each tone pair peaks near full scale. Use 0.4 per component so the summed
  // signal (0.8 peak) is loud and clearly audible without clipping — a too-quiet
  // tone can be inaudible on the call and may not trip the intercom relay.
  const amp = 0.4 * 32767;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const s = amp * (Math.sin(2 * Math.PI * f1 * t) + Math.sin(2 * Math.PI * f2 * t));
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function doorOpenDigit(): string {
  return ((process.env.DOOR_OPEN_DTMF ?? "9").replace(/[^0-9*#]/g, "")[0]) || "9";
}
// Absolute base URL Twilio should fetch the tone audio from. Prefer an explicit
// env, else derive from the incoming request's host (works on Render).
function doorBaseUrl(req: { get(name: string): string | undefined }): string {
  const explicit = (process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const proto = (req.get("x-forwarded-proto") || "https").split(",")[0].trim();
  const host = req.get("x-forwarded-host") || req.get("host") || "studio-clyx-booking.onrender.com";
  return `${proto}://${host}`;
}
function doorToneSeconds(): number {
  return Math.max(0.5, Math.min(10, Number(process.env.DOOR_TONE_SECONDS ?? 3) || 3));
}

// The TwiML body that actually opens the door: pause so the line is up, then the
// open tone, then hang up. By default plays a SUSTAINED tone (the held-key fix);
// set DOOR_TONE_HOLD=false to fall back to the short `<Play digits>` beep.
function openToneTwiml(baseUrl?: string): string {
  const pause = Math.max(
    0,
    Math.min(10, Number(process.env.DOOR_OPEN_PAUSE_SECONDS ?? 1) || 1)
  );
  const hold = (process.env.DOOR_TONE_HOLD ?? "true").toLowerCase() !== "false";
  const repeat = Math.max(1, Math.min(5, Number(process.env.DOOR_TONE_REPEAT ?? 1) || 1));
  let body: string;
  if (hold && baseUrl) {
    const url = `${baseUrl}/api/voice/tone.wav`;
    body = `<Play>${url}</Play>`.repeat(repeat);
  } else {
    const dtmf = ((process.env.DOOR_OPEN_DTMF ?? "9").replace(/[^0-9wW#*]/g, "")) || "9";
    body = `<Play digits="${dtmf}"/>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="${pause}"/>${body}<Hangup/></Response>`;
}
function doorEntryTwiml(from: string, baseUrl?: string): string {
  const enabled =
    (process.env.DOOR_AUTO_OPEN_ENABLED ?? "").toLowerCase() === "true";
  const allowed = (process.env.DOOR_INTERCOM_CALLER ?? "").trim();
  const callerOk = !allowed || (last10(from) !== "" && last10(from) === last10(allowed));

  if (!enabled || !callerOk) {
    // Not a call we should auto-open. When auto-open is simply off, forward to
    // the cell so you can answer manually; otherwise (a non-intercom caller that
    // got here via forwarding) just hang up.
    const fwd = (process.env.DOOR_FORWARD_NUMBER ?? "").trim();
    const action = !enabled && fwd ? `<Dial>${fwd}</Dial>` : `<Hangup/>`;
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${action}</Response>`;
  }

  // Ring-first mode: ring your cell first; if you answer you press 9 yourself, if
  // you don't pick up Twilio auto-opens (handled by /api/voice/door/after).
  const ringFirst = (process.env.DOOR_RING_FIRST ?? "").toLowerCase() === "true";
  const cell = (process.env.DOOR_FORWARD_NUMBER ?? "").trim();
  if (ringFirst && cell) {
    const timeout = Math.max(5, Math.min(60, Number(process.env.DOOR_RING_TIMEOUT ?? 18) || 18));
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="${timeout}" answerOnBridge="true" action="/api/voice/door/after" method="POST"><Number>${cell}</Number></Dial></Response>`;
  }

  // Immediate auto-open.
  return openToneTwiml(baseUrl);
}

// Local activity rate table — kept in sync with server/integrations.ts and
// client/src/lib/booking-data.ts. Used to compute the base total for the
// no-hold card flow before the booking row exists.
const ACTIVITY_RATE_USD: Record<string, number> = {
  production: 60,
  meeting: 80,
  event: 80,
};

async function previewBookingConflict(
  spaceId: BookingDto["spaceId"],
  startIso: string,
  endIso: string
): Promise<string | null> {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  // Internal bookings
  const all = await storage.listBookings();
  const blocker = all.find((b) => {
    if (b.spaceId !== spaceId) return false;
    if (b.status === "rejected") return false;
    if ((b.status === "held" || b.status === "pending") && !b.holdActive)
      return false;
    if (b.source === "google") {
      // already-known external event; surfaced from listBookings()
    }
    const bs = new Date(b.start).getTime();
    const be = new Date(b.end).getTime();
    return bs < end && be > start;
  });
  if (blocker) {
    return "This slot is no longer available.";
  }
  // Google Calendar live check (will already be merged via listBookings, but
  // double-check defensively in case of cache).
  if (isCalendarLiveForSpace(spaceId)) {
    const gc = await listEventsForSpace(
      spaceId,
      new Date(start),
      new Date(end)
    );
    if (gc.ok) {
      const ev = gc.events.find((e) => {
        const bs = new Date(e.start).getTime();
        const be = new Date(e.end).getTime();
        return bs < end && be > start;
      });
      if (ev) {
        return "This slot is no longer available (blocked by an external calendar event).";
      }
    }
  }
  return null;
}

async function resolveAddonsForBooking(
  inputAddons: Array<{ addOnId: string; quantity: number }>
): Promise<SelectedAddOn[]> {
  if (!inputAddons || inputAddons.length === 0) return [];
  const catalog = await storage.listAddOns(false); // active only
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const out: SelectedAddOn[] = [];
  for (const a of inputAddons) {
    const item = byId.get(a.addOnId);
    if (!item) continue;
    const lineTotal =
      item.priceType === "flat"
        ? Math.round(item.price * 100) / 100
        : Math.round(item.price * a.quantity * 100) / 100;
    out.push({
      addOnId: item.id,
      name: item.name,
      price: item.price,
      priceType: item.priceType,
      quantity: a.quantity,
      lineTotal,
    });
  }
  return out;
}

function computePreviewBaseTotal(args: {
  activityId: string;
  start: string;
  end: string;
  guestCount: number;
  alcohol: boolean;
  addons: SelectedAddOn[];
  promoCode?: string | null;
}): number {
  const baseRate = ACTIVITY_RATE_USD[args.activityId] ?? 0;
  const hours = Math.max(
    0,
    (new Date(args.end).getTime() - new Date(args.start).getTime()) / 36e5
  );
  const surchargeRate = guestSurchargeRate(args.guestCount);
  const base = Math.round(baseRate * hours * 100) / 100;
  const guestSurcharge = surchargeRate * hours;
  const cleaningFee = args.activityId === "event" ? EVENT_CLEANING_FEE : 0;
  const alcoholFee = args.alcohol ? ALCOHOL_FEE : 0;
  const addonsTotal = args.addons.reduce(
    (s, a) => s + (a.lineTotal ?? 0),
    0
  );
  // Promo discounts the hourly room rate (base) only.
  const promoDiscount = promoDiscountForBase(base, args.promoCode ?? null, args.start);
  return (
    Math.round(
      (base + guestSurcharge + cleaningFee + alcoholFee + addonsTotal - promoDiscount) * 100
    ) / 100
  );
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Kick off the hold expiry sweeper so server-side state matches reality.
  // Also dispatches owner reminders for bookings unpaid after 1 hour.
  startHoldExpirySweeper({
    expireHolds: (now) => storage.expireHolds(now),
    listOverdueReminderTargets: (now) =>
      storage.listOverdueReminderTargets(now),
    markReminderSent: (id, now) => storage.markReminderSent(id, now),
    onHoldExpired: async (b) => {
      // When a hold expires, remove the tentative Google Calendar event so the
      // slot frees up for other channels (Peerspace/Giggster). The booking
      // remains in the system as a pending request.
      if (b.googleEventId && b.googleCalendarId) {
        try {
          await removeCalendarEvent(b);
          await storage.setGoogleEvent(b.id, null, null);
        } catch (e) {
          console.error("hold-expired calendar cleanup error", e);
        }
      }
    },
  });

  // Start the Peerspace email-reply agent's Gmail IMAP poller (reads inbound
  // Peerspace messages from the linked Gmail). No-op unless AGENT_ENABLED and
  // GMAIL_USER/GMAIL_APP_PASSWORD are set.
  startGmailInboundPoller();

  // Night-before equipment add-on prep reminders for Peerspace bookings.
  startAddonReminderScheduler();

  // ----- Bookings -----
  // Public availability feed. This endpoint is unauthenticated and served to
  // every visitor's browser, so it must carry NO personal data — only what the
  // scheduler needs to render a slot as free/taken. Guest name/email/phone,
  // pricing, add-ons, payment + promo details are stripped. Operators get the
  // full records from the PIN-protected /api/admin/bookings below.
  function toPublicAvailability(b: BookingDto) {
    return {
      id: b.id,
      spaceId: b.spaceId,
      activityId: b.activityId,
      start: b.start,
      end: b.end,
      status: b.status,
      holdExpiresAt: b.holdExpiresAt,
      holdActive: b.holdActive,
      source: b.source,
      // Neutral placeholders so the shape stays a valid Booking client-side
      // without leaking anyone's identity.
      guest: { firstName: "", lastName: "", email: "" },
      guestCount: 1,
      alcohol: false,
      addons: [],
      paymentMethod: "zelle" as const,
      cardFeeAmount: 0,
      createdAt: b.createdAt,
    };
  }

  async function listMergedBookings(): Promise<BookingDto[]> {
    // opportunistic sweep so listings reflect current reality
    await storage.expireHolds(Date.now());
    const bookings = await storage.listBookings();
    return mergeGoogleCalendarBusy(bookings);
  }

  app.get("/api/bookings", async (_req, res, next) => {
    try {
      const merged = await listMergedBookings();
      res.json(merged.map(toPublicAvailability));
    } catch (e) {
      next(e);
    }
  });

  // Operator-only: full booking records (guest contact details, pricing, etc.).
  // PIN-gated so guest PII is never exposed on the public feed above.
  app.get("/api/admin/bookings", requireAdmin, async (_req, res, next) => {
    try {
      const merged = await listMergedBookings();
      res.json(merged);
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/bookings", async (req, res, next) => {
    try {
      const input = createHoldSchema.parse(req.body);
      const start = new Date(input.start);
      const end = new Date(input.end);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw httpError(400, "Invalid start/end timestamps.");
      }
      validateBookingRules(start, end);
      await storage.expireHolds(Date.now());

      // Card path: do NOT create a booking row or a Google hold. Just create
      // a Stripe PaymentIntent with all the booking details in metadata. The
      // booking is materialized in the DB only when the webhook reports
      // `payment_intent.succeeded`. This eliminates the "I clicked Book now
      // then changed my mind and now my own slot is locked" UX problem.
      if (input.paymentMethod === "card") {
        // Still run a conflict check so we don't take a customer's money for
        // an obviously-unavailable slot. Races between this check and the
        // webhook are caught by `createConfirmedBookingFromDraft` (it re-runs
        // the conflict check and auto-refunds if needed).
        const conflictPreview = await previewBookingConflict(
          input.spaceId,
          input.start,
          input.end
        );
        if (conflictPreview) {
          throw httpError(409, conflictPreview);
        }

        // Resolve addons & compute the base total server-side so the customer
        // sees authoritative numbers in the Stripe Element.
        const resolvedAddons = await resolveAddonsForBooking(input.addons);
        const baseTotal = computePreviewBaseTotal({
          activityId: input.activityId,
          start: input.start,
          end: input.end,
          guestCount: input.guestCount,
          alcohol: input.alcohol,
          addons: resolvedAddons,
          promoCode: input.promoCode ?? null,
        });
        const piResult = await createDraftPaymentIntent({
          spaceId: input.spaceId,
          activityId: input.activityId,
          start: input.start,
          end: input.end,
          guest: {
            firstName: input.guest.firstName,
            lastName: input.guest.lastName,
            email: input.guest.email,
            phone: input.guest.phone,
          },
          guestCount: input.guestCount,
          alcohol: input.alcohol,
          addons: resolvedAddons,
          baseTotal,
          promoCode: input.promoCode ?? null,
        });
        if (!piResult.ok) {
          return res.status(502).json({
            ok: false,
            error: piResult.error ?? "Stripe error",
          });
        }
        // Synthetic booking-shaped object for client display only — NOT in DB.
        const preview = {
          id: piResult.paymentIntentId ?? `pi_pending_${Date.now()}`,
          spaceId: input.spaceId,
          activityId: input.activityId,
          start: input.start,
          end: input.end,
          status: "pending" as const,
          guest: {
            firstName: input.guest.firstName,
            lastName: input.guest.lastName,
            email: input.guest.email,
            phone: input.guest.phone,
          },
          guestCount: input.guestCount,
          alcohol: input.alcohol,
          addons: resolvedAddons,
          // No holdExpiresAt / holdActive — the dialog hides the timer entirely
          // for card customers so they don't see a misleading countdown.
          paymentMethod: "card" as const,
          promoCode: input.promoCode || undefined,
          cardFeeAmount: piResult.cardFeeAmount,
          createdAt: Date.now(),
          source: "internal" as const,
        };
        return res.status(201).json({
          ...preview,
          _stripe: {
            clientSecret: piResult.clientSecret,
            publishableKey: piResult.publishableKey,
            paymentIntentId: piResult.paymentIntentId,
            mode: piResult.mode,
            baseTotal: piResult.baseTotal,
            cardFeeAmount: piResult.cardFeeAmount,
            customerTotal: piResult.customerTotal,
          },
        });
      }

      // Zelle path — unchanged behavior. Create the booking, hold the slot,
      // push the Google Calendar event, fire the owner alert.
      const booking = await storage.createHold(input);

      try {
        const cal = await pushHoldToCalendar(booking);
        if (cal.ok && cal.mode === "live" && "eventId" in cal && "calendarId" in cal) {
          await storage.setGoogleEvent(
            booking.id,
            cal.eventId as string,
            cal.calendarId as string
          );
          booking.googleEventId = cal.eventId as string;
          booking.googleCalendarId = cal.calendarId as string;
        }
      } catch (calErr) {
        console.error("hold calendar push error", calErr);
      }

      try {
        await sendOwnerBookingAlert(booking);
      } catch (alertError) {
        console.error("owner booking alert error", alertError);
      }
      res.status(201).json(booking);
    } catch (e) {
      if (e instanceof ZodError) {
        return next(httpError(400, fromZodError(e).toString()));
      }
      next(e);
    }
  });

  function requireAdmin(req: Request, _res: Response, next: NextFunction) {
    const expected = process.env.ADMIN_PIN ?? "0000";
    const provided = (req.headers["x-admin-pin"] as string | undefined) ?? "";
    if (provided !== expected) {
      return next(httpError(401, "Invalid admin PIN."));
    }
    next();
  }

  app.post("/api/admin/verify", (req, res) => {
    const expected = process.env.ADMIN_PIN ?? "0000";
    const provided = (req.body?.pin ?? "").toString();
    if (provided === expected) {
      return res.json({ ok: true });
    }
    res.status(401).json({ ok: false, message: "Invalid PIN." });
  });

  // Shared confirm chain so both the admin button and Stripe webhook run
  // identical post-confirm logic (status flip → calendar patch → guest email).
  // Booking start time as minutes-since-midnight in NY local time (for choosing
  // the day vs after-hours instruction template).
  function nyStartMinutes(iso: string): number | null {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(d);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  }

  // Auto-send entry instructions for a confirmed DIRECT (studioclyx.com) booking,
  // mirroring the Peerspace flow: same DB templates, same event/after-hours
  // building-security note, same AGENT_AUTO_SEND_INSTRUCTIONS toggle. Best-effort:
  // never throws into the confirm chain.
  async function sendDirectBookingInstructions(booking: BookingDto): Promise<void> {
    if (!agentAutoSendInstructions()) return;
    const studio = booking.spaceId as StudioKey;
    const startMinutes = nyStartMinutes(booking.start);
    const tpl = selectInstruction(studio, startMinutes);
    if (!tpl.text) {
      console.warn(
        `[direct-booking] no entry instructions for ${studio} (${booking.id}): ${tpl.reason}`
      );
      return;
    }
    const isEvent =
      booking.activityId === "event" ||
      booking.guestCount >= 20 ||
      (startMinutes != null && (startMinutes < 9 * 60 || startMinutes >= 15 * 60));
    const finalText =
      isEvent && studio !== "lincoln-apartment"
        ? tpl.text + EVENT_SECURITY_NOTE
        : tpl.text;
    try {
      const r = await sendEntryInstructionsEmail({
        to: booking.guest.email,
        bookingId: booking.id,
        text: finalText,
      });
      console.log(
        r.ok
          ? `[direct-booking] sent ${studio} entry instructions for ${booking.id}${r.mode === "simulation" ? " (simulation)" : ""}`
          : `[direct-booking] entry-instructions send failed for ${booking.id}: ${"error" in r ? r.error : "unknown"}`
      );
    } catch (e) {
      console.error(`[direct-booking] entry-instructions error for ${booking.id}:`, e);
    }
  }

  async function runConfirmChain(bookingId: string) {
    const booking = await storage.confirmBooking(bookingId);
    if (!booking) throw httpError(404, "Booking not found.");
    let calendar: Awaited<ReturnType<typeof pushBookingToCalendar>>;
    try {
      calendar = await pushBookingToCalendar(booking);
      if (
        calendar.ok &&
        calendar.mode === "live" &&
        "eventId" in calendar &&
        calendar.eventId
      ) {
        const calendarId = booking.googleCalendarId ?? null;
        await storage.setGoogleEvent(
          booking.id,
          calendar.eventId as string,
          calendarId
        );
      }
    } catch (e) {
      console.error("calendar push error", e);
      calendar = {
        ok: false,
        mode: "live" as const,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    let email: Awaited<ReturnType<typeof sendConfirmationEmail>>;
    try {
      email = await sendConfirmationEmail(booking);
    } catch (e) {
      console.error("resend send error", e);
      email = {
        ok: false,
        mode: "live" as const,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    // Place 30-min buffers before/after this confirmed booking on the calendar.
    try {
      await applyBookingBuffers(
        booking.spaceId,
        new Date(booking.start).getTime(),
        new Date(booking.end).getTime()
      );
    } catch (e) {
      console.error("booking buffer placement error", e);
    }
    // Auto-send entry instructions alongside the confirmation email.
    await sendDirectBookingInstructions(booking);
    return { booking, calendar, email };
  }

  app.post("/api/bookings/:id/confirm", requireAdmin, async (req, res, next) => {
    try {
      const { booking, calendar, email } = await runConfirmChain(
        String(req.params.id)
      );
      res.json({ ...booking, email, calendar });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/bookings/:id/reject", requireAdmin, async (req, res, next) => {
    try {
      const existing = await storage.getBooking(String(req.params.id));
      if (!existing) throw httpError(404, "Booking not found.");
      const booking = await storage.rejectBooking(String(req.params.id));
      if (booking?.googleEventId && booking?.googleCalendarId) {
        try {
          await removeCalendarEvent(booking);
          await storage.setGoogleEvent(booking.id, null, null);
        } catch (e) {
          console.error("reject calendar cleanup error", e);
        }
      }
      if (booking) {
        try {
          await removeBookingBuffers(
            booking.spaceId,
            new Date(booking.start).getTime(),
            new Date(booking.end).getTime()
          );
        } catch (e) {
          console.error("reject buffer cleanup error", e);
        }
      }
      res.json({ ok: true, booking });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/bookings/:id/release", requireAdmin, async (req, res, next) => {
    try {
      const existing = await storage.getBooking(String(req.params.id));
      if (existing?.googleEventId && existing?.googleCalendarId) {
        try {
          await removeCalendarEvent(existing);
        } catch (e) {
          console.error("release calendar cleanup error", e);
        }
      }
      if (existing) {
        try {
          await removeBookingBuffers(
            existing.spaceId,
            new Date(existing.start).getTime(),
            new Date(existing.end).getTime()
          );
        } catch (e) {
          console.error("release buffer cleanup error", e);
        }
      }
      const ok = await storage.releaseBooking(String(req.params.id));
      if (!ok) throw httpError(404, "Booking not found.");
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ----- Add-on catalog -----
  app.get("/api/addons", async (_req, res, next) => {
    try {
      // Public endpoint: only active items.
      const list = await storage.listAddOns(false);
      res.json(list);
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/admin/addons", requireAdmin, async (_req, res, next) => {
    try {
      const list = await storage.listAddOns(true);
      res.json(list);
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/admin/addons", requireAdmin, async (req, res, next) => {
    try {
      const input = createAddOnSchema.parse(req.body);
      const created = await storage.createAddOn(input);
      res.status(201).json(created);
    } catch (e) {
      if (e instanceof ZodError) return next(httpError(400, fromZodError(e).toString()));
      next(e);
    }
  });

  app.patch("/api/admin/addons/:id", requireAdmin, async (req, res, next) => {
    try {
      const patch = updateAddOnSchema.parse(req.body);
      const updated = await storage.updateAddOn(String(req.params.id), patch);
      if (!updated) throw httpError(404, "Add-on not found.");
      res.json(updated);
    } catch (e) {
      if (e instanceof ZodError) return next(httpError(400, fromZodError(e).toString()));
      next(e);
    }
  });

  app.delete("/api/admin/addons/:id", requireAdmin, async (req, res, next) => {
    try {
      // Soft-deactivate by default so historical bookings preserve item names.
      const updated = await storage.setAddOnActive(String(req.params.id), false);
      if (!updated) throw httpError(404, "Add-on not found.");
      res.json({ ok: true, addOn: updated });
    } catch (e) {
      next(e);
    }
  });

  // ----- Stripe (card payments with customer-borne surcharge) -----

  // Public: returns the publishable key + fee constants so the client can
  // initialize Stripe.js and render an accurate live preview of the surcharge.
  app.get("/api/stripe/config", (_req, res) => {
    const s = stripeStatus();
    res.json({
      mode: s.mode,
      publishableKey: getStripePublishableKey(),
      feePercent: s.feePercent,
      feeFixed: s.feeFixed,
    });
  });

  // Public (rate-limited by booking id existence): creates or updates a
  // PaymentIntent for a card booking and returns the client secret so the
  // Stripe Element can mount. Zelle bookings should never hit this endpoint.
  app.post("/api/bookings/:id/stripe/intent", async (req, res, next) => {
    try {
      const booking = await storage.getBooking(String(req.params.id));
      if (!booking) throw httpError(404, "Booking not found.");
      if (booking.paymentMethod !== "card") {
        throw httpError(
          400,
          "This booking is set to Zelle. Card payments are only available when 'card' is chosen at booking time."
        );
      }
      if (booking.status === "confirmed") {
        throw httpError(409, "Booking already confirmed.");
      }
      const result = await createPaymentIntentForBooking(booking);
      if (!result.ok) {
        return res.status(502).json({
          ok: false,
          error: result.error ?? "Stripe error",
        });
      }
      if (result.paymentIntentId) {
        await storage.setStripePaymentIntent(booking.id, result.paymentIntentId);
      }
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // Stripe webhook: verifies signature using the raw body captured by
  // express.json's verify callback (server/index.ts). On payment_intent
  // success we run the same confirm chain the admin button uses, so the
  // [HOLD] Google event is patched to confirmed and the guest email is sent.
  app.post("/api/webhooks/stripe", async (req, res, next) => {
    try {
      const sig = req.headers["stripe-signature"];
      const signature = Array.isArray(sig) ? sig[0] : sig;
      const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
      const verification = constructWebhookEvent({
        rawBody,
        signature,
      });
      if (!verification.ok) {
        console.error("[stripe] webhook verification failed:", verification.error);
        return res.status(400).json({ ok: false, error: verification.error });
      }
      const event = verification.event;
      switch (event.type) {
        case "payment_intent.succeeded": {
          const pi = event.data.object as {
            id: string;
            metadata?: Record<string, string>;
            amount?: number;
          };
          const meta = pi.metadata ?? {};

          // New flow (no-hold): the PaymentIntent was created without a
          // backing booking row. Materialize the booking now if the slot is
          // still available; otherwise auto-refund and email the customer.
          if (meta.bookingDraft === "1") {
            const draft = decodeDraftMetadata(meta);
            if (!draft) {
              console.error(
                `[stripe] webhook: PI ${pi.id} has bookingDraft=1 but metadata failed to decode`
              );
              break;
            }
            // Idempotency check first — Stripe retries.
            const existing = await storage.findBookingByStripePaymentIntent(pi.id);
            if (existing) {
              console.log(
                `[stripe] webhook: booking ${existing.id} already materialized for PI ${pi.id}, skipping`
              );
              break;
            }
            const result = await storage.createConfirmedBookingFromDraft({
              spaceId: draft.spaceId,
              activityId: draft.activityId,
              start: draft.start,
              end: draft.end,
              guest: draft.guest,
              guestCount: draft.guestCount,
              alcohol: draft.alcohol,
              addons: draft.addons,
              cardFeeAmount: draft.cardFeeAmount,
              promoCode: draft.promoCode ?? null,
              stripePaymentIntentId: pi.id,
              paidAt: Date.now(),
            });
            if (!result.ok) {
              // Race: slot was taken between Book Now and payment success.
              console.warn(
                `[stripe] slot conflict during card confirm for PI ${pi.id}: ${result.reason}. Auto-refunding.`
              );
              try {
                await refundPaymentIntent(pi.id, "requested_by_customer");
              } catch (e) {
                console.error(
                  `[stripe] auto-refund failed for PI ${pi.id}:`,
                  e
                );
              }
              try {
                await sendSlotTakenRefundEmail({
                  to: draft.guest.email,
                  guestFirstName: draft.guest.firstName,
                  spaceId: draft.spaceId,
                  start: draft.start,
                  end: draft.end,
                  refundAmount: draft.customerTotal,
                  paymentIntentId: pi.id,
                });
              } catch (e) {
                console.error(
                  `[stripe] slot-taken email failed for PI ${pi.id}:`,
                  e
                );
              }
              break;
            }
            // Successful materialization. Push to Google Calendar and send
            // the customer the regular confirmation email.
            const booking = result.booking;
            try {
              const calendar = await pushBookingToCalendar(booking);
              if (
                calendar.ok &&
                calendar.mode === "live" &&
                "eventId" in calendar &&
                calendar.eventId
              ) {
                await storage.setGoogleEvent(
                  booking.id,
                  calendar.eventId as string,
                  booking.googleCalendarId ?? null
                );
              }
            } catch (e) {
              console.error(
                `[stripe] calendar push failed for ${booking.id}:`,
                e
              );
            }
            try {
              await sendConfirmationEmail(booking);
            } catch (e) {
              console.error(
                `[stripe] customer confirmation email failed for ${booking.id}:`,
                e
              );
            }
            // Auto-send entry instructions alongside the confirmation email.
            await sendDirectBookingInstructions(booking);
            // Owner alert: tell the operator a card booking just landed.
            try {
              await sendOwnerBookingAlert(booking);
            } catch (e) {
              console.error(
                `[stripe] owner alert failed for ${booking.id}:`,
                e
              );
            }
            // Place 30-min buffers before/after this confirmed card booking.
            try {
              await applyBookingBuffers(
                booking.spaceId,
                new Date(booking.start).getTime(),
                new Date(booking.end).getTime()
              );
            } catch (e) {
              console.error(`[stripe] buffer placement failed for ${booking.id}:`, e);
            }
            console.log(
              `[stripe] webhook: materialized confirmed booking ${booking.id} from PI ${pi.id}`
            );
            break;
          }

          // Legacy flow: PI was created against an existing pending booking
          // row (the old card path before we removed the hold). Kept here so
          // any bookings created by the previous deploy still get confirmed
          // when their card clears.
          const bookingId =
            meta.bookingId ??
            (await storage.findBookingByStripePaymentIntent(pi.id))?.id;
          if (!bookingId) {
            console.warn(
              `[stripe] webhook payment_intent.succeeded received but no booking id resolvable for PI ${pi.id}`
            );
            break;
          }
          const existing = await storage.getBooking(bookingId);
          if (!existing) {
            console.warn(
              `[stripe] webhook for unknown booking ${bookingId} (PI ${pi.id})`
            );
            break;
          }
          if (existing.status === "confirmed") {
            await storage.markPaid(bookingId, Date.now());
            break;
          }
          await storage.markPaid(bookingId, Date.now());
          await storage.setStripePaymentIntent(bookingId, pi.id);
          try {
            await runConfirmChain(bookingId);
          } catch (e) {
            console.error(
              `[stripe] confirm chain failed for ${bookingId} (PI ${pi.id}):`,
              e
            );
          }
          break;
        }
        case "payment_intent.payment_failed": {
          const pi = event.data.object as {
            id: string;
            last_payment_error?: { message?: string };
          };
          console.warn(
            `[stripe] payment failed for PI ${pi.id}: ${pi.last_payment_error?.message ?? "(no message)"}`
          );
          break;
        }
        default:
          // Other events are acknowledged but not acted on for now.
          break;
      }
      res.json({ received: true });
    } catch (e) {
      next(e);
    }
  });

  // ----- Peerspace email-reply agent -----
  //
  // Inbound is handled by the Gmail IMAP poller (server/gmail-inbound.ts),
  // started below in startGmailInboundPoller() — it reads Peerspace emails from
  // the linked Gmail and feeds them into storage + Claude. The admin Inbox
  // endpoints here let an operator review/approve the drafts it produces.

  // Admin Inbox: list every conversation with its full message + draft history.
  app.get(
    "/api/admin/agent/conversations",
    requireAdmin,
    async (_req, res, next) => {
      try {
        res.json(await storage.listAgentConversations());
      } catch (e) {
        next(e);
      }
    }
  );

  // Admin Inbox: act on a draft — approve (send), reject, or save an edit.
  app.post(
    "/api/admin/agent/drafts/:id/action",
    requireAdmin,
    async (req, res, next) => {
      try {
        const { action, editedBody, teach } = agentDraftActionSchema.parse(req.body);
        const draft = await storage.getAgentDraft(String(req.params.id));
        if (!draft) throw httpError(404, "Draft not found.");
        if (draft.status === "sent") {
          throw httpError(409, "This draft has already been sent.");
        }

        if (action === "edit") {
          if (!editedBody) {
            throw httpError(400, "editedBody is required to edit a draft.");
          }
          await storage.updateAgentDraft(draft.id, { editedBody });
          return res.json({ ok: true });
        }

        if (action === "reject") {
          await storage.updateAgentDraft(draft.id, {
            status: "rejected",
            reviewedAt: Date.now(),
          });
          return res.json({ ok: true });
        }

        // approve → send the reply back into the Peerspace thread.
        const convo = await storage.getAgentConversation(draft.conversationId);
        if (!convo) throw httpError(404, "Conversation not found.");
        // Persist a last-second edit passed alongside approve.
        if (editedBody && editedBody !== draft.editedBody) {
          await storage.updateAgentDraft(draft.id, { editedBody });
        }
        const finalBody =
          editedBody ?? draft.editedBody ?? draft.proposedBodyText;
        if (!finalBody) {
          throw httpError(400, "This draft has no body to send.");
        }
        const subject =
          draft.proposedSubject ??
          (convo.subject
            ? /^re:/i.test(convo.subject)
              ? convo.subject
              : `Re: ${convo.subject}`
            : "Re: Your Studio Clyx inquiry");

        const sent = await deliverReply({
          conversation: convo,
          draftId: draft.id,
          subject,
          text: finalBody,
        });
        if (!sent.ok) {
          return res.status(502).json({ ok: false, error: sent.error });
        }

        // Optionally teach the bot: append the guest's question + this answer to
        // the knowledge base so similar questions can be answered automatically.
        if (teach) {
          const lastInbound = [...convo.messages]
            .reverse()
            .find((m) => m.direction === "inbound");
          appendLearnedAnswer(lastInbound?.bodyText ?? convo.subject ?? "", finalBody);
        }

        res.json({ ok: true, simulated: sent.simulated, taught: Boolean(teach) });
      } catch (e) {
        if (e instanceof ZodError) {
          return next(httpError(400, fromZodError(e).toString()));
        }
        next(e);
      }
    }
  );

  // Admin: read the effective knowledge base (DB override or file default) for
  // the browser editor.
  app.get(
    "/api/admin/agent/knowledge",
    requireAdmin,
    (_req, res) => {
      const eff = getEffectiveKnowledge();
      res.json({
        text: eff.text ?? "",
        source: eff.source,
        fileDefaultAvailable: Boolean(getKnowledgeFileDefault()),
      });
    }
  );

  // Admin: save an edited knowledge base (persists in the DB; takes effect on the
  // next draft — no redeploy).
  app.put(
    "/api/admin/agent/knowledge",
    requireAdmin,
    (req, res, next) => {
      try {
        const { text } = agentKnowledgeUpdateSchema.parse(req.body);
        saveKnowledge(text);
        res.json({ ok: true, source: "db" });
      } catch (e) {
        if (e instanceof ZodError) {
          return next(httpError(400, fromZodError(e).toString()));
        }
        next(e);
      }
    }
  );

  // Admin: discard the DB override and revert to the committed file default.
  app.delete(
    "/api/admin/agent/knowledge",
    requireAdmin,
    (_req, res) => {
      resetKnowledgeToFile();
      res.json({ ok: true, source: getEffectiveKnowledge().source });
    }
  );

  // Admin: read/save the booking entry-instruction templates (DB-only; they
  // contain door codes and are never committed to the repo).
  app.get("/api/admin/agent/instructions", requireAdmin, (_req, res) => {
    res.json({ instructions: getInstructionTemplates() });
  });

  app.put("/api/admin/agent/instructions", requireAdmin, (req, res, next) => {
    try {
      const { instructions } = agentInstructionsUpdateSchema.parse(req.body);
      saveInstructionTemplates(instructions);
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof ZodError) {
        return next(httpError(400, fromZodError(e).toString()));
      }
      next(e);
    }
  });

  // ----- Building buzzer (Twilio Voice webhook) -----
  app.all("/api/voice/door", (req, res) => {
    const from =
      ((req.body && (req.body as Record<string, unknown>).From) ||
        (req.query && (req.query as Record<string, unknown>).From) ||
        "unknown") as string;
    const open =
      (process.env.DOOR_AUTO_OPEN_ENABLED ?? "").toLowerCase() === "true";
    console.log(
      `[door] buzzer call from ${from}; ${open ? "auto-opening (if caller allowed)" : "forwarding/hangup"}`
    );
    res.type("text/xml").send(doorEntryTwiml(String(from), doorBaseUrl(req)));
  });

  // Sustained DTMF open-tone as audio (the held-key fix). Served so Twilio can
  // <Play> a long tone instead of the short <Play digits> beep.
  app.get("/api/voice/tone.wav", (_req, res) => {
    const wav = buildDtmfWav(doorOpenDigit(), doorToneSeconds());
    res.type("audio/wav").send(wav);
  });

  // After the ring-first <Dial>: if you answered ("completed") you handled it;
  // otherwise (no-answer/busy/failed) auto-open because you missed the call.
  app.all("/api/voice/door/after", (req, res) => {
    const status = (
      (req.body && (req.body as Record<string, unknown>).DialCallStatus) ||
      (req.query && (req.query as Record<string, unknown>).DialCallStatus) ||
      ""
    )
      .toString()
      .toLowerCase();
    if (status === "completed") {
      console.log("[door] ring-first: you answered; not auto-opening");
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    } else {
      console.log(`[door] ring-first: missed (${status || "no status"}); auto-opening`);
      res.type("text/xml").send(openToneTwiml(doorBaseUrl(req)));
    }
  });

  // ----- Integration status (admin callout) -----
  app.get("/api/integrations/status", (_req, res) => {
    res.json({
      ...integrationsStatus(),
      stripe: stripeStatus(),
      agent: agentStatus(),
      gmail: gmailStatus(),
      gmailInbound: gmailInboundStatus(),
    });
  });

  return httpServer;
}

// Pull a 60-day window of busy events from each live space calendar and
// represent them as synthetic confirmed bookings so the client scheduler
// blocks those slots.
async function mergeGoogleCalendarBusy(
  internal: BookingDto[]
): Promise<BookingDto[]> {
  const spaceIds = Object.keys(SPACE_CALENDAR_ENV) as BookingDto["spaceId"][];
  const now = new Date();
  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // Must cover the whole bookable range: guests can book up to
  // BOOKING_WINDOW_MONTHS out, so Google-blocked slots that far ahead have to be
  // merged too — otherwise the scheduler shows them as free. (~31 days/mo + a few
  // days of slack.)
  const windowEnd = new Date(
    now.getTime() + (BOOKING_WINDOW_MONTHS * 31 + 7) * 24 * 60 * 60 * 1000
  );

  // Don't double-render our own hold/confirmed Google events: skip any event
  // whose id matches a known internal booking's googleEventId.
  const ownedEventIds = new Set(
    internal
      .map((b) => b.googleEventId)
      .filter((x): x is string => Boolean(x))
  );

  const merged: BookingDto[] = [...internal];
  await Promise.all(
    spaceIds
      .filter(isCalendarLiveForSpace)
      .map(async (spaceId) => {
        const result = await listEventsForSpace(spaceId, windowStart, windowEnd);
        if (!result.ok) return;
        for (const ev of result.events) {
          if (ownedEventIds.has(ev.id)) continue;
          merged.push({
            id: `gcal-${ev.id}`,
            spaceId,
            activityId: "production",
            start: ev.start,
            end: ev.end,
            status: "confirmed",
            guest: {
              firstName: ev.summary?.slice(0, 60) || "External",
              lastName: "booking",
              email: "calendar@google",
            },
            guestCount: 1,
            alcohol: false,
            addons: [],
            paymentMethod: "zelle",
            cardFeeAmount: 0,
            createdAt: Date.now(),
            source: "google",
          });
        }
      })
  );
  return merged;
}
