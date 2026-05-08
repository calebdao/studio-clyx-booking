// Studio Clyx — minimal Google Calendar v3 client.
//
// We avoid adding `googleapis` as a dependency: a service-account JWT plus a
// couple of `fetch` calls is all we need. Behavior:
//
//   - parseServiceAccount(): reads GOOGLE_SERVICE_ACCOUNT_JSON, validates it,
//     caches the parsed result. Returns null in simulation mode.
//   - getAccessToken(): mints a short-lived OAuth access token using a signed
//     JWT (RS256) and caches it until ~5 minutes before expiry.
//   - listEventsForSpace(spaceId, timeMin, timeMax): returns busy windows from
//     the per-space calendar. Used by the conflict checker to honor existing
//     Peerspace/Giggster bookings synced into Google Calendar.
//   - insertEventForBooking(booking): creates an event on the per-space
//     calendar when a booking is confirmed.
//
// All entry points return a discriminated result so callers can render a
// per-booking status without throwing. Errors NEVER block the booking
// itself — if Google is down, we still let the booking through and surface a
// warning. Callers decide how strict to be.
//
// No external deps. Uses Node's built-in `crypto` and global `fetch`.
//
// Required env (any missing -> simulation mode):
//   GOOGLE_SERVICE_ACCOUNT_JSON        single-line service account JSON
//   GOOGLE_CALENDAR_ID_STUDIO_1
//   GOOGLE_CALENDAR_ID_STUDIO_2
//   GOOGLE_CALENDAR_ID_STUDIO_3
//   GOOGLE_CALENDAR_ID_LINCOLN_APARTMENT

import { createSign } from "node:crypto";
import type { BookingDto } from "@shared/schema";

export const SPACE_CALENDAR_ENV: Record<BookingDto["spaceId"], string> = {
  "studio-1": "GOOGLE_CALENDAR_ID_STUDIO_1",
  "studio-2": "GOOGLE_CALENDAR_ID_STUDIO_2",
  "studio-3": "GOOGLE_CALENDAR_ID_STUDIO_3",
  "lincoln-apartment": "GOOGLE_CALENDAR_ID_LINCOLN_APARTMENT",
};

const SPACE_LABELS: Record<BookingDto["spaceId"], string> = {
  "studio-1": "Studio 1",
  "studio-2": "Studio 2",
  "studio-3": "Studio 3",
  "lincoln-apartment": "Lincoln Apartment",
};

const ACTIVITY_LABELS: Record<BookingDto["activityId"], string> = {
  production: "Production",
  meeting: "Meeting",
  event: "Event",
};

const SCOPES = "https://www.googleapis.com/auth/calendar";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

let cachedServiceAccount: ServiceAccount | null | undefined;
let serviceAccountError: string | null = null;

export function parseServiceAccount(): ServiceAccount | null {
  if (cachedServiceAccount !== undefined) return cachedServiceAccount;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    cachedServiceAccount = null;
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("client_email or private_key missing");
    }
    // Some platforms strip newlines from envs. Restore them.
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    cachedServiceAccount = parsed;
    serviceAccountError = null;
    return parsed;
  } catch (e) {
    serviceAccountError = e instanceof Error ? e.message : String(e);
    cachedServiceAccount = null;
    return null;
  }
}

export function getServiceAccountError() {
  // Force evaluation if not yet attempted.
  if (cachedServiceAccount === undefined) parseServiceAccount();
  return serviceAccountError;
}

// ----- Access token (cached) -----

let cachedToken: { token: string; expiresAt: number } | null = null;

function base64url(buf: Buffer | string) {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function mintAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: SCOPES,
    aud: sa.token_uri || TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claim)
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = base64url(signer.sign(sa.private_key));
  const jwt = `${unsigned}.${signature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const res = await fetch(sa.token_uri || TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`google token exchange failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in - 300) * 1000, // 5-min safety
  };
  return json.access_token;
}

export async function getAccessToken(): Promise<string | null> {
  const sa = parseServiceAccount();
  if (!sa) return null;
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }
  return mintAccessToken(sa);
}

// ----- Public API: per-space helpers -----

export function calendarIdForSpace(spaceId: BookingDto["spaceId"]) {
  return process.env[SPACE_CALENDAR_ENV[spaceId]] || null;
}

export function isCalendarLiveForSpace(spaceId: BookingDto["spaceId"]) {
  return Boolean(parseServiceAccount() && calendarIdForSpace(spaceId));
}

export type GoogleEventBusy = {
  id: string;
  spaceId: BookingDto["spaceId"];
  summary?: string;
  start: string; // ISO
  end: string; // ISO
};

/**
 * List events that fall in the [timeMin, timeMax] window for a given space.
 * Returns null if the integration is not configured for this space (simulation).
 * On error, returns { error } — caller decides whether to allow the booking.
 */
export async function listEventsForSpace(
  spaceId: BookingDto["spaceId"],
  timeMin: Date,
  timeMax: Date
): Promise<
  | { ok: true; events: GoogleEventBusy[] }
  | { ok: false; reason: "simulation" }
  | { ok: false; reason: "error"; error: string }
> {
  if (!isCalendarLiveForSpace(spaceId)) {
    return { ok: false, reason: "simulation" };
  }
  try {
    const token = await getAccessToken();
    if (!token) return { ok: false, reason: "simulation" };
    const calendarId = calendarIdForSpace(spaceId)!;
    const url = new URL(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`
    );
    url.searchParams.set("timeMin", timeMin.toISOString());
    url.searchParams.set("timeMax", timeMax.toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        reason: "error",
        error: `list events ${res.status}: ${body}`,
      };
    }
    const json = (await res.json()) as {
      items?: Array<{
        id: string;
        summary?: string;
        status?: string;
        transparency?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
      }>;
    };
    const events: GoogleEventBusy[] = (json.items ?? [])
      // Skip cancelled and "free" (transparent) events — those don't block.
      .filter(
        (e) => e.status !== "cancelled" && e.transparency !== "transparent"
      )
      .map((e) => {
        const startIso = e.start?.dateTime || dateOnlyToIso(e.start?.date, false);
        const endIso = e.end?.dateTime || dateOnlyToIso(e.end?.date, true);
        return {
          id: e.id,
          spaceId,
          summary: e.summary,
          start: startIso,
          end: endIso,
        };
      })
      .filter((e) => e.start && e.end);
    return { ok: true, events };
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function dateOnlyToIso(date: string | undefined, end: boolean): string {
  if (!date) return "";
  // All-day events use YYYY-MM-DD; treat as local midnight.
  const d = new Date(`${date}T00:00:00`);
  if (end) d.setDate(d.getDate());
  return d.toISOString();
}

/**
 * Insert an event on the space's calendar for a confirmed booking.
 */
export async function insertEventForBooking(
  booking: BookingDto
): Promise<
  | { ok: true; mode: "live"; eventId: string; htmlLink?: string }
  | { ok: false; mode: "simulation"; reason: string }
  | { ok: false; mode: "live"; error: string }
> {
  if (!isCalendarLiveForSpace(booking.spaceId)) {
    const reason = !parseServiceAccount()
      ? "GOOGLE_SERVICE_ACCOUNT_JSON missing/invalid"
      : `${SPACE_CALENDAR_ENV[booking.spaceId]} not set`;
    return { ok: false, mode: "simulation", reason };
  }
  try {
    const token = await getAccessToken();
    if (!token) {
      return {
        ok: false,
        mode: "simulation",
        reason: "Could not obtain access token",
      };
    }
    const calendarId = calendarIdForSpace(booking.spaceId)!;
    const url = new URL(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`
    );

    const guest = `${booking.guest.firstName} ${booking.guest.lastName}`.trim();
    const space = SPACE_LABELS[booking.spaceId] ?? booking.spaceId;
    const activity = ACTIVITY_LABELS[booking.activityId] ?? booking.activityId;

    const body = {
      summary: `${space} — ${activity} (${guest})`,
      description: [
        `Studio Clyx booking ${booking.id}`,
        ``,
        `Guest: ${guest}`,
        `Email: ${booking.guest.email}`,
        booking.guest.phone ? `Phone: ${booking.guest.phone}` : null,
        `Activity: ${activity}`,
        `Source: ${booking.source}`,
      ]
        .filter(Boolean)
        .join("\n"),
      start: { dateTime: booking.start, timeZone: "America/New_York" },
      end: { dateTime: booking.end, timeZone: "America/New_York" },
      // Mark as opaque so it blocks (consistent with our conflict logic).
      transparency: "opaque",
      // Ensure a stable mapping back to the booking ID for later updates/deletes.
      extendedProperties: {
        private: {
          studioClyxBookingId: booking.id,
          studioClyxSource: booking.source,
        },
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        mode: "live",
        error: `insert event ${res.status}: ${text}`,
      };
    }
    const json = (await res.json()) as { id: string; htmlLink?: string };
    return {
      ok: true,
      mode: "live",
      eventId: json.id,
      htmlLink: json.htmlLink,
    };
  } catch (e) {
    return {
      ok: false,
      mode: "live",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
