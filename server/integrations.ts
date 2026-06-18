// Studio Clyx — integration hooks.
//
// These services are structured to mirror real production calls so swapping in
// live SDKs/APIs later is just a matter of plugging in env vars + a real client.
// When env vars are absent, each method short-circuits in "simulation mode" and
// writes a structured log line. The Resend integration is fully live when
// RESEND_API_KEY + RESEND_FROM_ADDRESS are set.

import type { BookingDto, SelectedAddOn } from "@shared/schema";
import {
  EVENT_CLEANING_FEE,
  ALCOHOL_FEE,
  guestSurchargeRate,
} from "@shared/schema";
import {
  SPACE_CALENDAR_ENV,
  parseServiceAccount,
  getServiceAccountError,
  insertEventForBooking,
  insertHoldEventForBooking,
  updateEventForBooking,
  deleteEvent,
  isCalendarLiveForSpace,
  calendarIdForSpace,
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

/**
 * Push a tentative HOLD event to Google Calendar when a new booking is placed.
 * The hold event blocks the slot for the duration of the hold so other channels
 * (Peerspace, Giggster) see the time as busy too.
 */
export async function pushHoldToCalendar(booking: BookingDto) {
  if (!isCalendarLiveForSpace(booking.spaceId)) {
    console.log(
      `[integrations] simulation: would create Google Calendar HOLD event for ${booking.id} on ${booking.spaceId}`
    );
    return { ok: true, mode: "simulation" as const };
  }
  const result = await insertHoldEventForBooking(booking);
  if (result.ok) {
    console.log(
      `[integrations] google calendar: inserted HOLD event ${result.eventId} for ${booking.id} (${booking.spaceId})`
    );
    return {
      ok: true,
      mode: "live" as const,
      eventId: result.eventId,
      calendarId: result.calendarId,
      htmlLink: result.htmlLink,
    };
  }
  if (result.mode === "simulation") {
    return { ok: true, mode: "simulation" as const, reason: result.reason };
  }
  console.error(
    `[integrations] google calendar HOLD insert failed for ${booking.id}: ${result.error}`
  );
  return { ok: false, mode: "live" as const, error: result.error };
}

/**
 * On confirm, patch the existing hold event into a confirmed event (preferred)
 * or insert a fresh confirmed event if we don't have an id (legacy bookings).
 */
export async function pushBookingToCalendar(booking: BookingDto) {
  if (!isCalendarLiveForSpace(booking.spaceId)) {
    console.log(
      `[integrations] simulation: would create Google Calendar event for ${booking.id} on ${booking.spaceId}`
    );
    return { ok: true, mode: "simulation" as const };
  }
  // Prefer to patch the existing hold event so we don't leave a duplicate.
  if (booking.googleEventId && booking.googleCalendarId) {
    const patched = await updateEventForBooking(
      booking,
      booking.googleEventId,
      booking.googleCalendarId,
      "confirmed"
    );
    if (patched.ok) {
      console.log(
        `[integrations] google calendar: patched event ${patched.eventId} to confirmed for ${booking.id}`
      );
      return {
        ok: true,
        mode: "live" as const,
        eventId: patched.eventId,
        htmlLink: patched.htmlLink,
      };
    }
    console.warn(
      `[integrations] google calendar patch failed for ${booking.id}, falling back to fresh insert: ${
        "error" in patched ? patched.error : patched.reason
      }`
    );
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
    return { ok: true, mode: "simulation" as const, reason: result.reason };
  }
  console.error(
    `[integrations] google calendar insert failed for ${booking.id}: ${result.error}`
  );
  return { ok: false, mode: "live" as const, error: result.error };
}

/**
 * Best-effort removal of a Google Calendar hold event when a booking is
 * released, rejected, or its hold expires. Silent when no event was ever
 * created (simulation or never-live spaces).
 */
export async function removeCalendarEvent(booking: BookingDto) {
  if (!booking.googleEventId || !booking.googleCalendarId) {
    return { ok: true, mode: "simulation" as const, reason: "no event id" };
  }
  const result = await deleteEvent(booking.googleEventId, booking.googleCalendarId);
  if (result.ok) {
    console.log(
      `[integrations] google calendar: deleted event ${booking.googleEventId} for ${booking.id}`
    );
    return { ok: true, mode: "live" as const };
  }
  if (result.mode === "simulation") {
    return { ok: true, mode: "simulation" as const, reason: result.reason };
  }
  console.error(
    `[integrations] google calendar delete failed for ${booking.id}: ${result.error}`
  );
  return { ok: false, mode: "live" as const, error: result.error };
}

void calendarIdForSpace; // re-exported elsewhere; keep referenced to dodge lint

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
const DEFAULT_OWNER_REMINDER_EMAIL = "info@calebgladys.com";
const PAYMENT_WINDOW_LABEL = "10\u201330 minutes";

export function resendStatus() {
  const ownerAlertRecipients = getOwnerAlertRecipients();
  const reminderRecipient = getOwnerReminderRecipient();
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
    ownerAlertsEnv: "OWNER_ALERT_EMAILS",
    ownerAlertRecipientsConfigured: ownerAlertRecipients.length > 0,
    ownerAlertRecipientCount: ownerAlertRecipients.length,
    ownerReminderEnv: "OWNER_REMINDER_EMAIL",
    ownerReminderRecipient: reminderRecipient,
  } as const;
}

function getOwnerAlertRecipients() {
  return (process.env.OWNER_ALERT_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
}

// Alert the operator that the email bot hit a question it wasn't confident
// answering (a novel question). Nothing was sent to the guest — it's waiting in
// the admin Inbox.
export async function sendAgentNovelQuestionAlert(args: {
  guestName: string | null;
  question: string;
  missing: string | null;
  conversationId: string;
}) {
  const to = getOwnerAlertRecipients();
  if (to.length === 0) {
    console.log(
      `[integrations] simulation (OWNER_ALERT_EMAILS missing): novel-question alert for ${args.conversationId}`
    );
    return { ok: true, mode: "simulation" as const, reason: "OWNER_ALERT_EMAILS missing" };
  }
  const adminUrl = "https://studio-clyx-booking.onrender.com/#/admin";
  const who = args.guestName || "A guest";
  const q = (args.question || "").slice(0, 1000);
  const subject = `Peerspace: ${who} asked something the bot couldn't answer`;
  const text = [
    `${who} sent a Peerspace message the assistant wasn't confident answering, so nothing was sent automatically.`,
    args.missing ? `\nWhat it needs: ${args.missing}` : "",
    `\nGuest message:\n${q}`,
    `\nReview & reply in the admin Inbox: ${adminUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">` +
    `<p>${escapeHtml(who)} sent a Peerspace message the assistant wasn't confident answering, so nothing was sent automatically.</p>` +
    (args.missing ? `<p><b>What it needs:</b> ${escapeHtml(args.missing)}</p>` : "") +
    `<p><b>Guest message:</b></p><blockquote style="white-space:pre-wrap;border-left:3px solid #ddd;padding-left:10px;color:#444">${escapeHtml(q)}</blockquote>` +
    `<p><a href="${adminUrl}">Review &amp; reply in the admin Inbox →</a></p></div>`;
  return sendResendEmail({
    to,
    subject,
    html,
    text,
    label: "agent novel-question alert",
    bookingId: `agent:${args.conversationId}`,
  });
}

function getOwnerReminderRecipient(): string {
  const raw = (process.env.OWNER_REMINDER_EMAIL ?? "").trim();
  return raw || DEFAULT_OWNER_REMINDER_EMAIL;
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

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

interface PriceLineItem {
  label: string;
  detail?: string;
  amount: number;
}
interface PriceSummary {
  hours: number;
  base: number;
  guestSurcharge: number;
  guestSurchargeRate: number;
  cleaningFee: number;
  alcoholFee: number;
  addonsTotal: number;
  cardFee: number;
  subtotal: number; // total without card fee (what merchant nets on a successful card charge)
  total: number; // what the customer actually owes (includes card fee if applicable)
  lines: PriceLineItem[];
  guestTier: string;
}

function guestTierLabelServer(count: number) {
  if (count <= 15) return "1\u201315 guests";
  if (count <= 25) return "16\u201325 guests";
  return "26\u201340 guests";
}

export function computeBookingPricing(booking: BookingDto): PriceSummary {
  const activity = ACTIVITY_LABELS[booking.activityId];
  const baseRate = activity?.rate ?? 0;
  const { durationHours } = formatBookingTimes(booking);
  const surchargeRate = guestSurchargeRate(booking.guestCount ?? 1);
  const base = round2(baseRate * durationHours);
  const guestSurcharge = round2(surchargeRate * durationHours);
  const cleaningFee = booking.activityId === "event" ? EVENT_CLEANING_FEE : 0;
  const alcoholFee = booking.alcohol ? ALCOHOL_FEE : 0;
  const addons: SelectedAddOn[] = booking.addons ?? [];
  const addonsTotal = round2(addons.reduce((s, a) => s + (a.lineTotal ?? 0), 0));
  const subtotal = round2(
    base + guestSurcharge + cleaningFee + alcoholFee + addonsTotal
  );
  const cardFee =
    booking.paymentMethod === "card"
      ? round2(booking.cardFeeAmount ?? 0)
      : 0;
  const total = round2(subtotal + cardFee);

  const lines: PriceLineItem[] = [
    {
      label: `${activity?.name ?? booking.activityId} rate`,
      detail: `$${baseRate}/hr \u00d7 ${durationHours} hr`,
      amount: base,
    },
  ];
  if (surchargeRate > 0) {
    lines.push({
      label: `Guest surcharge (${guestTierLabelServer(booking.guestCount ?? 1)})`,
      detail: `$${surchargeRate}/hr \u00d7 ${durationHours} hr`,
      amount: guestSurcharge,
    });
  }
  if (cleaningFee > 0) {
    lines.push({ label: "Event cleaning fee", amount: cleaningFee });
  }
  if (alcoholFee > 0) {
    lines.push({ label: "Alcohol consumption fee", amount: alcoholFee });
  }
  for (const a of addons) {
    lines.push({
      label: a.name,
      detail:
        a.priceType === "flat"
          ? `flat \u00b7 $${a.price.toFixed(2)}`
          : `${a.quantity} \u00d7 $${a.price.toFixed(2)}`,
      amount: a.lineTotal,
    });
  }
  if (cardFee > 0) {
    lines.push({
      label: "Card processing fee",
      detail: "2.9% + $0.30 (passed through from Stripe)",
      amount: cardFee,
    });
  }
  return {
    hours: durationHours,
    base,
    guestSurcharge,
    guestSurchargeRate: surchargeRate,
    cleaningFee,
    alcoholFee,
    addonsTotal,
    cardFee,
    subtotal,
    total,
    lines,
    guestTier: guestTierLabelServer(booking.guestCount ?? 1),
  };
}

function formatPriceLinesText(pricing: PriceSummary): string[] {
  const out: string[] = [];
  for (const l of pricing.lines) {
    const detail = l.detail ? ` (${l.detail})` : "";
    out.push(`  - ${l.label}${detail}: $${l.amount.toFixed(2)}`);
  }
  out.push(`  TOTAL: $${pricing.total.toFixed(2)}`);
  return out;
}

function formatPriceLinesHtml(pricing: PriceSummary): string {
  const rows = pricing.lines
    .map((l) => {
      const detail = l.detail
        ? `<span style="color:#7A7974;font-size:12px;display:block;">${escapeHtml(
            l.detail
          )}</span>`
        : "";
      return `<tr>
        <td style="padding:6px 0;color:#28251D;font-size:13px;">${escapeHtml(l.label)}${detail}</td>
        <td style="padding:6px 0;color:#28251D;font-size:13px;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">$${l.amount.toFixed(2)}</td>
      </tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
    ${rows}
    <tr><td colspan="2" style="border-top:1px solid #D4D1CA;"></td></tr>
    <tr>
      <td style="padding:6px 0;color:#28251D;font-weight:600;">Total</td>
      <td style="padding:6px 0;color:#28251D;font-weight:600;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">$${pricing.total.toFixed(2)}</td>
    </tr>
  </table>`;
}

export function buildConfirmationEmail(booking: BookingDto) {
  const space = SPACE_LABELS[booking.spaceId] ?? booking.spaceId;
  const activity = ACTIVITY_LABELS[booking.activityId];
  const activityLabel = activity?.name ?? booking.activityId;
  const { durationHours, dateLabel, startLabel, endLabel } =
    formatBookingTimes(booking);
  const pricing = computeBookingPricing(booking);
  const totalLabel = `$${pricing.total.toFixed(2)}`;
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
    `Guests:        ${booking.guestCount}`,
    booking.alcohol ? `Alcohol:       yes ($${ALCOHOL_FEE} fee)` : `Alcohol:       no`,
    "",
    "Price breakdown:",
    ...formatPriceLinesText(pricing),
    "",
    booking.paymentMethod === "card"
      ? `Payment: Credit card · charged via Stripe at booking ($${pricing.total.toFixed(2)} total, includes $${pricing.cardFee.toFixed(2)} card processing fee).`
      : `Payment: Zelle to ${ZELLE_RECIPIENT}.`,
    booking.paymentMethod === "card"
      ? `A receipt was emailed to you by Stripe.`
      : `Reference: ${booking.id} (please include this in the Zelle memo).`,
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

  const addonsHtml =
    booking.addons && booking.addons.length > 0
      ? `<tr><td colspan="2" style="padding-top:8px;color:#7A7974;font-size:11px;text-transform:uppercase;letter-spacing:0.12em;">Add-ons</td></tr>` +
        booking.addons
          .map(
            (a) =>
              `<tr><td style="padding:2px 0;font-size:13px;">${escapeHtml(
                a.name
              )}<span style="color:#7A7974;"> · ${
                a.priceType === "flat"
                  ? "flat"
                  : `${a.quantity} \u00d7 $${a.price.toFixed(2)}`
              }</span></td><td style="padding:2px 0;font-size:13px;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">$${a.lineTotal.toFixed(
                2
              )}</td></tr>`
          )
          .join("")
      : "";

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
            ${row("Guests", String(booking.guestCount))}
            ${row("Alcohol", booking.alcohol ? "yes" : "no")}
            ${row("Total", totalLabel)}
          </table>
        </td></tr>
        <tr><td style="padding:0 28px 20px 28px;">
          <div style="border-top:1px solid #D4D1CA;padding-top:18px;">
            <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#7A7974;font-weight:600;">Price breakdown</div>
            <div style="margin-top:8px;">${formatPriceLinesHtml(pricing)}</div>
            ${addonsHtml ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:8px;">${addonsHtml}</table>` : ""}
          </div>
        </td></tr>
        <tr><td style="padding:0 28px 24px 28px;">
          <div style="border-top:1px solid #D4D1CA;padding-top:18px;">
            <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#7A7974;font-weight:600;">Payment</div>
            ${
              booking.paymentMethod === "card"
                ? `<p style="margin:6px 0 0 0;font-size:14px;line-height:1.5;">Charged to your card via Stripe — <strong>$${pricing.total.toFixed(
                    2
                  )}</strong> (includes $${pricing.cardFee.toFixed(
                    2
                  )} card processing fee). A receipt was emailed to you by Stripe.</p>`
                : `<p style="margin:6px 0 0 0;font-size:14px;line-height:1.5;">Send via Zelle to <strong style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(
                    ZELLE_RECIPIENT
                  )}</strong>.</p>
            <p style="margin:6px 0 0 0;font-size:14px;line-height:1.5;">Reference: <strong style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(
                  booking.id
                )}</strong> — please include this in the Zelle memo so we can match the payment.</p>`
            }
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

async function sendResendEmail(args: {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  label: string; // for logging
  bookingId: string;
}) {
  const status = resendStatus();
  if (status.mode === "simulation") {
    const reason = !process.env.RESEND_API_KEY
      ? "RESEND_API_KEY missing"
      : "RESEND_FROM_ADDRESS missing";
    console.log(
      `[integrations] simulation (${reason}): would send ${args.label} for ${args.bookingId} to ${
        Array.isArray(args.to) ? args.to.join(", ") : args.to
      }`
    );
    return { ok: true, mode: "simulation" as const, reason };
  }
  const apiKey = process.env.RESEND_API_KEY!;
  const from = process.env.RESEND_FROM_ADDRESS!;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[integrations] resend ${args.label} failed for ${args.bookingId}: ${res.status} ${body}`
      );
      return { ok: false, mode: "live" as const, status: res.status, error: body };
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    console.log(
      `[integrations] resend: sent ${args.label} for ${args.bookingId} (resend id=${json.id ?? "?"})`
    );
    return { ok: true, mode: "live" as const, providerId: json.id ?? null };
  } catch (err) {
    console.error(`[integrations] resend ${args.label} threw for ${args.bookingId}:`, err);
    return {
      ok: false,
      mode: "live" as const,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Night-before prep reminder: equipment add-ons to prepare for tomorrow's
// Peerspace booking. Sent to OWNER_ALERT_EMAILS.
export async function sendAddonReminderEmail(args: {
  studioLabel: string;
  guestName: string | null;
  dateTimeText: string | null;
  items: Array<{ name: string; qty: number }>;
  truncated: boolean;
  viewLink: string | null;
}) {
  const to = getOwnerAlertRecipients();
  if (to.length === 0) {
    console.log(
      "[integrations] simulation (OWNER_ALERT_EMAILS missing): add-on prep reminder"
    );
    return { ok: true, mode: "simulation" as const, reason: "OWNER_ALERT_EMAILS missing" };
  }
  const who = args.guestName ? ` (${args.guestName})` : "";
  const when = args.dateTimeText ? ` — ${args.dateTimeText}` : "";
  const subject = `Prep reminder: ${args.studioLabel} tomorrow — ${args.items.length} add-on(s)`;
  const itemsText = args.items.map((i) => `• ${i.name} ×${i.qty}`).join("\n");
  const itemsHtml = args.items
    .map((i) => `<li>${escapeHtml(i.name)} ×${i.qty}</li>`)
    .join("");
  const truncNote = args.truncated
    ? "\n\n⚠️ Peerspace's email only lists the first ~5 add-ons — there may be more. Check the full list:"
    : "";
  const truncHtml = args.truncated
    ? `<p style="color:#9a6a00"><b>⚠️ Peerspace's email only lists the first ~5 add-ons — there may be more.</b> Check the full list${args.viewLink ? `: <a href="${args.viewLink}">View booking</a>` : ""}.</p>`
    : args.viewLink
      ? `<p><a href="${args.viewLink}">View booking on Peerspace</a></p>`
      : "";
  const text = `Equipment to prepare for tomorrow's ${args.studioLabel} booking${who}${when}:\n\n${itemsText}${truncNote}${args.viewLink ? `\n${args.viewLink}` : ""}`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">` +
    `<p>Equipment to prepare for tomorrow's <b>${escapeHtml(args.studioLabel)}</b> booking${escapeHtml(who)}${escapeHtml(when)}:</p>` +
    `<ul>${itemsHtml}</ul>${truncHtml}</div>`;
  return sendResendEmail({ to, subject, html, text, label: "add-on prep reminder", bookingId: "addon-reminder" });
}

export async function sendConfirmationEmail(booking: BookingDto) {
  const { subject, text, html } = buildConfirmationEmail(booking);
  return sendResendEmail({
    to: booking.guest.email,
    subject,
    text,
    html,
    label: "confirmation",
    bookingId: booking.id,
  });
}

// Entry instructions for a confirmed DIRECT (studioclyx.com) booking. The text
// is the verbatim DB-stored template (door/lockbox codes live only in the DB);
// we just wrap it in a light HTML shell so line breaks survive in email clients.
export async function sendEntryInstructionsEmail(args: {
  to: string;
  bookingId: string;
  text: string;
}) {
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;white-space:pre-wrap;">` +
    `${escapeHtml(args.text)}</div>`;
  return sendResendEmail({
    to: args.to,
    subject: "Studio Clyx — your booking & entry instructions",
    text: args.text,
    html,
    label: "entry instructions",
    bookingId: args.bookingId,
  });
}

export function buildOwnerBookingAlertEmail(booking: BookingDto) {
  const space = SPACE_LABELS[booking.spaceId] ?? booking.spaceId;
  const activity = ACTIVITY_LABELS[booking.activityId];
  const activityLabel = activity?.name ?? booking.activityId;
  const { durationHours, dateLabel, startLabel, endLabel } =
    formatBookingTimes(booking);
  const pricing = computeBookingPricing(booking);
  const totalLabel = `$${pricing.total.toFixed(2)}`;
  const guestName = `${booking.guest.firstName} ${booking.guest.lastName}`.trim();
  const phone = booking.guest.phone || "Not provided";
  const subject = `New Studio Clyx booking hold — ${space} (${dateLabel})`;

  const paymentLine =
    booking.paymentMethod === "card"
      ? `Payment: Credit card via Stripe — auto-confirmed on payment_intent.succeeded webhook.`
      : `Payment expected by Zelle to ${ZELLE_RECIPIENT}. Ask the guest to include booking ID ${booking.id} in the Zelle memo.`;

  const text = [
    "New booking hold received.",
    "",
    `Booking ID:    ${booking.id}`,
    `Guest:         ${guestName}`,
    `Email:         ${booking.guest.email}`,
    `Phone:         ${phone}`,
    `Guests:        ${booking.guestCount}`,
    booking.alcohol ? `Alcohol:       yes ($${ALCOHOL_FEE} fee)` : `Alcohol:       no`,
    `Payment:       ${booking.paymentMethod === "card" ? "Credit card (Stripe)" : "Zelle"}`,
    `Space:         ${space}`,
    `Activity:      ${activityLabel}`,
    `Date:          ${dateLabel}`,
    `Start:         ${startLabel}`,
    `End:           ${endLabel}`,
    `Duration:      ${durationHours} hour${durationHours === 1 ? "" : "s"}`,
    "",
    "Price breakdown:",
    ...formatPriceLinesText(pricing),
    "",
    paymentLine,
    "",
    `Hold window: 1 hour. After that, the slot frees up and a reminder is sent to ${getOwnerReminderRecipient()} if still unpaid.`,
    "",
    `Total: ${totalLabel}`,
  ].join("\n");

  const addonsHtml =
    booking.addons && booking.addons.length > 0
      ? `<tr><td colspan="2" style="padding-top:8px;color:#7A7974;font-size:11px;text-transform:uppercase;letter-spacing:0.12em;">Add-ons</td></tr>` +
        booking.addons
          .map(
            (a) =>
              `<tr><td style="padding:2px 0;font-size:13px;">${escapeHtml(
                a.name
              )} <span style="color:#7A7974;">${
                a.priceType === "flat"
                  ? "(flat)"
                  : `· ${a.quantity} \u00d7 $${a.price.toFixed(2)}`
              }</span></td><td style="padding:2px 0;font-size:13px;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">$${a.lineTotal.toFixed(
                2
              )}</td></tr>`
          )
          .join("")
      : "";

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#F7F6F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#28251D;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F7F6F2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#FBFBF9;border:1px solid #D4D1CA;border-radius:8px;">
        <tr><td style="padding:28px;">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#01696F;font-weight:600;">Studio Clyx</div>
          <h1 style="margin:6px 0 10px 0;font-size:22px;font-weight:600;letter-spacing:-0.01em;color:#28251D;">New booking hold received</h1>
          <p style="margin:0 0 16px 0;font-size:14px;line-height:1.5;color:#28251D;">${
            booking.paymentMethod === "card"
              ? `A guest placed a 1-hour hold and chose to pay by credit card. Once Stripe confirms payment, the booking will be auto-confirmed and the guest will receive the confirmation email.`
              : `A guest placed a 1-hour hold. Confirm payment in the admin panel once the Zelle payment lands. Payment confirmation typically takes ${PAYMENT_WINDOW_LABEL} on the guest's side.`
          }</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;line-height:1.5;">
            ${row("Booking ID", booking.id, true)}
            ${row("Guest", guestName)}
            ${row("Email", booking.guest.email)}
            ${row("Phone", phone)}
            ${row("Guests", String(booking.guestCount))}
            ${row("Alcohol", booking.alcohol ? "yes" : "no")}
            ${row(
              "Payment",
              booking.paymentMethod === "card" ? "Credit card (Stripe)" : "Zelle"
            )}
            ${row("Space", space)}
            ${row("Activity", activityLabel)}
            ${row("Date", dateLabel)}
            ${row("Start", startLabel)}
            ${row("End", endLabel)}
            ${row("Duration", `${durationHours} hour${durationHours === 1 ? "" : "s"}`)}
            ${row("Total", totalLabel)}
          </table>
          <div style="border-top:1px solid #D4D1CA;margin-top:18px;padding-top:18px;">
            <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#7A7974;font-weight:600;">Price breakdown</div>
            <div style="margin-top:8px;">${formatPriceLinesHtml(pricing)}</div>
            ${addonsHtml ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:8px;">${addonsHtml}</table>` : ""}
          </div>
          <div style="border-top:1px solid #D4D1CA;margin-top:18px;padding-top:18px;">
            ${
              booking.paymentMethod === "card"
                ? `<p style="margin:0;font-size:14px;line-height:1.5;">Payment will be auto-confirmed via Stripe <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">payment_intent.succeeded</code> webhook. No manual action required.</p>`
                : `<p style="margin:0;font-size:14px;line-height:1.5;">Payment expected by Zelle to <strong style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(
                    ZELLE_RECIPIENT
                  )}</strong>.</p>
            <p style="margin:6px 0 0 0;font-size:14px;line-height:1.5;">Memo/reference: <strong style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(
                  booking.id
                )}</strong>.</p>`
            }
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

export async function sendOwnerBookingAlert(booking: BookingDto) {
  const recipients = getOwnerAlertRecipients();
  if (recipients.length === 0) {
    console.log(
      `[integrations] simulation (OWNER_ALERT_EMAILS missing): would send owner booking alert for ${booking.id}`
    );
    return { ok: true, mode: "simulation" as const, reason: "OWNER_ALERT_EMAILS missing" };
  }
  const { subject, text, html } = buildOwnerBookingAlertEmail(booking);
  return sendResendEmail({
    to: recipients,
    subject,
    text,
    html,
    label: "owner alert",
    bookingId: booking.id,
  });
}

export function buildOwnerReminderEmail(booking: BookingDto) {
  const space = SPACE_LABELS[booking.spaceId] ?? booking.spaceId;
  const activity = ACTIVITY_LABELS[booking.activityId];
  const activityLabel = activity?.name ?? booking.activityId;
  const { durationHours, dateLabel, startLabel, endLabel } =
    formatBookingTimes(booking);
  const pricing = computeBookingPricing(booking);
  const totalLabel = `$${pricing.total.toFixed(2)}`;
  const guestName = `${booking.guest.firstName} ${booking.guest.lastName}`.trim();
  const phone = booking.guest.phone || "Not provided";
  const subject = `Reminder: unconfirmed booking ${booking.id} — ${space}`;

  const text = [
    `Heads up — booking ${booking.id} is still pending after 1 hour.`,
    "",
    `The hold has expired so the slot is no longer blocked, but the request is still in the system as a pending booking. Review it in the admin console and confirm payment or reject the request.`,
    "",
    `Booking ID:    ${booking.id}`,
    `Guest:         ${guestName}`,
    `Email:         ${booking.guest.email}`,
    `Phone:         ${phone}`,
    `Guests:        ${booking.guestCount}`,
    booking.alcohol ? `Alcohol:       yes` : `Alcohol:       no`,
    `Space:         ${space}`,
    `Activity:      ${activityLabel}`,
    `Date:          ${dateLabel}`,
    `Start:         ${startLabel}`,
    `End:           ${endLabel}`,
    `Duration:      ${durationHours} hour${durationHours === 1 ? "" : "s"}`,
    `Total:         ${totalLabel}`,
    "",
    `Payment expected by Zelle to ${ZELLE_RECIPIENT}. Memo: ${booking.id}.`,
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#F7F6F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#28251D;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F7F6F2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#FBFBF9;border:1px solid #D4D1CA;border-radius:8px;">
        <tr><td style="padding:28px;">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#964219;font-weight:600;">Reminder · Studio Clyx</div>
          <h1 style="margin:6px 0 10px 0;font-size:22px;font-weight:600;letter-spacing:-0.01em;color:#28251D;">Pending booking still unconfirmed</h1>
          <p style="margin:0 0 16px 0;font-size:14px;line-height:1.5;color:#28251D;">${escapeHtml(
            `Booking ${booking.id} is still pending after the 1-hour hold window. The slot is no longer blocked, but the request remains pending until you confirm payment or reject it.`
          )}</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;line-height:1.5;">
            ${row("Booking ID", booking.id, true)}
            ${row("Guest", guestName)}
            ${row("Email", booking.guest.email)}
            ${row("Phone", phone)}
            ${row("Space", space)}
            ${row("Activity", activityLabel)}
            ${row("When", `${dateLabel} \u00b7 ${startLabel} \u2192 ${endLabel}`)}
            ${row("Total", totalLabel)}
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

export async function sendOwnerReminderEmail(booking: BookingDto) {
  const recipient = getOwnerReminderRecipient();
  const { subject, text, html } = buildOwnerReminderEmail(booking);
  return sendResendEmail({
    to: recipient,
    subject,
    text,
    html,
    label: "owner reminder",
    bookingId: booking.id,
  });
}

// ----- Card-flow: slot-taken auto-refund email -----
//
// When a customer pays by card but their slot got grabbed by another channel
// between PI creation and payment_intent.succeeded, the webhook auto-refunds
// the customer and sends this apology email.

export interface SlotTakenRefundEmailArgs {
  to: string;
  guestFirstName: string;
  spaceId: BookingDto["spaceId"];
  start: string;
  end: string;
  refundAmount: number;
  paymentIntentId: string;
}

export async function sendSlotTakenRefundEmail(args: SlotTakenRefundEmailArgs) {
  const space = SPACE_LABELS[args.spaceId] ?? args.spaceId;
  const startDate = new Date(args.start);
  const endDate = new Date(args.end);
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
  const dateLabel = dateFmt.format(startDate);
  const startLabel = timeFmt.format(startDate);
  const endLabel = timeFmt.format(endDate);
  const subject = `Studio Clyx — your card was refunded, slot no longer available`;
  const text = [
    `Hi ${args.guestFirstName},`,
    "",
    `Apologies — between the time you started checkout and when your card cleared, the ${space} slot on ${dateLabel} (${startLabel} → ${endLabel}) was booked through another channel.`,
    "",
    `We've refunded your card the full amount of $${args.refundAmount.toFixed(2)}. The refund will show up in your account in 5–10 business days, depending on your bank.`,
    "",
    `Please head back to https://www.studioclyx.com/book-now to pick a different time. We'd love to host you.`,
    "",
    `Stripe reference: ${args.paymentIntentId}.`,
    "",
    `— Studio Clyx`,
  ].join("\n");
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#F7F6F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#28251D;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F7F6F2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#FBFBF9;border:1px solid #D4D1CA;border-radius:8px;">
        <tr><td style="padding:28px;">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#964219;font-weight:600;">Studio Clyx</div>
          <h1 style="margin:6px 0 10px 0;font-size:22px;font-weight:600;letter-spacing:-0.01em;color:#28251D;">Sorry — your slot was just taken</h1>
          <p style="margin:0 0 14px 0;font-size:14px;line-height:1.55;color:#28251D;">Hi ${escapeHtml(args.guestFirstName)}, apologies — between the moment you started checkout and your card clearing, the ${escapeHtml(space)} slot on ${escapeHtml(dateLabel)} (${escapeHtml(startLabel)} → ${escapeHtml(endLabel)}) was booked through another channel.</p>
          <p style="margin:0 0 14px 0;font-size:14px;line-height:1.55;color:#28251D;">We've issued a full refund of <strong>$${args.refundAmount.toFixed(2)}</strong> to your card. The refund will show in your account in 5–10 business days depending on your bank.</p>
          <p style="margin:0 0 14px 0;font-size:14px;line-height:1.55;color:#28251D;">Please <a href="https://www.studioclyx.com/book-now" style="color:#01696F;font-weight:600;">pick a different time</a> — we'd love to host you.</p>
          <p style="margin:18px 0 0 0;font-size:11px;color:#7A7974;line-height:1.5;">Stripe reference: ${escapeHtml(args.paymentIntentId)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return sendResendEmail({
    to: args.to,
    subject,
    text,
    html,
    label: "slot-taken refund",
    bookingId: args.paymentIntentId,
  });
}

// ----- Sweeper: handles hold expiry + reminder dispatch -----

export type SweeperHooks = {
  expireHolds: (now: number) => Promise<{ expired: BookingDto[] }>;
  listOverdueReminderTargets: (now: number) => Promise<BookingDto[]>;
  markReminderSent: (id: string, now: number) => Promise<void>;
  onHoldExpired?: (booking: BookingDto) => Promise<void> | void;
};

export function startHoldExpirySweeper(hooks: SweeperHooks) {
  // Run every 60s.
  const interval = setInterval(async () => {
    const now = Date.now();
    try {
      const { expired } = await hooks.expireHolds(now);
      if (expired.length > 0) {
        console.log(
          `[integrations] hold sweeper: marked ${expired.length} hold(s) inactive`
        );
        if (hooks.onHoldExpired) {
          for (const b of expired) {
            try {
              await hooks.onHoldExpired(b);
            } catch (e) {
              console.error("[integrations] sweeper expired hook error", e);
            }
          }
        }
      }
    } catch (e) {
      console.error("[integrations] hold sweeper error:", e);
    }
    try {
      const overdue = await hooks.listOverdueReminderTargets(now);
      for (const b of overdue) {
        try {
          await sendOwnerReminderEmail(b);
        } catch (e) {
          console.error("[integrations] reminder send error", e);
        }
        try {
          await hooks.markReminderSent(b.id, now);
        } catch (e) {
          console.error("[integrations] reminder markSent error", e);
        }
      }
      if (overdue.length > 0) {
        console.log(
          `[integrations] reminder sweeper: dispatched ${overdue.length} owner reminder(s)`
        );
      }
    } catch (e) {
      console.error("[integrations] reminder sweeper error:", e);
    }
  }, 60_000);
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
