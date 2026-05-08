# Studio Clyx — Phase 2 Backend Foundation Handoff

## What changed

The booking app now has a real persistence layer. All booking state lives in
SQLite (`data.db`) on the server and is exposed through `/api/*` endpoints. The
React app reads/writes through TanStack Query + `apiRequest`. Bookings survive
both browser refreshes and server restarts. Visual design and UI polish are
preserved.

---

## Modified / new files

### Server

- `shared/schema.ts` — added `bookings` table, `BookingDto` zod schema, and
  `createHoldSchema` for the public POST endpoint.
- `server/storage.ts` — full rewrite. Owns the `bookings` CRUD, conflict
  detection, hold expiry sweep, and seed-on-empty bootstrap (mirrors the
  original Phase 1 demo data, including Peerspace/Giggster mock sources).
  Tables are created idempotently on boot so no `drizzle-kit push` is needed.
- `server/routes.ts` — implements:
  - `GET  /api/bookings` — all bookings (sweeps expired holds first).
  - `POST /api/bookings` — create a 30-minute hold. Enforces every booking
    rule on the server: 30-min increments, 2-hour minimum, 7-hour lead time,
    12-month window, and per-space conflict detection.
  - `POST /api/admin/verify` — checks PIN against `ADMIN_PIN` env (default
    `0000`).
  - `POST /api/bookings/:id/confirm` — admin-gated. Marks confirmed, fires
    `pushBookingToCalendar` and `sendConfirmationEmail` (both simulated).
  - `POST /api/bookings/:id/release` — admin-gated. Deletes the hold/pending.
  - `GET  /api/integrations/status` — used by the admin callout.
- `server/integrations.ts` — **new**. Stubbed but production-shaped services
  for Google Calendar (one calendar per space ID via four env vars), Resend
  email, the admin-PIN gate, and the hold-expiry sweeper. Each service reports
  `mode: "live" | "simulation"` based on env-var presence and short-circuits
  to a structured log line when unconfigured. No live network calls.

### Client

- `client/src/App.tsx` — wraps the app in `<AdminProvider>` so the admin PIN
  context is available to the booking-store mutations.
- `client/src/lib/queryClient.ts` — `apiRequest` now accepts an optional
  `headers` map so admin mutations can pass `x-admin-pin` without raw
  `fetch()`.
- `client/src/lib/booking-store.tsx` — full rewrite:
  - `useBookings()` is now backed by `useQuery({ queryKey: ['/api/bookings'] })`
    with 30-second polling.
  - Mutations (`createHoldAsync`, `confirmPaymentAsync`, `releaseHoldAsync`)
    use `apiRequest` and invalidate the bookings cache on success.
  - New `AdminProvider` / `useAdmin()` hold the PIN in **React state only** —
    no localStorage, sessionStorage, or cookies. Refresh re-locks the console.
- `client/src/pages/book.tsx` — booking submit calls `createHoldAsync`, shows
  a toast when the server rejects the slot (e.g. 409 conflict, lead-time
  violation), and disables the button while the request is in flight.
- `client/src/pages/admin.tsx` — adds:
  - `<AdminGate>` that renders a PIN form when locked.
  - `<IntegrationsCallout>` that reads `/api/integrations/status` and shows a
    simulation/live badge per integration (Google Calendar, Resend, admin
    gate) plus the env vars each one needs.
  - "Lock" button to drop the in-memory PIN.
  - Confirm/release buttons now use the async mutations and show a spinner
    while pending.

### No changes (intentionally preserved)

- `client/src/lib/booking-data.ts` — kept as the shared client-side domain
  model. The seed-data builder is unused on the client now (the server seeds),
  but the helpers (`fmtTime12`, `bookingsToOccupiedSlots`, etc.) are still
  imported by the scheduler.
- `client/src/components/scheduler.tsx`, `client/src/components/shell.tsx`,
  `client/src/components/clyx-logo.tsx`, `client/src/index.css` — untouched.

---

## Commands

```bash
# Install (already done in this workspace)
npm install

# Type check
npx tsc --noEmit

# Production build (runs the existing tsx script/build.ts; outputs dist/)
npm run build

# Start production server on port 5000 (serves both API and the built SPA)
NODE_ENV=production node dist/index.cjs

# Dev server (Vite + Express on the same port)
npm run dev
```

### Deploy

After `npm run build`, deploy the static bundle and run the server in the
background on port 5000:

```bash
# Background server
NODE_ENV=production node dist/index.cjs   # port 5000
# Static deploy (the built SPA — API calls are proxied through __PORT_5000__)
deploy_website(project_path="<repo>/dist/public")
```

The deployed site has been published as **Studio Clyx — Phase 2** in this
session.

---

## QA results

All tests run against `NODE_ENV=production node dist/index.cjs` on port 5000.

| Check | Expected | Actual |
| --- | --- | --- |
| `GET /api/bookings` after first boot | 17 seed bookings | ✅ 17 returned |
| `POST /api/bookings` with valid 2h slot 2 days out | 201 + held booking | ✅ |
| `POST /api/bookings` with same slot again | 409 "Slot is no longer available" | ✅ |
| `POST /api/bookings` with 1.5h duration | 400 "Minimum booking length is 2 hours." | ✅ |
| `POST /api/bookings` with 1h lead time | 400 "Bookings need at least 7 hours of lead time." | ✅ |
| `POST /api/bookings/:id/confirm` without PIN | 401 | ✅ |
| `POST /api/bookings/:id/confirm` with wrong PIN | 401 | ✅ |
| `POST /api/bookings/:id/confirm` with `0000` (default) | 200 + status="confirmed" | ✅ |
| `POST /api/admin/verify` with `0000` (default) | `{ ok: true }` | ✅ |
| `POST /api/admin/verify` with `ADMIN_PIN=secret123` set, pin=`0000` | 401 | ✅ |
| `POST /api/admin/verify` with `ADMIN_PIN=secret123` set, pin=`secret123` | 200 | ✅ |
| `GET /api/integrations/status` | three services in `simulation` mode by default | ✅ |
| Persistence: kill + restart server | 18 bookings (17 seeds + 1 from QA) still present, the QA one still `confirmed` | ✅ |
| Persistence: refresh browser after confirming | confirmed booking still visible in the Confirmed tab | ✅ |
| Admin gate on `/#/admin` | PIN form blocks the dashboard | ✅ |
| Admin gate after page reload | re-locks (no localStorage/sessionStorage/cookies) | ✅ |
| Booking flow | guest fills form → picks slot → hits Book now → server returns hold → confirmation dialog with Zelle + 30-minute timer | ✅ (timer reads ~30:00, decrements on the 30s tick) |
| Mobile (375px) | book + admin views render with no overflow after `break-all` on env vars | ✅ |
| `npx tsc --noEmit` | clean | ✅ |
| `npm run build` | clean (vite ~355 kB JS gzip ~113 kB; esbuild server bundle 936 kB) | ✅ |

Mocked external sources (`peerspace`, `giggster`, `internal`, `google`) are
preserved on seed bookings and appear in the admin row metadata as
`via peerspace` / `via giggster`.

---

## Booking rules (still enforced — now both client- and server-side)

- 24/7 availability (no calendar restrictions).
- 7-hour lead time (server: 400 if violated).
- 12-month booking window (server: 400 if violated).
- 2-hour minimum duration (server: 400 if violated).
- 30-minute increments (server: 400 if violated).
- Zelle recipient: `calebdao@gmail.com`.
- 30-minute hold window (server stores `holdExpiresAt`, sweeper runs every
  60s, GET endpoint also sweeps before returning).

---

## Phase 2 credentials checklist

Set any of these env vars to flip a service from simulation to live. The admin
console's Integrations callout updates automatically.

| Service | Env vars | Notes |
| --- | --- | --- |
| Admin gate | `ADMIN_PIN` | Required in production. Default `0000` is for the prototype only. |
| Resend (confirmation email) | `RESEND_API_KEY`, `RESEND_FROM_ADDRESS` | Both must be set to flip to `mode: "live"`. `sendConfirmationEmail` posts to `https://api.resend.com/emails` via global `fetch` (no SDK dependency) with the booking ID, guest name, space, activity, start/end, duration, total, and Zelle reference. Expected from address: `Studio Clyx <info@studioclyx.com>`. The admin toast reflects sent / simulated / failed. See `ENV_SETUP.md` for the full env var list including the four Google Calendar IDs. |
| Google Calendar (4 calendars, one per space) | `GOOGLE_SERVICE_ACCOUNT_JSON` plus the four IDs: `GOOGLE_CALENDAR_ID_STUDIO_1`, `GOOGLE_CALENDAR_ID_STUDIO_2`, `GOOGLE_CALENDAR_ID_STUDIO_3`, `GOOGLE_CALENDAR_ID_LINCOLN_APARTMENT` | All five must be set before `googleCalendarStatus()` reports `mode: "live"`. The `pushBookingToCalendar` TODO is wired for `googleapis`'s `cal.events.insert`. |
| (Future) Reading Peerspace/Giggster busy time | — | Plan: read busy events from each space's Google Calendar (Peerspace/Giggster already write events to those calendars in production). The mock data already shows the shape (`source: "peerspace" | "giggster" | "google"`). |

No secrets are committed or hard-coded. `ADMIN_PIN` defaults to `0000` only
when unset; that fact is surfaced explicitly in the admin gate copy and the
Integrations callout so it is impossible to forget to set it before going
live.

---

## Known follow-ups (not blockers for this phase)

1. The hold-expiry sweeper deletes expired holds. If product wants an audit
   trail, switch from delete to a status update (`held` → `expired`) and add
   an admin filter.
2. `Booking.source` for guest-created bookings is hard-coded to `"internal"`.
   When the Google Calendar sync lands, inbound calendar events should be
   imported as `"google"`/`"peerspace"`/`"giggster"` rows.
3. The PIN gate is intentionally simple. If multi-operator login is needed
   later, swap `AdminProvider` for a server session (the template already has
   `express-session` + `passport` available).
4. `data.db` is a single file in the project root. Snapshot/back up regularly
   before shipping to production, or migrate to Postgres.
