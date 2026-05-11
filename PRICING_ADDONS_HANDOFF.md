# Studio Clyx — Pricing & Add-ons Update — Handoff

**Status:** Complete. `npx tsc --noEmit` ✅ zero errors. `npm run build` ✅ succeeds. Simulation-mode smoke test ✅ passed.

This document describes every change in the "Booking pricing and add-ons update" task so a future agent (or the owner) can review, deploy, and extend it confidently.

---

## 1. What changed (at a glance)

1. **Guest tiered pricing**: 1–15 guests +$0/hr · 16–25 +$10/hr · 26–40 +$20/hr. Min 1, max 40 (server + client enforced).
2. **Event cleaning fee**: $75 auto-added when activity = `event`.
3. **Alcohol fee**: $50 when the "Will alcohol be consumed?" checkbox is on.
4. **Add-on catalog**: seeded with the six Peerspace items and editable in admin.
5. **Holds**: 60 minutes. New pending bookings push a *tentative* HOLD event to Google Calendar; the event is re-used (PATCH'd) when the booking is confirmed and deleted on reject/release. After 60 min, the hold goes inactive in our DB (it stops blocking new bookings) but the booking row stays `pending` for admin follow-up.
6. **Owner reminder**: once-per-booking email to `OWNER_REMINDER_EMAIL` (default `info@calebgladys.com`) when a hold passes 60 minutes.
7. **Payment-window copy**: every customer/email message says "approximately 10–30 minutes" (replacing the older phrasing).
8. **Reject endpoint**: admin can reject a hold; Calendar event is removed and `holdActive` flipped false.

---

## 2. Files modified

### Shared schema
- `shared/schema.ts`
  - `bookings` table: added `guestCount`, `alcohol`, `addons` (JSON text), `holdActive`, `reminderSentAt`, `googleEventId`, `googleCalendarId`.
  - New `addonCatalog` table (`id, name, description, price, price_type, image_url, active, sort_order`).
  - Pricing constants: `GUEST_MIN=1`, `GUEST_MAX=40`, `GUEST_TIER_15_RATE=0`, `GUEST_TIER_25_RATE=10`, `GUEST_TIER_40_RATE=20`, `EVENT_CLEANING_FEE=75`, `ALCOHOL_FEE=50`.
  - Status enum widened: `held | pending | confirmed | rejected`. (`held` retained for backwards compatibility; new bookings use `pending`.)
  - `createHoldSchema` accepts `guestCount`, `alcohol`, `addons[{addOnId, quantity}]`.

### Server
- `server/storage.ts`
  - Idempotent migration (`PRAGMA table_info` + `ALTER TABLE ADD COLUMN`) runs on startup. Preserves existing rows in Render's `data.db`.
  - `createHold` sets `status: "pending"` and `holdActive: true`.
  - `expireHolds(now)` flips `holdActive=false` (no delete) and returns `{ expired: BookingDto[] }` so the sweeper can act on each newly-expired hold.
  - `rejectBooking`, `setGoogleEvent`, `listOverdueReminderTargets`, `markReminderSent`.
  - Add-on CRUD: `listAddOns`, `getAddOn`, `createAddOn`, `updateAddOn`, `setAddOnActive`, `deleteAddOn`.
  - `seedAddOnCatalogIfEmpty()` inserts the six Peerspace items as `ao-seed-0..5` (idempotent).
  - Hold and reminder thresholds exported as `HOLD_DURATION_MINUTES = 60` and `OWNER_REMINDER_MINUTES = 60`.

- `server/google-calendar.ts`
  - `eventBodyForBooking(b, "hold" | "confirmed")` — hold events use `status: "tentative"` and `"[HOLD] …"` summary prefix.
  - `insertHoldEventForBooking`, `updateEventForBooking` (PATCH, used to upgrade the hold event to confirmed), `deleteEvent` (used on reject/release).

- `server/integrations.ts`
  - `pushHoldToCalendar`, `pushBookingToCalendar` (PATCH-first then insert), `removeCalendarEvent`.
  - `computeBookingPricing(b)` is the server-side source of truth — emails and admin-side math both consume it.
  - Owner alert + customer confirmation emails now show: hourly base, guest surcharge, cleaning fee, alcohol fee, every add-on line with quantity & subtotal, grand total.
  - `sendOwnerReminderEmail` — once-per-booking, dispatched by the sweeper.
  - `OWNER_REMINDER_EMAIL` env (default `info@calebgladys.com`).
  - `PAYMENT_WINDOW_LABEL = "10–30 minutes"` is the single source for the wording.
  - `SweeperHooks` interface; `startHoldExpirySweeper({ expireHolds, listOverdueReminderTargets, markReminderSent, onHoldExpired })` runs every 60 s and:
    1. expires holds → calls `onHoldExpired(booking)` (which removes the Calendar event);
    2. finds overdue holds that haven't been reminded → emails owner → marks `reminderSentAt`.

- `server/routes.ts`
  - `POST /api/bookings` creates pending booking, pushes hold to GCal, sends owner alert.
  - `POST /api/bookings/:id/confirm` patches the hold event to confirmed (or inserts a fresh one if it was gone).
  - `POST /api/bookings/:id/reject` (PIN-gated) — flips status, removes Calendar event.
  - `POST /api/bookings/:id/release` (PIN-gated) — also removes Calendar event.
  - `GET /api/addons` — public, **active items only**.
  - `GET/POST/PATCH/DELETE /api/admin/addons` — PIN-gated. DELETE is soft (sets `active=false`) so historical bookings preserve item names.
  - `mergeGoogleCalendarBusy` skips known internal event IDs so a hold event we created doesn't double-count as a busy slot.
  - Sweeper is wired in `registerRoutes` with `onHoldExpired = removeCalendarEvent`.

### Client
- `client/src/lib/booking-data.ts`
  - `AddOnCatalogItem`, `SelectedAddOn`, `PriceBreakdown`, `PriceInput` types.
  - `HOLD_DURATION_MINUTES = 60`.
  - `computePriceBreakdown(input)` → returns `{ lines: [{label, amount}], total }`. Single source of truth for client-side summaries.
  - Helpers: `guestSurchargeRate`, `guestTierLabel`, `computeAddOnLineTotal`, `selectedFromCatalog`.

- `client/src/lib/booking-store.tsx`
  - `rejectBookingAsync` mutation.
  - `CreateHoldClientInput` type.
  - Public + admin add-on hooks: `usePublicAddOns`, `useAdminAddOns`, `useAddOnMutations` (create/update/remove/setActive).
  - Query keys: `["/api/addons"]`, `["/api/admin/addons"]`, `["/api/bookings"]`. All mutations invalidate the right keys.

- `client/src/pages/book.tsx`
  - Guest count stepper (1–40, enforced).
  - "Will alcohol be consumed?" checkbox.
  - Add-ons catalog section: per-item items show a qty stepper, flat-rate items show a single checkbox; only active items appear.
  - Summary card and confirmation dialog both render the full breakdown via `computePriceBreakdown`.
  - Copy updated to "1-hour hold" and "approximately 10–30 minutes".

- `client/src/pages/admin.tsx`
  - **Reject** button + confirm dialog on every pending row.
  - New **Add-ons** tab with `AddOnsManager` listing every catalog item and `AddOnEditor` for create/edit (name, price, type, image URL, description, active).
  - Booking detail rows show guest-count, alcohol, add-on lines, and a hold-expired badge.
  - Confirm dialog uses `computePriceBreakdown` so admin sees the same total the customer saw.

### Documentation & config
- `.env.example` — adds `OWNER_REMINDER_EMAIL=info@calebgladys.com` after `OWNER_ALERT_EMAILS`.
- `ENV_SETUP.md` — adds the owner-reminder section and a new "Holds, pricing, and the add-on catalog" section covering the hold lifecycle, admin actions, the pricing model, the seeded catalog, and the SQLite migration behaviour.

---

## 3. Env vars (full current list)

| Variable | Required | Purpose |
| --- | --- | --- |
| `ADMIN_PIN` | recommended | Admin gate. Falls back to `0000` if unset. |
| `RESEND_API_KEY` | for live email | Resend API key. Without it, emails run in simulation mode (logged to stdout). |
| `RESEND_FROM_ADDRESS` | for live email | Verified Resend sender. |
| `OWNER_ALERT_EMAILS` | for live email | Comma-separated owner recipients for new-booking alerts. |
| `OWNER_REMINDER_EMAIL` | optional | Where the 60-minute hold reminder goes. Default `info@calebgladys.com`. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | for live calendar | Service-account JSON used for Calendar API. |
| `GOOGLE_CALENDAR_ID_STUDIO_1` | for live calendar | `info@calebgladys.com` |
| `GOOGLE_CALENDAR_ID_STUDIO_2` | for live calendar | `c_a5772f8a4a7b236c16fcad361fb47b876a73968e392a404579f34a6ca1377ccf@group.calendar.google.com` |
| `GOOGLE_CALENDAR_ID_STUDIO_3` | for live calendar | `c_69f2a0aaf2a68a43b034b44d2b69cec143ebacfd5629a536a4021fbc0506f7fd@group.calendar.google.com` |
| `GOOGLE_CALENDAR_ID_LINCOLN_APARTMENT` | for live calendar | `c_7d7a0b0429abd791bf2a787b3ebbbc60c6cae1ff4c12e7216db2335923249226@group.calendar.google.com` |

No secrets are hard-coded.

---

## 4. Migration behaviour on first deploy

On startup `server/storage.ts` runs an idempotent migration:

1. Reads `PRAGMA table_info(bookings)`.
2. Adds any missing columns (`guest_count`, `alcohol`, `addons`, `hold_active`, `reminder_sent_at`, `google_event_id`, `google_calendar_id`) with safe defaults.
3. Creates `addon_catalog` if it does not exist.
4. Calls `seedAddOnCatalogIfEmpty()` — only inserts the six Peerspace items when the table is empty, so it is safe to re-run.

Existing rows on Render's `data.db` are preserved. New rows get sensible defaults (`hold_active=1` for pending, `guest_count=1`, `alcohol=0`, `addons='[]'`).

---

## 5. Pricing model (worked example)

For studio-1, event, 3 hours, 22 guests, alcohol, 2× foldable chairs ($45/ea) + 1× stools ($20 flat):

| Line | Amount |
| --- | --- |
| Event rate (studio-1) — 3 hr × $80 | $240 |
| Guest surcharge (16–25 tier) — 3 hr × $10 | $30 |
| Event cleaning fee | $75 |
| Alcohol fee | $50 |
| 10 Foldable Chairs × 2 | $90 |
| Stools | $20 |
| **Total** | **$505** |

The same numbers come out of `computePriceBreakdown` on the client and `computeBookingPricing` on the server.

---

## 6. Hold lifecycle

1. Customer submits booking → `POST /api/bookings`.
2. Server stores row as `status: "pending"`, `holdActive: true`, `holdExpiresAt: now + 60min`.
3. Server inserts a tentative `[HOLD]` event into the right Google Calendar (live mode) or logs it (simulation).
4. Server emails owner ("payment confirmation typically takes approximately 10–30 minutes").
5. **Admin confirms** → PATCH the same event to `confirmed` (or insert if it was deleted) → send customer confirmation. **Admin rejects or releases** → delete the event, flip `holdActive=false`.
6. **60 minutes pass without confirm**:
   - sweeper sets `holdActive=false` (booking stays `pending`),
   - removes the Calendar event (`onHoldExpired` hook),
   - sends a one-time reminder to `OWNER_REMINDER_EMAIL`,
   - marks `reminderSentAt` so it never fires again for that booking.
7. Inactive holds no longer block new booking attempts; only `holdActive=true` and `confirmed` rows count toward conflicts.

---

## 7. Verification performed

- `npx tsc --noEmit` → 0 errors.
- `npm run build` → client `405.68 kB` JS + `76.47 kB` CSS, server `dist/index.cjs` (971 kB). Built in ~7 s.
- Simulation smoke test (port 5100, fresh DB):
  - `GET /api/integrations/status` reported `mode: "simulation"` for Google/Resend/admin and `ownerReminderRecipient: "info@calebgladys.com"`.
  - `GET /api/addons` returned all 6 seeded Peerspace items.
  - `POST /api/bookings` (event, studio-1, 22 guests, alcohol, 2 chairs + stools) → `201` with `status: "pending"`, `holdActive: true`, `holdExpiresAt = createdAt + 60min`, and enriched `addons[]` lines (`lineTotal: 90` and `lineTotal: 20`).
  - Server logged simulated `HOLD event` push + simulated owner alert.
  - `POST /api/bookings/:id/reject` (PIN `0000`) → `200` with `status: "rejected"`, `holdActive: false`.
  - `GET /api/admin/addons` → `401` without PIN, `200` with PIN.
  - `POST /api/admin/addons` created a new custom addon (`ao-…`) with all fields.

No errors in the server log other than the deliberate 400/401 validation/auth tests.

---

## 8. Notes for the next agent / operator

- **Visual design preserved** — colors, spacing, type, shadcn tokens unchanged. The new sections in `book.tsx` and `admin.tsx` use the existing component library.
- **Addon prices are server-authoritative** — the client only ever sends `{addOnId, quantity}`. Don't change the API to accept client-supplied prices.
- **Soft-delete addons** — `DELETE /api/admin/addons/:id` just flips `active=false` so historical bookings keep their item names. Use a manual SQL `DELETE` only if you really mean it.
- **Hold + Calendar event lifecycle is single-event** — the same Google Calendar event row is created on hold, patched on confirm, and deleted on reject/release/expiry. Don't insert a second event on confirm.
- **Reminder is once-per-booking** — `reminder_sent_at` tracks it. Clearing that column (e.g. via DB tool) would re-arm the reminder.
- **`HOLD_DURATION_MINUTES`, `OWNER_REMINDER_MINUTES`** live in `server/storage.ts`. Sweeper poll is in `server/integrations.ts` (every 60 s).
- **`status: "held"`** is retained in the enum for backwards compatibility but no new row uses it; admin code reads `pending`+`holdActive` instead.

---

## 9. File index (every file touched in this task)

- `shared/schema.ts`
- `server/storage.ts`
- `server/google-calendar.ts`
- `server/integrations.ts`
- `server/routes.ts`
- `client/src/lib/booking-data.ts`
- `client/src/lib/booking-store.tsx`
- `client/src/pages/book.tsx`
- `client/src/pages/admin.tsx`
- `.env.example`
- `ENV_SETUP.md`
- `PRICING_ADDONS_HANDOFF.md` (this file)
