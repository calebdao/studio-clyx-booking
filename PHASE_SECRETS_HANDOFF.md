# Phase: Production Secrets & Google Calendar — Handoff

## What changed

### New files

- **`.env.example`** — every required env var with safe placeholders. `ADMIN_PIN=2457`, `RESEND_FROM_ADDRESS='Studio Clyx <info@studioclyx.com>'`, all four space calendar IDs, plus placeholder `RESEND_API_KEY=re_REPLACE_ME` and a placeholder service-account `GOOGLE_SERVICE_ACCOUNT_JSON`.
- **`server/google-calendar.ts`** — zero-dependency Calendar v3 client. Uses Node's built-in `crypto` to sign an RS256 JWT, exchanges it at `oauth2.googleapis.com/token` for an access token (cached in-memory until ~5 min before expiry), then talks directly to `calendar/v3` over `fetch`. Exports `parseServiceAccount`, `getServiceAccountError`, `getAccessToken`, `isCalendarLiveForSpace`, `calendarIdForSpace`, `listEventsForSpace`, `insertEventForBooking`, and the shared `SPACE_CALENDAR_ENV` map.
- **`PHASE_SECRETS_HANDOFF.md`** — this file.

### Modified

- **`ENV_SETUP.md`** — fully rewritten Google Calendar section: per-space activation, conflict checks against external events, listing merge, soft-fail behavior, status-shape reference, "going live" walkthrough.
- **`server/integrations.ts`** — `googleCalendarStatus()` now reports per-space `live`, `liveSpaces`, `totalSpaces`, and a `credentialError` string when the service-account JSON fails to parse. `pushBookingToCalendar()` delegates to the new client, returning `{ ok, mode, eventId?, htmlLink? }` or `{ ok: false, mode: "live", error }`.
- **`server/storage.ts`** — `createHold` now also checks Google Calendar (only for spaces with the integration live). External events that overlap throw a 409 with `source: "google-calendar"`. Google outages log a warning and let the booking through (soft-fail).
- **`server/routes.ts`** —
  - `POST /api/bookings/:id/confirm` awaits the calendar push and returns its result on the response under `calendar` (alongside the existing `email` field). Failures don't reverse the confirmation.
  - `GET /api/bookings` merges live Google Calendar events from each configured space into the response with `source: "google"`, so the client scheduler renders them as occupied slots.
- **`client/src/pages/admin.tsx`** — `IntegrationStatus` type now includes `liveSpaces`, `totalSpaces`, `credentialError`, and a per-space `live` flag. The Integrations callout's Google Calendar row now describes live/simulation per space, names the missing env vars, and surfaces JSON-parse errors verbatim.

## Tests run

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean (0 errors) |
| `npm run build` (Vite + esbuild) | clean — `dist/index.cjs` 947 KB, `dist/public/assets/index-*.js` 357 KB |
| Cold start in simulation mode | 17 seed bookings returned, sources `{internal, peerspace, giggster}` (no `google` since no creds) |
| `POST /api/bookings` (held) → `POST /api/bookings/:id/confirm` with PIN `0000` | returned `email.mode: "simulation"` and `calendar.mode: "simulation"`; booking marked `confirmed` |
| Start with `GOOGLE_SERVICE_ACCOUNT_JSON='not-json'` | `/api/integrations/status` reports `google.credentialConfigured: false`, `credentialError: "Unexpected token 'o'..."`, `liveSpaces: 0/4`, mode stays `simulation` |

## Behavior matrix

| Scenario | What happens |
| --- | --- |
| No Google envs | All four spaces simulation. `pushBookingToCalendar` logs and returns `{ ok: true, mode: "simulation" }`. No conflict check against Google. Listing returns only DB rows. |
| Service account set, ID set for **some** spaces | Live for those spaces, simulation for the rest. Status callout names which is which. |
| All four IDs + valid SA | `mode: "live"`, `liveSpaces: 4/4`. Confirmed bookings insert events; conflict checks honor existing calendar events; listings merge external events. |
| Bad JSON in `GOOGLE_SERVICE_ACCOUNT_JSON` | Stays in simulation; `credentialError` shown verbatim in the admin callout. |
| Google API error during conflict check | Logged; booking allowed through (soft-fail). |
| Google API error during event insert | Booking still confirmed; admin response shows `calendar.ok: false, mode: "live", error: "..."`. |

## Exact next manual steps for the user

1. **Create a Google Cloud service account** (Console → IAM & Admin → Service Accounts → Create). Skip role grants. Open the account → Keys → Add key → Create new key → JSON. Download.
2. **Enable the Calendar API** on the project (APIs & Services → Library → Google Calendar API → Enable).
3. **Share each of the four calendars with the service account's `client_email`:**
   - **Studio 1** is the primary calendar of `info@calebgladys.com` — log into that account, open Google Calendar → Settings → "Settings and sharing" for the primary calendar → "Share with specific people" → add the service account email → permission "Make changes to events".
   - For Studio 2, Studio 3, and Lincoln Apartment — open each calendar (the IDs starting with `c_…@group.calendar.google.com`) → "Settings and sharing" → same flow.
4. **On the host (Vercel/Render/Fly/etc.), set these env vars exactly:**
   - `ADMIN_PIN=2457`
   - `RESEND_API_KEY=` *(paste the real `re_…` key from https://resend.com/api-keys — never commit)*
   - `RESEND_FROM_ADDRESS='Studio Clyx <info@studioclyx.com>'`
   - `GOOGLE_SERVICE_ACCOUNT_JSON=` *(paste the full JSON from the downloaded key file, single-line; multi-line is fine if your host supports it — newlines inside `private_key` may also be `\n` escapes, the server normalizes)*
   - `GOOGLE_CALENDAR_ID_STUDIO_1=info@calebgladys.com`
   - `GOOGLE_CALENDAR_ID_STUDIO_2=c_a5772f8a4a7b236c16fcad361fb47b876a73968e392a404579f34a6ca1377ccf@group.calendar.google.com`
   - `GOOGLE_CALENDAR_ID_STUDIO_3=c_69f2a0aaf2a68a43b034b44d2b69cec143ebacfd5629a536a4021fbc0506f7fd@group.calendar.google.com`
   - `GOOGLE_CALENDAR_ID_LINCOLN_APARTMENT=c_7d7a0b0429abd791bf2a787b3ebbbc60c6cae1ff4c12e7216db2335923249226@group.calendar.google.com`
5. **Verify the `studioclyx.com` domain in the Resend dashboard** before going live — Resend rejects unverified senders with 403.
6. **Restart the server.** Hit `/api/integrations/status` (or open the admin console). All three services should show `mode: "live"`. The Google row should say "Live — events post to all 4 space calendars."
7. **Smoke-test live mode:** create a hold, confirm with the real PIN, check that (a) the guest receives a Resend email and (b) an event appears on the corresponding Google Calendar with summary `"<Space> — <Activity> (<Guest>)"`.

## Things parent agent should know before deploying

- No new npm dependencies were added — the Google Calendar client is built on `node:crypto` and global `fetch`, both present in the existing Node 20 runtime. `npm ci` is unchanged.
- Booking writes happen synchronously via `better-sqlite3` (no change). Calendar push is awaited inside the confirm route but soft-fails — confirmation never depends on Google succeeding.
- The `/api/bookings` listing now does network I/O per request when Google is configured (one request per live space, parallelized). It's wrapped in `Promise.all` and individual failures degrade to "no Google rows for that space." Consider a short in-memory cache (e.g. 30s) if request volume becomes an issue; not needed for the current traffic.
- Hardcoded calendar IDs are **only** in `.env.example` and `ENV_SETUP.md` for documentation. The runtime reads them strictly from `process.env`.
