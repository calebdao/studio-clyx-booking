import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import {
  createHoldSchema,
  createAddOnSchema,
  updateAddOnSchema,
  type BookingDto,
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
      const booking = await storage.createHold(input);

      // Push a tentative hold event to Google Calendar (if configured) so the
      // slot is blocked across all channels while we wait for payment.
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

  app.post("/api/bookings/:id/confirm", requireAdmin, async (req, res, next) => {
    try {
      const booking = await storage.confirmBooking(String(req.params.id));
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
          // Persist the (possibly new) event id so subsequent operations target the right event.
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

  // ----- Integration status (admin callout) -----
  app.get("/api/integrations/status", (_req, res) => {
    res.json(integrationsStatus());
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
            createdAt: Date.now(),
            source: "google",
          });
        }
      })
  );
  return merged;
}
