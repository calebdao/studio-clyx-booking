import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import {
  createHoldSchema,
  createAddOnSchema,
  updateAddOnSchema,
  EVENT_CLEANING_FEE,
  ALCOHOL_FEE,
  guestSurchargeRate,
  type BookingDto,
  type SelectedAddOn,
} from "@shared/schema";
import {
  integrationsStatus,
  pushBookingToCalendar,
  pushHoldToCalendar,
  removeCalendarEvent,
  sendConfirmationEmail,
  sendOwnerBookingAlert,
  startHoldExpirySweeper,
} from "./integrations";
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
}): number {
  const baseRate = ACTIVITY_RATE_USD[args.activityId] ?? 0;
  const hours = Math.max(
    0,
    (new Date(args.end).getTime() - new Date(args.start).getTime()) / 36e5
  );
  const surchargeRate = guestSurchargeRate(args.guestCount);
  const base = baseRate * hours;
  const guestSurcharge = surchargeRate * hours;
  const cleaningFee = args.activityId === "event" ? EVENT_CLEANING_FEE : 0;
  const alcoholFee = args.alcohol ? ALCOHOL_FEE : 0;
  const addonsTotal = args.addons.reduce(
    (s, a) => s + (a.lineTotal ?? 0),
    0
  );
  return (
    Math.round(
      (base + guestSurcharge + cleaningFee + alcoholFee + addonsTotal) * 100
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

  // ----- Bookings -----
  app.get("/api/bookings", async (_req, res, next) => {
    try {
      // opportunistic sweep so listings reflect current reality
      await storage.expireHolds(Date.now());
      const bookings = await storage.listBookings();
      const merged = await mergeGoogleCalendarBusy(bookings);
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
            // Owner alert: tell the operator a card booking just landed.
            try {
              await sendOwnerBookingAlert(booking);
            } catch (e) {
              console.error(
                `[stripe] owner alert failed for ${booking.id}:`,
                e
              );
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

  // ----- Integration status (admin callout) -----
  app.get("/api/integrations/status", (_req, res) => {
    res.json({ ...integrationsStatus(), stripe: stripeStatus() });
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
  const windowEnd = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

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
