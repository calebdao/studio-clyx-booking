// Studio Clyx — integration hooks.
//
// These services are structured to mirror real production calls so swapping in
// live SDKs/APIs later is just a matter of plugging in env vars + a real client.
// When env vars are absent, each method short-circuits in "simulation mode" and
// writes a structured log line. The Resend integration is fully live when
// RESEND_API_KEY + RESEND_FROM_ADDRESS are set.

import type { BookingDto } from "@shared/schema";
import {
  SPACE_CALENDAR_ENV,
  parseServiceAccount,
  getServiceAccountError,
  insertEventForBooking,
  isCalendarLiveForSpace,
} from "./google-calendar";
import {
  CANCELLATION_CONTACT_LINE,
  CANCELLATION_POLICY_ACKNOWLEDGEMENT,
  CANCELLATION_POLICY_ITEMS,
  CANCELLATION_POLICY_TITLE,
} from "@shared/cancellation-policy";

export { SPACE_CALENDAR_ENV };

// ----- Google Calendar (one calendar per space) -----

export function googleCalendarStatus() {
  const ids = (Object.keys(SPACE_CALENDAR_ENV) as BookingDto["spaceId"][]).map(
    (spaceId) => ({
      spaceId,
      envVar: SPACE_CALENDAR_ENV[spaceId],
      configured: Boolean(process.env[SPACE_CALENDAR_ENV[spaceId]]),
      live: isCalendarLiveForSpace(spaceId),
    })
  );
  const allConfigured = ids.every((c) => c.configured);
  const credsConfigured = Boolean(parseServiceAccount());
  const credsError = getServiceAccountError();
  const liveSpaces = ids.filter((c) => c.live).length;
  return {
    name: "Google Calendar",
    mode: allConfigured && credsConfigured ? "live" : "simulation",
    detail: ids,
    credentialEnv: "GOOGLE_SERVICE_ACCOUNT_JSON",
    credentialConfigured: credsConfigured,
    credentialError: credsError,
    liveSpaces,
    totalSpaces: ids.length,
  } as const;
}

export async function pushBookingToCalendar(booking: BookingDto) {
  if (!isCalendarLiveForSpace(booking.spaceId)) {
    console.log(
      `[integrations] simulation: would create Google Calendar event for ${booking.id} on ${booking.spaceId}`
    );
    return { ok: true, mode: "simulation" as const };
  }
  const result = await insertEventForBooking(booking);
  if (result.ok) {
    console.log(
      `[integrations] google calendar: inserted event ${result.eventId} for ${booking.id} (${booking.spaceId})`
    );
    return {
      ok: true,
      mode: "live" as const,
      eventId: result.eventId,
      htmlLink: result.htmlLink,
    };
  }
  if (result.mode === "simulation") {
    console.log(
      `[integrations] simulation (${result.reason}): skipped calendar event for ${booking.id}`
    );
    return { ok: true, mode: "simulation" as const, reason: result.reason };
  }
  console.error(
    `[integrations] google calendar insert failed for ${booking.id}: ${result.error}`
  );
  return { ok: false, mode: "live" as const, error: result.error };
}

// ----- Resend (transactional email) -----

// Display labels — kept here so the email body matches the public site copy
// without importing client-only files in the server bundle.
const SPACE_LABELS: Record<BookingDto["spaceId"], string> = {
  "studio-1": "Studio 1",
  "studio-2": "Studio 2",
  "studio-3": "Studio 3",
  "lincoln-apartment": "Lincoln Apartment",
};

const ACTIVITY_LABELS: Record<BookingDto["activityId"], { name: string; rate: number }> = {
  production: { name: "Production", rate: 60 },
  meeting: { name: "Meeting", rate: 80 },
  event: { name: "Event", rate: 80 },
};

const ZELLE_RECIPIENT = "calebdao@gmail.com";

export function resendStatus() {
  return {
    name: "Resend",
    mode:
      process.env.RESEND_API_KEY && process.env.RESEND_FROM_ADDRESS
        ? "live"
        : "simulation",
    credentialEnv: "RESEND_API_KEY",
    credentialConfigured: Boolean(process.env.RESEND_API_KEY),
    fromEnv: "RESEND_FROM_ADDRESS",
    fromConfigured: Boolean(process.env.RESEND_FROM_ADDRESS),
  } as const;
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBookingTimes(booking: BookingDto) {
  const start = new Date(booking.start);
  const end = new Date(booking.end);
  const durationHours = Math.max(
    0,
    Math.round(((end.getTime() - start.getTime()) / 36e5) * 100) / 100
  );
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  });
  return {
    durationHours,
    dateLabel: dateFmt.format(start),
    startLabel: timeFmt.format(start),
    endLabel: timeFmt.format(end),
  };
}

export function buildConfirmationEmail(booking: BookingDto) {
  const space = SPACE_LABELS[booking.spaceId] ?? booking.spaceId;
  const activity = ACTIVITY_LABELS[booking.activityId];
  const activityLabel = activity?.name ?? booking.activityId;
  const rate = activity?.rate ?? 0;
  const { durationHours, dateLabel, startLabel, endLabel } =
    formatBookingTimes(booking);
  const total = Math.round(rate * durationHours * 100) / 100;
  const totalLabel = `$${total.toFixed(2)}`;
  const guestName = `${booking.guest.firstName} ${booking.guest.lastName}`.trim();
  const subject = `Studio Clyx — booking confirmed (${booking.id})`;

  const text = [
    `Hi ${guestName},`,
    "",
    `Your booking at Studio Clyx is confirmed.`,
    "",
    `Booking ID:    ${booking.id}`,
    `Space:         ${space}`,
    `Activity:      ${activityLabel}`,
    `Date:          ${dateLabel}`,
    `Start:         ${startLabel}`,
    `End:           ${endLabel}`,
    `Duration:      ${durationHours} hour${durationHours === 1 ? "" : "s"}`,
    `Total:         ${totalLabel}`,
    "",
    `Payment: Zelle to ${ZELLE_RECIPIENT}.`,
    `Reference: ${booking.id} (please include this in the Zelle memo).`,
    "",
    CANCELLATION_POLICY_TITLE,
    "",
    "Bookings are confirmed upon receipt of payment and are subject to the following terms:",
    ...CANCELLATION_POLICY_ITEMS.map((item) => `- ${item}`),
    "",
    CANCELLATION_POLICY_ACKNOWLEDGEMENT,
    CANCELLATION_CONTACT_LINE,
    "",
    `If anything looks off, reply to this email.`,
    "",
    `— Studio Clyx`,
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#F7F6F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#28251D;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F7F6F2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#FBFBF9;border:1px solid #D4D1CA;border-radius:8px;">
        <tr><td style="padding:28px 28px 12px 28px;">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#01696F;font-weight:600;">Studio Clyx</div>
          <h1 style="margin:6px 0 0 0;font-size:22px;font-weight:600;letter-spacing:-0.01em;color:#28251D;">Your booking is confirmed</h1>
          <p style="margin:10px 0 0 0;font-size:14px;line-height:1.5;color:#28251D;">Hi ${escapeHtml(guestName)}, thanks for booking with us. The details are locked in below.</p>
        </td></tr>
        <tr><td style="padding:8px 28px 20px 28px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;line-height:1.5;">
            ${row("Booking ID", booking.id, true)}
            ${row("Space", space)}
            ${row("Activity", activityLabel)}
            ${row("Date", dateLabel)}
            ${row("Start", startLabel)}
            ${row("End", endLabel)}
            ${row("Duration", `${durationHours} hour${durationHours === 1 ? "" : "s"}`)}
            ${row("Total", totalLabel)}
          </table>
        </td></tr>
        <tr><td style="padding:0 28px 24px 28px;">
          <div style="border-top:1px solid #D4D1CA;padding-top:18px;">
            <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#7A7974;font-weight:600;">Payment</div>
            <p style="margin:6px 0 0 0;font-size:14px;line-height:1.5;">Send via Zelle to <strong style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(ZELLE_RECIPIENT)}</strong>.</p>
            <p style="margin:6px 0 0 0;font-size:14px;line-height:1.5;">Reference: <strong style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(booking.id)}</strong> — please include this in the Zelle memo so we can match the payment.</p>
          </div>
        </td></tr>
        <tr><td style="padding:0 28px 24px 28px;">
          <div style="border-top:1px solid #D4D1CA;padding-top:18px;">
            <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#7A7974;font-weight:600;">Cancellation policy</div>
            <p style="margin:6px 0 0 0;font-size:14px;line-height:1.5;color:#28251D;">Bookings are confirmed upon receipt of payment and are subject to the following terms:</p>
            <ul style="margin:10px 0 0 18px;padding:0;font-size:13px;line-height:1.5;color:#28251D;">
              ${CANCELLATION_POLICY_ITEMS.map((item) => `<li style="margin:0 0 6px 0;">${escapeHtml(item)}</li>`).join("")}
            </ul>
            <p style="margin:10px 0 0 0;font-size:13px;line-height:1.5;color:#28251D;">${escapeHtml(CANCELLATION_POLICY_ACKNOWLEDGEMENT)}</p>
            <p style="margin:8px 0 0 0;font-size:13px;line-height:1.5;color:#28251D;"><strong>${escapeHtml(CANCELLATION_CONTACT_LINE)}</strong></p>
          </div>
        </td></tr>
        <tr><td style="padding:0 28px 28px 28px;">
          <p style="margin:0;font-size:12px;color:#7A7974;line-height:1.5;">If anything looks off, just reply to this email and we'll sort it.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

function row(label: string, value: string, mono = false) {
  const valueStyle = mono
    ? "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;"
    : "";
  return `<tr>
      <td style="padding:6px 0;width:120px;color:#7A7974;font-size:13px;">${escapeHtml(label)}</td>
      <td style="padding:6px 0;color:#28251D;font-weight:500;${valueStyle}">${escapeHtml(value)}</td>
    </tr>`;
}

export async function sendConfirmationEmail(booking: BookingDto) {
  const status = resendStatus();
  if (status.mode === "simulation") {
    const reason = !process.env.RESEND_API_KEY
      ? "RESEND_API_KEY missing"
      : "RESEND_FROM_ADDRESS missing";
    console.log(
      `[integrations] simulation (${reason}): would email ${booking.guest.email} for confirmed booking ${booking.id}`
    );
    return { ok: true, mode: "simulation" as const, reason };
  }

  const apiKey = process.env.RESEND_API_KEY!;
  const from = process.env.RESEND_FROM_ADDRESS!; // expected: "Studio Clyx <info@studioclyx.com>"
  const to = booking.guest.email;
  const { subject, text, html } = buildConfirmationEmail(booking);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[integrations] resend send failed for ${booking.id}: ${res.status} ${body}`
      );
      return { ok: false, mode: "live" as const, status: res.status, error: body };
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    console.log(
      `[integrations] resend: sent confirmation for ${booking.id} to ${to} (resend id=${json.id ?? "?"})`
    );
    return { ok: true, mode: "live" as const, providerId: json.id ?? null };
  } catch (err) {
    console.error(`[integrations] resend send threw for ${booking.id}:`, err);
    return {
      ok: false,
      mode: "live" as const,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ----- Hold expiry sweeper -----

export function startHoldExpirySweeper(
  expire: (now: number) => Promise<number>
) {
  // Run every 60s.
  const interval = setInterval(async () => {
    try {
      const removed = await expire(Date.now());
      if (removed > 0) {
        console.log(`[integrations] hold sweeper: released ${removed} expired hold(s)`);
      }
    } catch (e) {
      console.error("[integrations] hold sweeper error:", e);
    }
  }, 60_000);
  // unref so it doesn't block process exit (in tests/builds).
  if (typeof interval.unref === "function") interval.unref();
  return interval;
}

// ----- Aggregate status for the admin callout -----

export function integrationsStatus() {
  return {
    google: googleCalendarStatus(),
    resend: resendStatus(),
    adminGate: {
      name: "Admin gate",
      mode: process.env.ADMIN_PIN ? "live" : "simulation",
      credentialEnv: "ADMIN_PIN",
      credentialConfigured: Boolean(process.env.ADMIN_PIN),
      defaultPinHint: process.env.ADMIN_PIN ? null : "0000 (default)",
    },
  };
}
