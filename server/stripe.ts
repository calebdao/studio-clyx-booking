// Studio Clyx — Stripe (card payments).
//
// Customers may pay with Zelle (no fee) or credit card. When card is chosen,
// the customer absorbs the Stripe fee via a transparent surcharge line item.
// The actual charge sent to Stripe is the grossed-up amount so the merchant
// nets the original booking total.
//
// This module follows the same "simulation mode" convention as the other
// integrations in `server/integrations.ts`: when STRIPE_SECRET_KEY is missing,
// every call short-circuits to a structured log line and returns a synthetic
// response. That keeps local dev and CI green without forcing every developer
// to plug in real Stripe credentials.

import Stripe from "stripe";
import type { BookingDto, SelectedAddOn } from "@shared/schema";
import { computeCardSurcharge } from "@shared/schema";
import { computeBookingPricing } from "./integrations";

let _stripe: Stripe | null = null;
let _stripeInitError: string | null = null;

export function getStripeClient(): Stripe | null {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    _stripe = new Stripe(key, {
      // Pin the API version so behavior is stable across Stripe SDK updates.
      // 2024-06-20 is the latest stable that supports automatic payment methods
      // and Payment Element.
      apiVersion: "2024-06-20" as Stripe.StripeConfig["apiVersion"],
      appInfo: { name: "studio-clyx-booking", version: "1.0.0" },
    });
    _stripeInitError = null;
    return _stripe;
  } catch (e) {
    _stripeInitError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

export function getStripeInitError(): string | null {
  return _stripeInitError;
}

export function getStripePublishableKey(): string | null {
  const k = process.env.STRIPE_PUBLISHABLE_KEY;
  return k && k.trim().length > 0 ? k : null;
}

export function stripeStatus() {
  const secretConfigured = Boolean(process.env.STRIPE_SECRET_KEY);
  const publishableConfigured = Boolean(getStripePublishableKey());
  const webhookConfigured = Boolean(process.env.STRIPE_WEBHOOK_SECRET);
  const initError = _stripeInitError;
  const mode =
    secretConfigured && publishableConfigured && !initError
      ? "live"
      : "simulation";
  return {
    name: "Stripe",
    mode,
    credentialEnv: "STRIPE_SECRET_KEY",
    credentialConfigured: secretConfigured,
    publishableKeyEnv: "STRIPE_PUBLISHABLE_KEY",
    publishableKeyConfigured: publishableConfigured,
    webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
    webhookSecretConfigured: webhookConfigured,
    initError,
    // What the customer is told about the surcharge formula. Returned to the
    // client so the booking form can render an accurate live preview.
    feePercent: 0.029,
    feeFixed: 0.3,
  } as const;
}

export interface CreatePaymentIntentResult {
  ok: boolean;
  mode: "live" | "simulation";
  clientSecret?: string;
  publishableKey?: string;
  paymentIntentId?: string;
  amount?: number; // cents
  baseTotal?: number; // dollars
  cardFeeAmount?: number; // dollars
  customerTotal?: number; // dollars
  reason?: string;
  error?: string;
}

/**
 * Create (or retrieve+update) a Stripe PaymentIntent for a booking. Idempotent:
 * if the booking already has a PaymentIntent id we update its amount instead of
 * creating a duplicate, so re-opening the dialog doesn't fan out PIs.
 */
export async function createPaymentIntentForBooking(
  booking: BookingDto
): Promise<CreatePaymentIntentResult> {
  const pricing = computeBookingPricing(booking);
  // IMPORTANT: pricing.total already includes the card fee line when the
  // booking is on `paymentMethod: "card"`. We must surcharge the *subtotal*
  // (everything except the card fee) so the fee is counted exactly once.
  const baseTotal = pricing.subtotal;
  // Re-compute the surcharge here so the amount Stripe sees always matches the
  // shared formula. We could trust the row but recomputing is cheap and
  // guarantees no drift if Stripe fee constants change later.
  const cardFeeAmount = computeCardSurcharge(baseTotal);
  const customerTotal = Math.round((baseTotal + cardFeeAmount) * 100) / 100;
  const amountCents = Math.round(customerTotal * 100);

  const stripe = getStripeClient();
  if (!stripe) {
    console.log(
      `[stripe] simulation: would create PaymentIntent for ${booking.id} amount=$${customerTotal.toFixed(
        2
      )} (base $${baseTotal.toFixed(2)} + card fee $${cardFeeAmount.toFixed(2)})`
    );
    return {
      ok: true,
      mode: "simulation",
      reason: process.env.STRIPE_SECRET_KEY
        ? _stripeInitError ?? "Stripe init failed"
        : "STRIPE_SECRET_KEY missing",
      baseTotal,
      cardFeeAmount,
      customerTotal,
      amount: amountCents,
      // Synthetic clientSecret + paymentIntentId so the dev UI can still render
      // a disabled Stripe Element shell and the flow can be smoke-tested without
      // real Stripe credentials.
      paymentIntentId: `pi_sim_${booking.id}`,
      clientSecret: `pi_sim_${booking.id}_secret_simulation`,
      publishableKey: getStripePublishableKey() ?? undefined,
    };
  }

  try {
    const existingId = booking.stripePaymentIntentId;
    let pi: Stripe.PaymentIntent;
    if (existingId && existingId.startsWith("pi_") && !existingId.startsWith("pi_sim_")) {
      pi = await stripe.paymentIntents.update(existingId, {
        amount: amountCents,
        metadata: {
          bookingId: booking.id,
          spaceId: booking.spaceId,
          activityId: booking.activityId,
          baseTotal: baseTotal.toFixed(2),
          cardFeeAmount: cardFeeAmount.toFixed(2),
          customerTotal: customerTotal.toFixed(2),
        },
      });
    } else {
      pi = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        description: `Studio Clyx booking ${booking.id} (${booking.spaceId} · ${booking.activityId})`,
        receipt_email: booking.guest.email,
        metadata: {
          bookingId: booking.id,
          spaceId: booking.spaceId,
          activityId: booking.activityId,
          baseTotal: baseTotal.toFixed(2),
          cardFeeAmount: cardFeeAmount.toFixed(2),
          customerTotal: customerTotal.toFixed(2),
        },
      });
    }
    console.log(
      `[stripe] PaymentIntent ${pi.id} ready for ${booking.id} amount=$${customerTotal.toFixed(2)}`
    );
    return {
      ok: true,
      mode: "live",
      clientSecret: pi.client_secret ?? undefined,
      paymentIntentId: pi.id,
      publishableKey: getStripePublishableKey() ?? undefined,
      amount: amountCents,
      baseTotal,
      cardFeeAmount,
      customerTotal,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[stripe] PaymentIntent create/update failed for ${booking.id}: ${msg}`
    );
    return {
      ok: false,
      mode: "live",
      error: msg,
      baseTotal,
      cardFeeAmount,
      customerTotal,
    };
  }
}

// ---------------------------------------------------------------------------
// "Draft" PaymentIntent flow (no DB row until the customer pays).
//
// For card bookings we don't reserve the slot up front. We just create a
// PaymentIntent with the full booking spec encoded in metadata, render the
// Stripe Element, and only insert the booking row when the webhook reports
// `payment_intent.succeeded`. If during that window another customer grabs
// the slot via Zelle (or Peerspace/Giggster), the webhook handler auto-refunds
// the card and emails an apology.
// ---------------------------------------------------------------------------

export interface CardBookingDraft {
  spaceId: BookingDto["spaceId"];
  activityId: BookingDto["activityId"];
  start: string; // ISO
  end: string; // ISO
  guest: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
  };
  guestCount: number;
  alcohol: boolean;
  addons: SelectedAddOn[];
  baseTotal: number; // dollars (no card fee), already promo-discounted
  promoCode?: string | null;
}

export interface CreateDraftPaymentIntentResult {
  ok: boolean;
  mode: "live" | "simulation";
  clientSecret?: string;
  publishableKey?: string;
  paymentIntentId?: string;
  baseTotal: number;
  cardFeeAmount: number;
  customerTotal: number;
  reason?: string;
  error?: string;
}

// Stripe caps each metadata value at 500 chars. Encoding all add-ons into ONE
// JSON string and slicing it to fit (the old approach) could truncate mid-item,
// which made the webhook's JSON.parse throw and SILENTLY DROP A PAID BOOKING.
// Instead we encode add-ons as compact "id:qty" tokens and spill across numbered
// keys (addons, addons2, ...), splitting only on item boundaries — never mid-item.
// addOnIds are `ao-<digits>-<base36>` / `ao-seed-N` (no ':' or ','), so the
// delimiter scheme is unambiguous.
const ADDON_META_CHUNK_MAX = 480;

function encodeAddonsMetadata(addons: SelectedAddOn[]): Record<string, string> {
  const tokens = addons.map((a) => `${a.addOnId}:${a.quantity}`);
  const chunks: string[] = [];
  let cur = "";
  for (const t of tokens) {
    const next = cur ? `${cur},${t}` : t;
    if (next.length > ADDON_META_CHUNK_MAX) {
      if (cur) chunks.push(cur);
      cur = t; // a single token is ~30 chars, always under the cap
    } else {
      cur = next;
    }
  }
  if (cur) chunks.push(cur);
  const out: Record<string, string> = { addonsCount: String(addons.length) };
  chunks.forEach((c, i) => {
    out[i === 0 ? "addons" : `addons${i + 1}`] = c;
  });
  return out;
}

/**
 * Tolerantly decode the add-ons packed into PaymentIntent metadata. Handles the
 * new compact chunked "id:qty" format AND the legacy single-JSON format —
 * including a TRUNCATED legacy JSON string from the old buggy encoder, from
 * which we salvage every complete {"addOnId":...,"quantity":N} object. Never
 * throws, so a paid booking is never dropped over a metadata quirk.
 */
export function decodeAddonsMetadata(
  metadata: Record<string, string>
): Array<{ addOnId: string; quantity: number }> {
  const parts: string[] = [];
  if (metadata.addons) parts.push(metadata.addons);
  for (let i = 2; metadata[`addons${i}`] != null; i++) {
    parts.push(metadata[`addons${i}`]);
  }
  const joined = parts.join(",").trim();
  if (!joined) return [];

  // Legacy JSON format begins with "[".
  if (joined.startsWith("[")) {
    try {
      const parsed = JSON.parse(joined);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((a) => a && typeof a.addOnId === "string")
          .map((a) => ({
            addOnId: a.addOnId as string,
            quantity: Number(a.quantity) || 1,
          }));
      }
    } catch {
      // Truncated/malformed — fall through and salvage complete objects.
    }
    const salvaged: Array<{ addOnId: string; quantity: number }> = [];
    const re = /\{"addOnId":"([^"]+)","quantity":(\d+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(joined))) {
      salvaged.push({ addOnId: m[1], quantity: Number(m[2]) || 1 });
    }
    return salvaged;
  }

  // New compact "id:qty,id:qty" format.
  const out: Array<{ addOnId: string; quantity: number }> = [];
  for (const tok of joined.split(",")) {
    const t = tok.trim();
    if (!t) continue;
    const idx = t.lastIndexOf(":");
    if (idx <= 0) continue;
    const id = t.slice(0, idx);
    const qty = Number(t.slice(idx + 1));
    if (id && Number.isFinite(qty) && qty > 0) {
      out.push({ addOnId: id, quantity: qty });
    }
  }
  return out;
}

/**
 * Stripe metadata limits: 50 keys, value max 500 chars, total ≤ 8KB. Names/
 * email/phone are truncated defensively; add-ons are chunked (see
 * encodeAddonsMetadata) so they can never truncate mid-item.
 */
function encodeDraftMetadata(draft: CardBookingDraft, cardFeeAmount: number) {
  const customerTotal = Math.round((draft.baseTotal + cardFeeAmount) * 100) / 100;
  return {
    bookingDraft: "1",
    spaceId: draft.spaceId,
    activityId: draft.activityId,
    start: draft.start,
    end: draft.end,
    guestFirstName: draft.guest.firstName.slice(0, 80),
    guestLastName: draft.guest.lastName.slice(0, 80),
    guestEmail: draft.guest.email.slice(0, 200),
    guestPhone: (draft.guest.phone ?? "").slice(0, 40),
    guestCount: String(draft.guestCount),
    alcohol: draft.alcohol ? "1" : "0",
    ...encodeAddonsMetadata(draft.addons),
    baseTotal: draft.baseTotal.toFixed(2),
    cardFeeAmount: cardFeeAmount.toFixed(2),
    customerTotal: customerTotal.toFixed(2),
    ...(draft.promoCode ? { promoCode: draft.promoCode.slice(0, 40) } : {}),
  } as Record<string, string>;
}

export interface DecodedDraftMetadata {
  spaceId: BookingDto["spaceId"];
  activityId: BookingDto["activityId"];
  start: string;
  end: string;
  guest: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
  };
  guestCount: number;
  alcohol: boolean;
  addons: Array<{ addOnId: string; quantity: number }>;
  baseTotal: number;
  cardFeeAmount: number;
  customerTotal: number;
  promoCode?: string | null;
}

export function decodeDraftMetadata(
  metadata: Record<string, string> | undefined
): DecodedDraftMetadata | null {
  if (!metadata || metadata.bookingDraft !== "1") return null;
  try {
    return {
      spaceId: metadata.spaceId as BookingDto["spaceId"],
      activityId: metadata.activityId as BookingDto["activityId"],
      start: metadata.start,
      end: metadata.end,
      guest: {
        firstName: metadata.guestFirstName,
        lastName: metadata.guestLastName,
        email: metadata.guestEmail,
        phone: metadata.guestPhone || undefined,
      },
      guestCount: Number(metadata.guestCount) || 1,
      alcohol: metadata.alcohol === "1",
      addons: decodeAddonsMetadata(metadata),
      baseTotal: Number(metadata.baseTotal) || 0,
      cardFeeAmount: Number(metadata.cardFeeAmount) || 0,
      customerTotal: Number(metadata.customerTotal) || 0,
      promoCode: metadata.promoCode || null,
    };
  } catch (e) {
    console.error("[stripe] decodeDraftMetadata failed", e);
    return null;
  }
}

export async function createDraftPaymentIntent(
  draft: CardBookingDraft
): Promise<CreateDraftPaymentIntentResult> {
  const cardFeeAmount = computeCardSurcharge(draft.baseTotal);
  const customerTotal =
    Math.round((draft.baseTotal + cardFeeAmount) * 100) / 100;
  const amountCents = Math.round(customerTotal * 100);

  const stripe = getStripeClient();
  if (!stripe) {
    console.log(
      `[stripe] simulation: would create draft PaymentIntent for ${draft.spaceId}@${draft.start} amount=$${customerTotal.toFixed(
        2
      )}`
    );
    return {
      ok: true,
      mode: "simulation",
      reason: process.env.STRIPE_SECRET_KEY
        ? _stripeInitError ?? "Stripe init failed"
        : "STRIPE_SECRET_KEY missing",
      baseTotal: draft.baseTotal,
      cardFeeAmount,
      customerTotal,
      paymentIntentId: `pi_sim_draft_${Date.now()}`,
      clientSecret: `pi_sim_draft_${Date.now()}_secret_simulation`,
      publishableKey: getStripePublishableKey() ?? undefined,
    };
  }

  try {
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      automatic_payment_methods: { enabled: true },
      description: `Studio Clyx booking draft (${draft.spaceId} · ${draft.activityId})`,
      receipt_email: draft.guest.email,
      metadata: encodeDraftMetadata(draft, cardFeeAmount),
    });
    console.log(
      `[stripe] draft PaymentIntent ${pi.id} created for ${draft.guest.email} amount=$${customerTotal.toFixed(2)}`
    );
    return {
      ok: true,
      mode: "live",
      clientSecret: pi.client_secret ?? undefined,
      paymentIntentId: pi.id,
      publishableKey: getStripePublishableKey() ?? undefined,
      baseTotal: draft.baseTotal,
      cardFeeAmount,
      customerTotal,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[stripe] draft PaymentIntent create failed: ${msg}`);
    return {
      ok: false,
      mode: "live",
      error: msg,
      baseTotal: draft.baseTotal,
      cardFeeAmount,
      customerTotal,
    };
  }
}

/**
 * Verify a Stripe webhook request and return the parsed event. Requires the
 * raw request body buffer (captured in server/index.ts via express.json's
 * `verify` callback). Returns null when Stripe is not configured or when
 * signature verification fails.
 */
export function constructWebhookEvent(args: {
  rawBody: Buffer | string | undefined;
  signature: string | undefined;
}): { ok: true; event: Stripe.Event } | { ok: false; error: string } {
  const stripe = getStripeClient();
  if (!stripe) {
    return { ok: false, error: "Stripe not configured" };
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return { ok: false, error: "STRIPE_WEBHOOK_SECRET missing" };
  }
  if (!args.rawBody || !args.signature) {
    return { ok: false, error: "Missing raw body or signature header" };
  }
  try {
    const event = stripe.webhooks.constructEvent(
      args.rawBody,
      args.signature,
      secret
    );
    return { ok: true, event };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Refund a successful PaymentIntent. Returns the refund id. Used by admin
 * cancel flow later; exposed now so the path is wired up end-to-end.
 */
export async function refundPaymentIntent(
  paymentIntentId: string,
  reason?: "requested_by_customer" | "duplicate" | "fraudulent"
): Promise<{ ok: boolean; refundId?: string; error?: string }> {
  const stripe = getStripeClient();
  if (!stripe) {
    console.log(`[stripe] simulation: would refund ${paymentIntentId}`);
    return { ok: true };
  }
  try {
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      reason,
    });
    console.log(
      `[stripe] refund ${refund.id} created for PaymentIntent ${paymentIntentId} (${refund.status})`
    );
    return { ok: true, refundId: refund.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[stripe] refund failed for ${paymentIntentId}: ${msg}`);
    return { ok: false, error: msg };
  }
}
