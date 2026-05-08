import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import { createHoldSchema, type BookingDto } from "@shared/schema";
import {
  integrationsStatus,
  pushBookingToCalendar,
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
  startHoldExpirySweeper((now) => storage.expireHolds(now));

  // ----- Bookings -----
  app.get("/api/bookings", async (_req, res, next) => {
    try {
      // opportunistic sweep so listings reflect current reality
      await storage.expireHolds(Date.now());
      const bookings = await storage.listBookings();
      // Merge in Google Calendar events for each space that has the integration
      // configured. These show up as `source: "google"` so the client can
      // render them as occupied slots and avoid double-booking against
      // Peerspace/Giggster syncs.
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
      // sweep before checking conflicts
      await storage.expireHolds(Date.now());
      const booking = await storage.createHold(input);
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

  // Admin actions are gated by a simple PIN header. The PIN is read from env
  // (ADMIN_PIN) and falls back to "0000" in simulation mode so the prototype
  // still works without secrets. The PIN is never stored client-side beyond
  // React state — the client supplies it on each admin request.
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
      // Calendar push: await so the admin UI knows whether the event landed
      // (live), was simulated (no creds), or failed (live error). We do NOT
      // throw if it fails — the booking is already confirmed.
      let calendar: Awaited<ReturnType<typeof pushBookingToCalendar>>;
      try {
        calendar = await pushBookingToCalendar(booking);
      } catch (e) {
        console.error("calendar push error", e);
        calendar = {
          ok: false,
          mode: "live" as const,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      // Email: await the result so the admin UI can reflect real sent vs simulated.
      // We still don't fail the confirmation if the email send fails — the booking
      // is already locked in. We just report the outcome on the response.
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

  app.post("/api/bookings/:id/release", requireAdmin, async (req, res, next) => {
    try {
      const ok = await storage.releaseBooking(String(req.params.id));
      if (!ok) throw httpError(404, "Booking not found.");
      res.json({ ok: true });
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
// blocks those slots. Skips spaces that aren't live; degrades silently on
// error to avoid breaking the listing.
async function mergeGoogleCalendarBusy(
  internal: BookingDto[]
): Promise<BookingDto[]> {
  const spaceIds = Object.keys(SPACE_CALENDAR_ENV) as BookingDto["spaceId"][];
  const now = new Date();
  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1 day back
  const windowEnd = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000); // 60 days ahead

  // Collect existing booking IDs that are linked to google events to avoid
  // double-counting (we tagged inserted events with studioClyxBookingId, but
  // we don't strictly need to dedupe since the synthetic booking ID is the
  // google event ID, not the internal booking ID).
  const merged: BookingDto[] = [...internal];
  await Promise.all(
    spaceIds
      .filter(isCalendarLiveForSpace)
      .map(async (spaceId) => {
        const result = await listEventsForSpace(
          spaceId,
          windowStart,
          windowEnd
        );
        if (!result.ok) return;
        for (const ev of result.events) {
          merged.push({
            id: `gcal-${ev.id}`,
            spaceId,
            activityId: "production", // unknown — pick a reasonable default
            start: ev.start,
            end: ev.end,
            status: "confirmed",
            guest: {
              firstName: ev.summary?.slice(0, 60) || "External",
              lastName: "booking",
              email: "calendar@google",
            },
            createdAt: Date.now(),
            source: "google",
          });
        }
      })
  );
  return merged;
}
