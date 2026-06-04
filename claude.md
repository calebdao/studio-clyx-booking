# Studio Clyx Booking App — Claude Cowork Handoff

This is the “read this first” context file for continuing development on the Studio Clyx booking app. It summarizes what has already been built, how the app is deployed, how the production integrations work, and the constraints/gotchas that matter before making changes.

## Project identity

- **Product**: Studio Clyx booking app for four bookable spaces in Brooklyn, NYC.
- **Live app**: `https://studio-clyx-booking.onrender.com`
- **Admin route**: `https://studio-clyx-booking.onrender.com/#/admin`
- **GitHub repo**: `calebdao/studio-clyx-booking` on branch `main`.
- **Hosting**: Render Web Service.
- **Squarespace usage**: the app is intended to be embedded in Squarespace via iframe.
- **Primary owner**: Caleb. Admin PIN is configured in Render via `ADMIN_PIN`.

## Tech stack

- **Frontend**: React + Vite + TypeScript + Tailwind + shadcn/ui.
- **Routing**: `wouter` with hash routing. Keep routes like `/#/admin`. Do not switch to path-based routing unless hosting is changed and tested.
- **Data fetching**: TanStack Query. Use the existing `apiRequest` helper from `client/src/lib/queryClient.ts`. Avoid raw `fetch()` on the client.
- **Backend**: Express server bundled to `dist/index.cjs`.
- **Database**: SQLite via `better-sqlite3`, using a local `data.db` file.
- **Email**: Resend via direct HTTP `fetch` in `server/integrations.ts`.
- **Calendar**: Google Calendar API via a custom service-account JWT client in `server/google-calendar.ts`. No `googleapis` dependency is currently needed.

## Commands

Run from the project root:

```bash
npm install
npx tsc --noEmit
npm run build
NODE_ENV=production node dist/index.cjs
npm run dev
```

Render configuration:

```text
Build Command: npm install && npm run build
Start Command: NODE_ENV=production node dist/index.cjs
```

## Environment variables

Do not hard-code secrets. Real values live in Render Environment Variables.

```env
ADMIN_PIN=2457
RESEND_API_KEY=<secret>
RESEND_FROM_ADDRESS=Studio Clyx <info@studioclyx.com>
OWNER_ALERT_EMAILS=calebdao@gmail.com,<gladys email>
OWNER_REMINDER_EMAIL=info@calebgladys.com

GOOGLE_SERVICE_ACCOUNT_JSON=<full service account JSON>
GOOGLE_CALENDAR_ID_STUDIO_1=info@calebgladys.com
GOOGLE_CALENDAR_ID_STUDIO_2=c_a5772f8a4a7b236c16fcad361fb47b876a73968e392a404579f34a6ca1377ccf@group.calendar.google.com
GOOGLE_CALENDAR_ID_STUDIO_3=c_69f2a0aaf2a68a43b034b44d2b69cec143ebacfd5629a536a4021fbc0506f7fd@group.calendar.google.com
GOOGLE_CALENDAR_ID_LINCOLN_APARTMENT=c_7d7a0b0429abd791bf2a787b3ebbbc60c6cae1ff4c12e7216db2335923249226@group.calendar.google.com

# Peerspace email-reply agent (see AGENT_HANDOFF.md)
AGENT_ENABLED=true
ANTHROPIC_API_KEY=<secret>
AGENT_MODEL=claude-sonnet-4-6
AGENT_INBOUND_SIGNING_SECRET=<resend inbound svix secret>
# Replies are sent from the Gmail linked to Peerspace (so Peerspace threads them):
GMAIL_USER=calebandgladys@gmail.com
GMAIL_APP_PASSWORD=<gmail app password>
```

`GET /api/integrations/status` is the quick health check. It should report live status for Resend, Google Calendar, Stripe, and the agent when Render env vars are correctly configured.

## Core booking rules

- Booking availability is 24/7 unless blocked by confirmed bookings, active holds, or Google Calendar events.
- Minimum booking length: 2 hours.
- Slot increment: 30 minutes.
- Minimum lead time: 7 hours.
- Booking window: 12 months.
- Payment method in UI/email: Zelle to `calebdao@gmail.com`.
- Payment confirmation copy: tell guests payment confirmation typically takes approximately 10–30 minutes.

## Spaces and positioning

These descriptions were refined for customer-facing copy:

- **Studio 1**: Minimal editorial studio with soft earth tones, refined finishes, and French doors to Studio 3 for expanded shoots.
- **Studio 2**: 850 sq ft luxury set with velvet textures, rich tones, mid-century pieces, drapery, and a signature wood accent wall.
- **Studio 3**: Sun-drenched lifestyle loft with marble, velvet, travertine, burl wood, and a sculptural bar for events and campaigns.
- **Lincoln Apartment**: Curated mid-century two-bedroom apartment with living room, kitchen, natural light, blush bedroom, and artful details.

## Pricing model

Base activity rates:

- Production: $60/hr
- Meeting: $80/hr
- Event: $80/hr

Guest-count surcharge:

- 1–15 guests: +$0/hr
- 16–25 guests: +$10/hr
- 26–40 guests: +$20/hr
- Enforce min 1 and max 40 on client and server.

Other fees:

- Event bookings automatically add a $75 cleaning fee.
- If “Will alcohol be consumed?” is checked, add a $50 alcohol consumption fee.
- Add-ons are added on top of hourly/fee totals.

Important: `client/src/lib/booking-data.ts` has the client-side `computePriceBreakdown`. `server/integrations.ts` has server-side pricing for emails and server-side totals. Keep pricing changes synchronized across both.

## Add-on catalog

The app has an add-on catalog seeded from the public Peerspace listing. Public scraping found names, prices, price type, and images only; descriptions/quantities were not public.

Seed items:

- 10 Foldable Chairs — $45 per item
- Cream Boucle Armchair — $150 per item
- Herman Miller Eames Molded Plywood DCM — $150 per item
- Mario Botta La Quinta Chair — $200 per item
- Stools — $20 flat fee
- Courbe Green Ceramic Table Lamp with Rattan Shade — $110 per item

Admin has an Add-ons tab to add/edit/deactivate items. Deactivation is a soft delete so historical bookings keep their item names.

## Hold lifecycle

Current intended behavior:

1. Guest submits booking.
2. Server creates a `pending` booking with `holdActive=true` and a 60-minute hold.
3. If Google is live, server creates a tentative `[HOLD]` event on the correct calendar.
4. Owner alert email is sent through Resend to `OWNER_ALERT_EMAILS`.
5. Admin can confirm or reject.
6. Confirm patches the same Google event from tentative hold to confirmed, then sends customer confirmation email.
7. Reject removes the Google hold event and sets `holdActive=false`.
8. If 60 minutes passes without confirm/reject:
   - booking remains `pending`,
   - `holdActive` becomes false,
   - Google hold event is removed,
   - one reminder is sent to `OWNER_REMINDER_EMAIL`,
   - expired inactive holds no longer block availability.

Do not revert to deleting pending rows automatically; Caleb wants pending requests to remain visible until confirmed or rejected.

## Emails

Emails currently include:

- Owner alert when a new hold is created.
- Guest confirmation after admin confirms payment.
- Owner reminder after 1 hour if still pending.

Guest confirmation email includes full pricing breakdown and cancellation policy.

Cancellation/reschedule line:

```text
To cancel or reschedule please call Gladys at +1 646 384 4403 or Caleb at +1 646 384 2698.
```

Cancellation policy:

- Cancellations 7+ days before scheduled start: full refund.
- Cancellations within 7 days: 50% of booking total is non-refundable.
- Cancellations within 24 hours or no-shows: non-refundable.
- Bookings made within 7 days follow the same timing rules; sessions booked within 24 hours are final and non-refundable.
- Late arrivals/early departures: booking time is not extended and unused time is non-refundable.
- By confirming, guest acknowledges and agrees to the policy.

This policy is also shown on the booking page and requires customer acknowledgement.

## Google Calendar behavior

There is one calendar per space. Existing Google events block availability. The app creates tentative hold events and later updates or deletes them.

Key files:

- `server/google-calendar.ts` — JWT auth, Calendar API calls, event body helpers.
- `server/integrations.ts` — higher-level push/patch/delete flow.
- `server/routes.ts` — booking create/confirm/reject endpoints.

Potential issue to watch: if Google Calendar events are manually deleted or modified outside the app, ensure the app handles missing `googleEventId` gracefully. Current flow attempts patch-first on confirm and can insert if needed.

## Data model and persistence

SQLite database file is `data.db`.

`server/storage.ts` performs idempotent startup migrations using `PRAGMA table_info` and `ALTER TABLE ADD COLUMN`. This was chosen because Render deployment was already live and we wanted simple non-destructive schema changes.

Important caveat: SQLite on Render’s filesystem is not ideal long-term. The next serious production hardening task should be migration to Postgres or another managed database with backups.

## Known deployment gotchas

- Render Free web services spin down and can take ~50–60 seconds to cold start. A paid Render instance avoids this.
- Render env var names must match exactly; for example `ADMIN_PIN`, not `admin`.
- After editing Render env vars, use Manual Deploy → Deploy latest commit. A simple restart may not pick up all intended changes.
- If uploading files through GitHub web UI, upload the extracted project contents into the repo root so `package.json` remains at the top level.
- The app was embedded in Squarespace using an iframe:

```html
<iframe
  src="https://studio-clyx-booking.onrender.com"
  style="width:100%; min-height:1300px; border:0; display:block;"
  loading="lazy"
></iframe>
```

## Important history

- Prototype fake seed bookings were removed because they blocked real availability. Do not reintroduce booking seed data in production.
- Add-on seed data is okay; it populates only the add-on catalog, not fake bookings.
- Caleb manually uploaded source packages to GitHub several times through the web UI. Before starting new work, inspect the current GitHub repo and compare it to the latest intended features in this file.
- The most recent local workspace version includes the pricing/add-ons/1-hour hold update. Confirm it was committed to GitHub before assuming live Render has it.

## Key files

- `shared/schema.ts` — database schema, Zod schemas, pricing constants.
- `shared/cancellation-policy.ts` — cancellation policy text used by UI/emails.
- `server/storage.ts` — SQLite migration, CRUD, conflict checks, add-on CRUD, hold lifecycle.
- `server/routes.ts` — Express routes.
- `server/integrations.ts` — Resend emails, pricing for emails, reminders, integration status.
- `server/google-calendar.ts` — Google Calendar API client and event helpers.
- `client/src/lib/booking-data.ts` — client domain constants and client-side pricing breakdown.
- `client/src/lib/booking-store.tsx` — TanStack Query hooks and mutations.
- `client/src/pages/book.tsx` — guest booking flow.
- `client/src/pages/admin.tsx` — admin console, booking confirm/reject, add-ons management.
- `.env.example` — safe env placeholders.
- `ENV_SETUP.md` — env setup and deployment notes.
- `PRICING_ADDONS_HANDOFF.md` — detailed handoff for latest pricing/add-ons update.
- `server/agent.ts` — Peerspace email-reply agent: Claude draft generation, knowledge-base load, booking matching.
- `server/agent-inbound.ts` — inbound webhook signature verification (Svix/Resend) + payload normalization.
- `server/gmail.ts` — Gmail SMTP sender (nodemailer) for agent replies; sends from the Peerspace-linked Gmail.
- `docs/agent-knowledge.md` — customer-facing knowledge base the agent answers from (edit to change replies; no code change).
- `AGENT_HANDOFF.md` — full handoff for the email-reply agent (setup order, env, schema, flow).

## Suggested next improvements

1. **Cancellation feature**: add admin “Cancel booking” for confirmed bookings. It should mark the row cancelled, remove/update Google Calendar event, send customer cancellation email, and free the slot.
2. **Database hardening**: migrate from SQLite to Postgres, especially if Render instance restarts or data retention becomes critical.
3. **Owner notification polish**: optionally add SMS via Twilio, but email alerts via Resend already exist.
4. **Admin audit trail**: track confirmed/rejected/cancelled by whom and when.
5. **Public page polish**: make iframe height responsive or offer a standalone `booking.studioclyx.com` domain.
6. **Add-on inventory**: add quantity availability and conflict checks for limited furniture/equipment across overlapping bookings.

## Development rule of thumb

Before changing behavior, run:

```bash
npx tsc --noEmit
npm run build
```

For booking logic changes, also smoke-test:

- create booking,
- verify price breakdown,
- check Google hold event,
- confirm booking,
- verify customer email,
- reject/expire flow,
- admin add-on edit.

Do not commit secrets or `.env` files with real values.
