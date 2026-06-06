# Studio Clyx — Environment Setup

All integrations (admin gate, Resend email, Google Calendar) are gated by env
vars. When a var is missing, the corresponding service falls back to
**simulation mode** and writes a structured log line instead of touching the
network. The admin Integrations callout reflects the live state per service —
and for Google Calendar, **per space**.

**Never commit secrets.** Set these on the host (Vercel / Render / Fly /
systemd unit / Docker `--env-file` / etc.). The repo's `.env.example` uses
placeholders for `RESEND_API_KEY` and `GOOGLE_SERVICE_ACCOUNT_JSON`; replace
those on the host, not in the repo.

---

## Required env vars

```bash
# ---- Admin gate ----
# Operator PIN. Without this, the gate falls back to "0000" (preview only).
ADMIN_PIN=2457

# ---- Resend (transactional email) ----
# Get the key from https://resend.com/api-keys. NEVER paste it into a file
# that gets committed. Provide it via your hosting platform's secret manager.
RESEND_API_KEY=                       # e.g. re_xxxxxxxxxxxxxxxxxxxxxxxx (set on host)
RESEND_FROM_ADDRESS='Studio Clyx <info@studioclyx.com>'
# Comma-separated owner recipients for new booking hold alerts.
OWNER_ALERT_EMAILS=calebdao@gmail.com,gladys@example.com
# Single recipient for the "hold still pending after 1 hour" reminder.
# Defaults to info@calebgladys.com when unset.
OWNER_REMINDER_EMAIL=info@calebgladys.com

# ---- Google Calendar (one calendar per space) ----
# Service-account JSON, single-line. Used by the Calendar client.
# Newlines inside private_key may be `\n` escapes — the server normalizes them.
GOOGLE_SERVICE_ACCOUNT_JSON=

# Each space's calendar ID (these are not secrets):
GOOGLE_CALENDAR_ID_STUDIO_1=info@calebgladys.com
GOOGLE_CALENDAR_ID_STUDIO_2=c_a5772f8a4a7b236c16fcad361fb47b876a73968e392a404579f34a6ca1377ccf@group.calendar.google.com
GOOGLE_CALENDAR_ID_STUDIO_3=c_69f2a0aaf2a68a43b034b44d2b69cec143ebacfd5629a536a4021fbc0506f7fd@group.calendar.google.com
GOOGLE_CALENDAR_ID_LINCOLN_APARTMENT=c_7d7a0b0429abd791bf2a787b3ebbbc60c6cae1ff4c12e7216db2335923249226@group.calendar.google.com

# ---- Peerspace email-reply agent ----
# Master kill switch. The agent only drafts replies when this is exactly "true".
AGENT_ENABLED=true
# Anthropic API key for Claude (drafting). Without it, the agent runs in
# simulation mode (placeholder draft text). https://console.anthropic.com
ANTHROPIC_API_KEY=                    # e.g. sk-ant-xxxxxxxx (set on host)
# Claude model used for drafting. Defaults to claude-sonnet-4-6 when unset.
AGENT_MODEL=claude-sonnet-4-6
# Auto-send confident replies without manual approval (default false). Novel
# questions are never auto-sent — they're flagged in the Inbox + emailed to you.
AGENT_AUTO_SEND=false
# Gmail account linked to Peerspace. Used for BOTH reading inbound Peerspace
# emails (IMAP poller) and sending approved replies (SMTP). Requires 2-Step
# Verification + an app password (NOT the login password) and IMAP enabled in
# Gmail settings. Without both, the poller is off and replies simulate.
GMAIL_USER=calebandgladys@gmail.com
GMAIL_APP_PASSWORD=                   # 16-char Gmail app password (set on host)
# Optional inbound-poller tuning (sensible defaults shown):
# PEERSPACE_SENDER_MATCH=peerspace.com  # From-header substring that flags Peerspace mail
# AGENT_INBOX_FOLDER=INBOX              # mailbox/label to read
# AGENT_POLL_SECONDS=60                 # poll interval (min 30)
# AGENT_MAX_PER_POLL=5                  # max emails per poll (bounds memory; backlog drains over polls)
# PEERSPACE_IGNORE_SUBJECTS=...         # comma-separated subject substrings to skip (notifications); overrides default list
# PEERSPACE_MESSAGE_SUBJECTS=...        # stricter allowlist: ONLY draft for subjects containing one of these
# Optional: override the knowledge-base path (defaults to docs/agent-knowledge.md).
# AGENT_KNOWLEDGE_PATH=
```

A copy with safe placeholders also lives in `.env.example`.

---

## Resend behavior

`server/integrations.ts` → `sendConfirmationEmail(booking)`:

1. If **either** `RESEND_API_KEY` **or** `RESEND_FROM_ADDRESS` is missing →
   simulation mode. Logs the recipient + booking ID and returns
   `{ ok: true, mode: "simulation", reason }`.
2. If both are set → live mode. Posts to `https://api.resend.com/emails` with
   `Authorization: Bearer ${RESEND_API_KEY}` and JSON body
   `{ from, to, subject, html, text }`. Returns
   `{ ok: true, mode: "live", providerId }` on success or
   `{ ok: false, mode: "live", status, error }` on failure.

The booking is **always** marked `confirmed` even if the email fails — the
admin UI just shows a different toast (sent / simulated / failed). The Resend
SDK isn't a dependency: the integration uses the global `fetch` so there's no
extra package to install or audit.

### Email contents

Subject: `Studio Clyx — booking confirmed (<booking id>)`

The body (both HTML and plain-text alternative) includes:

- Booking ID
- Guest name (first + last)
- Space (`Studio 1` / `Studio 2` / `Studio 3` / `Lincoln Apartment`)
- Activity (`Production` / `Meeting` / `Event`)
- Date, start, and end times in `America/New_York`
- Duration (hours)
- Total price (rate × duration: $60/hr production, $80/hr meeting/event)
- Zelle recipient: `calebdao@gmail.com`
- Reference: the booking ID, requested in the Zelle memo so payments can be
  matched

`buildConfirmationEmail(booking)` is exported from `server/integrations.ts` if
you ever want to render the email outside the send path (tests, previews, etc.).

### Owner booking alerts

`server/integrations.ts` → `sendOwnerBookingAlert(booking)` runs immediately
after a guest places a new hold with `POST /api/bookings`.

Set:

```bash
OWNER_ALERT_EMAILS=calebdao@gmail.com,gladys@example.com
```

Use a comma-separated list with no quotes. When `RESEND_API_KEY`,
`RESEND_FROM_ADDRESS`, and `OWNER_ALERT_EMAILS` are all configured, Studio Clyx
owners receive an email for every new 1-hour booking hold. The alert includes
booking ID, guest name, guest email/phone, space, activity, date, start/end,
duration, guest count, alcohol flag, selected add-ons, full price breakdown
(base + guest surcharge + event cleaning fee + alcohol fee + add-ons), and the
Zelle memo/reference. If `OWNER_ALERT_EMAILS` is missing, the alert stays in
simulation mode and the booking still succeeds.

### Owner reminder for stale holds

`server/integrations.ts` → `sendOwnerReminderEmail(booking)` is dispatched by the
background sweeper when a hold has been pending for at least one hour without
being confirmed or rejected. The reminder is sent **once per booking**, tracked
via the `reminder_sent_at` column. Configure the recipient with:

```bash
OWNER_REMINDER_EMAIL=info@calebgladys.com
```

When unset, the server uses `info@calebgladys.com` as the default. The reminder
includes the same booking details as the alert, plus a note that the calendar
hold has been released so the slot is free again.

---

## Google Calendar behavior

`server/google-calendar.ts` is a small zero-dep client that talks to
Calendar v3 via a **service-account JWT**. Behavior:

- **Activation is per-space.** `pushBookingToCalendar` and the conflict
  checker only run live for a space when **both** `GOOGLE_SERVICE_ACCOUNT_JSON`
  is parsed successfully **and** the per-space `GOOGLE_CALENDAR_ID_*` env var
  is set. Any space without an ID stays in simulation mode independently of
  the others.
- **No extra dependencies.** Token minting uses Node's built-in
  `crypto.createSign("RSA-SHA256")` to produce a JWT, then exchanges it at
  `https://oauth2.googleapis.com/token` for an access token. Tokens are
  cached in-memory until ~5 minutes before expiry.
- **Confirm path** (`POST /api/bookings/:id/confirm`): after the booking is
  marked `confirmed`, the server calls `pushBookingToCalendar(booking)`. In
  live mode it inserts an event on the space's calendar with:
  - `summary`: `"<Space> — <Activity> (<Guest name>)"`
  - `description`: booking ID, guest name/email/phone, source
  - `start.dateTime` / `end.dateTime` with `timeZone: "America/New_York"`
  - `transparency: "opaque"` (so it blocks)
  - `extendedProperties.private.studioClyxBookingId` for back-references
- **Conflict checks** (`POST /api/bookings`): when a hold is requested for a
  space that's live, the server pulls events in the requested window from
  that space's Google Calendar and rejects with `409 Slot is no longer
  available.` if any opaque, non-cancelled event overlaps. This is what
  makes existing **Peerspace/Giggster bookings** (synced into Google
  Calendar) automatically block new internal bookings.
- **Listing** (`GET /api/bookings`): for every live space, the server pulls
  a 60-day window of events and merges them into the bookings response with
  `source: "google"`. The client scheduler treats them like any other
  confirmed booking, so calendar-synced reservations show up as occupied
  slots in the booking UI.
- **Soft-fail.** If Google returns an error, conflict checks log a warning
  and let the booking through — they don't hard-fail the request. Listing
  silently drops Google events for that space rather than 500-ing.

### Going live

1. **Create a service account.**
   - Google Cloud Console → IAM & Admin → Service Accounts → "Create".
   - Skip role grants (Calendar uses calendar-level sharing, not IAM).
   - Open the new account → Keys → "Add key" → "Create new key" → JSON.
2. **Enable the Calendar API** for the project (APIs & Services → Library →
   "Google Calendar API" → Enable).
3. **Share each calendar with the service account.**
   - Open Google Calendar → click each of the four calendars (Studio 1,
     Studio 2, Studio 3, Lincoln Apartment) → "Settings and sharing" →
     "Share with specific people or groups" → add the service account's
     `client_email` → permission **"Make changes to events"**.
   - The Studio 1 calendar is the primary calendar of `info@calebgladys.com`,
     so the same sharing flow applies — log into that account, share the
     calendar with the service account.
4. **Set env vars on the host.**
   - `GOOGLE_SERVICE_ACCOUNT_JSON` = the entire JSON, single-line. Most
     hosts handle multi-line values, but if yours doesn't, escape newlines
     inside `private_key` as `\n`. The server normalizes either form.
   - `GOOGLE_CALENDAR_ID_STUDIO_1` / `_STUDIO_2` / `_STUDIO_3` /
     `_LINCOLN_APARTMENT` = the IDs in the table above.
5. Restart the server. `/api/integrations/status` will report
   `mode: "live"` (with `liveSpaces: 4 / 4`) and the next confirmed booking
   will write to the correct calendar.

### Status surfaced in admin

`GET /api/integrations/status` returns:

```jsonc
{
  "google": {
    "name": "Google Calendar",
    "mode": "live" | "simulation",
    "detail": [
      { "spaceId": "studio-1", "envVar": "GOOGLE_CALENDAR_ID_STUDIO_1",
        "configured": true, "live": true },
      // ...one entry per space
    ],
    "credentialEnv": "GOOGLE_SERVICE_ACCOUNT_JSON",
    "credentialConfigured": true,
    "credentialError": null,           // string when JSON is malformed
    "liveSpaces": 4,
    "totalSpaces": 4
  },
  "resend": { /* … */ },
  "adminGate": { /* … */ }
}
```

The admin Integrations callout reads this and shows a per-service badge plus
which spaces are live vs simulation. If `credentialError` is set, the badge
explains exactly what went wrong with the JSON parse so you can fix the env
var.

---

## Admin UI

`client/src/pages/admin.tsx` shows one of three toasts after `Confirm payment`:

- **Confirmation email sent** (green, `data-email-mode="live"`,
  `data-email-ok="true"`) — Resend accepted the message.
- **Confirmation email simulated** (green, `data-email-mode="simulation"`,
  `data-email-ok="true"`) — env vars not set; nothing was sent.
- **Email send failed** (red, `data-email-mode="live"`, `data-email-ok="false"`)
  — Resend returned a non-2xx or threw. Booking is still locked in.

The confirm response now also includes a `calendar` field with shape
`{ ok, mode, eventId?, htmlLink?, error?, reason? }`. The booking is
considered confirmed regardless — calendar push failures are logged but
non-fatal.

The Integrations callout above the dashboard reads `/api/integrations/status`
and shows a `live` / `simulation` badge per integration. For Google
Calendar specifically, the detail line lists which spaces are live and which
are still simulation, naming the missing env vars.

---

## Verifying without secrets (simulation QA)

```bash
# Start prod server with simulation defaults
npm run build
NODE_ENV=production node dist/index.cjs &

# Resend should be simulation
curl -s localhost:5000/api/integrations/status | jq .resend
# -> { "name": "Resend", "mode": "simulation",
#      "credentialEnv": "RESEND_API_KEY", "credentialConfigured": false,
#      "fromEnv": "RESEND_FROM_ADDRESS", "fromConfigured": false }

# Google Calendar should be simulation, liveSpaces: 0/4
curl -s localhost:5000/api/integrations/status | jq .google.mode
# -> "simulation"

# Create + confirm a booking — both `email` and `calendar` keys come back
# with mode=simulation, and the booking is still marked confirmed.
```

A live-mode JSON-parse failure is also visible:

```bash
GOOGLE_SERVICE_ACCOUNT_JSON='not-json' \
GOOGLE_CALENDAR_ID_STUDIO_1=info@calebgladys.com \
NODE_ENV=production node dist/index.cjs
# /api/integrations/status -> google.credentialError describes the parse
# failure and mode stays "simulation".
```

---

## Going live checklist

1. Verify the `studioclyx.com` domain in the Resend dashboard so the From
   address can send.
2. Set `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `OWNER_ALERT_EMAILS`, and
   `OWNER_REMINDER_EMAIL` on the host.
3. Create the Google service account, share the four calendars with its
   `client_email`, and enable the Calendar API on the project.
4. Set `GOOGLE_SERVICE_ACCOUNT_JSON` plus the four `GOOGLE_CALENDAR_ID_*`
   env vars on the host.
5. Set `ADMIN_PIN=2457` on the host.
6. Restart the server. `/api/integrations/status` should report `mode:
   "live"` for all three services. The next confirmed booking will deliver
   a real Resend email and write a Google Calendar event to the right
   space's calendar; new hold attempts will conflict-check against existing
   events on that calendar (including Peerspace/Giggster syncs).

---

## Holds, pricing, and the add-on catalog

This section documents behavior changes introduced with the guest-count /
alcohol / add-on update.

### Hold lifecycle

- Holds last **60 minutes** (was 30). The constant lives at
  `HOLD_DURATION_MINUTES` in both `shared/schema.ts`-adjacent code and the
  client.
- On `POST /api/bookings` the server: validates payload → conflict-checks →
  inserts a Drizzle row with `status: "pending"`, `holdActive: true`, and
  `holdExpiresAt: now + 60min` → pushes a **tentative** event to the space's
  Google Calendar (summary prefixed with `[HOLD]`) → stores the resulting
  `googleEventId` + `googleCalendarId` so the same event can be patched on
  confirm or deleted on reject/release/expiry.
- After 60 minutes, the hold-expiry sweeper marks `holdActive: false` (status
  stays `"pending"` so the request stays visible in the admin console) and
  removes the Google Calendar hold so the slot is free again. Pending requests
  with `holdActive: false` no longer block new bookings.
- The sweeper additionally sends a one-time reminder to `OWNER_REMINDER_EMAIL`
  for any booking that has been pending for an hour without being confirmed or
  rejected, and stamps `reminder_sent_at` so the reminder isn't repeated.

### Admin actions

- `POST /api/bookings/:id/release` — admin/system-initiated removal of a hold.
  Deletes the Google Calendar event and removes the booking row.
- `POST /api/bookings/:id/reject` — admin marks a booking as rejected. Sets
  `status: "rejected"`, `holdActive: false`, and deletes the Google Calendar
  event. The booking row is retained for audit.
- `POST /api/bookings/:id/confirm` — admin marks a booking paid. Patches the
  Google Calendar event to `status: "confirmed"` and a clean summary, then
  sends the guest confirmation email.

### Pricing model

All calculations are mirrored in `client/src/lib/booking-data.ts` and
`shared/schema.ts` (constants only).

- **Base rate** — `production` $60/hr, `meeting` $80/hr, `event` $80/hr.
- **Guest surcharge** — charged per hour:
  - 1–15 guests: $0/hr
  - 16–25 guests: $10/hr
  - 26–40 guests: $20/hr
  - Hard cap at 40; min 1.
- **Event cleaning fee** — `$75` flat, applied automatically when activity is
  `event`.
- **Alcohol consumption fee** — `$50` flat when the guest checks the alcohol
  box.
- **Add-ons** — priced per the catalog. `per_item` items multiply price ×
  quantity; `flat` items charge once regardless of "quantity". The server is
  the source of truth: clients send `{ addOnId, quantity }` only; the server
  looks up the catalog, recomputes the line total, and stores the resolved
  `SelectedAddOn[]` on the booking.

The full breakdown (line-by-line) is shown to the guest on the booking page,
in the confirmation dialog, in the guest confirmation email, in the owner
alert email, and in the admin console.

### Add-on catalog

Defined in the new `addon_catalog` SQLite table (`shared/schema.ts`).

- `id, name, description?, price, priceType (per_item|flat), imageUrl?,`
  `quantityAvailable? (nullable), active, sortOrder, createdAt`.
- On first server start the table is seeded with six Peerspace items (10
  Foldable Chairs, Cream Boucle Armchair, Eames Molded Plywood DCM, Mario
  Botta La Quinta Chair, Stools, Courbe Green Ceramic Table Lamp). The seed
  only runs when the table is empty, so existing catalogs survive.
- Public endpoint `GET /api/addons` returns only active items.
- Admin endpoints (PIN-gated via `x-admin-pin`): `GET /api/admin/addons`,
  `POST /api/admin/addons`, `PATCH /api/admin/addons/:id`,
  `DELETE /api/admin/addons/:id`. Delete is **soft** — it sets
  `active: false` so historical bookings keep their displayed item names.
- The admin console exposes the catalog under a new **Add-ons** tab with a
  compact list and a create/edit dialog. Image URL, description, quantity,
  and active flag are all editable.

### Migration on existing databases

`server/storage.ts` runs an idempotent `PRAGMA table_info` →
`ALTER TABLE bookings ADD COLUMN …` migration on startup for every new column
(`guest_count`, `alcohol`, `addons`, `hold_active`, `reminder_sent_at`,
`google_event_id`, `google_calendar_id`). The Render production `data.db` is
upgraded in place — no drizzle-kit migration is needed and no data is lost.
