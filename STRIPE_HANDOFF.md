# Studio Clyx — Stripe payments (card option with customer-borne surcharge)

This document covers the Stripe integration added on 2026-05-26. It explains the change, the math, every file touched, the Render env vars you need to set, the Stripe Dashboard configuration (webhook + restricted key), and the verification steps to take before flipping it on.

## Status

- `npx tsc --noEmit` — clean (zero errors).
- `npm run build` — succeeds (client ~426 kB JS gz 135 kB, server bundle ~1.0 MB).
- Gross-up math verified numerically: for every test base total (200, 240, 500, 1234.56), the merchant nets the base to the cent after Stripe takes 2.9% + $0.30.
- Server runtime smoke test couldn't fully boot in the sandbox (the `better-sqlite3` native binding isn't rebuilt for the sandbox's arch); the boot path is covered by typecheck + build. Real verification happens on Render after deploy.

## What the customer sees

1. On the booking form they see a "Payment method" picker with two options: **Zelle (no fee)** and **Credit card (+X processing fee)**. The card option's chip shows the live fee — the second they pick card, the breakdown gets a new "Card processing fee" line and the total updates.
2. They click "Book now". A hold is created exactly as before; the only difference is `paymentMethod` is sent with the request and the server stores both the chosen method and (if card) the exact fee that was previewed.
3. The confirmation dialog branches:
   - **Zelle**: identical to today — Zelle email, copy button, 1-hour hold.
   - **Card**: a Stripe `PaymentElement` is rendered inline inside the dialog. The customer enters their card and pays. On success, the dialog flips to a "payment received" state.
4. Behind the scenes, Stripe's `payment_intent.succeeded` webhook fires and the server runs the *same* confirm chain the admin button uses: status → confirmed, `[HOLD]` Google event patched to confirmed, customer confirmation email sent.

## What the operator (admin) sees

- Every booking row in the admin tab now shows a small `zelle` / `card · pending` / `card · paid` badge so you can tell at a glance which channel the payment came through.
- The Confirm dialog shows the payment method and (for card) whether Stripe has confirmed it.
- The owner alert email now includes a "Payment:" line so you know whether to expect a Zelle deposit or just wait for the webhook.

## The math

Stripe's US card fee is **2.9% + $0.30 per successful charge**. To make the customer cover the fee, we gross up the amount Stripe sees so the merchant nets the original total:

```
gross    = (base + 0.30) / (1 - 0.029)
surcharge = gross - base
```

A worked example for a $500 booking:

| Line                           | Amount |
| ------------------------------ | ------ |
| Booking subtotal               | 500.00 |
| Card processing fee (2.9%+30¢) |  15.24 |
| Customer pays via Stripe       | 515.24 |
| Stripe takes (2.9% × 515.24 + 0.30) |  15.24 |
| Studio Clyx receives           | 500.00 |

This formula lives in **one place** as a constant and a helper: `STRIPE_FEE_PERCENT`, `STRIPE_FEE_FIXED`, `computeCardSurcharge(baseTotal)`. It's exported from `shared/schema.ts` so the server and client use exactly the same numbers. The server is authoritative — the client-side preview is mirrored math.

## Files changed / added

### New

- **`server/stripe.ts`** — Stripe client, status, `createPaymentIntentForBooking`, webhook signature verification, `refundPaymentIntent`. Idempotent: re-opening the dialog updates the existing PaymentIntent's amount instead of creating a new one. Falls back to simulation mode (logs, synthetic `pi_sim_…` ids) when `STRIPE_SECRET_KEY` is not set.
- **`client/src/components/stripe-payment.tsx`** — `<StripePaymentBlock>` wraps `@stripe/react-stripe-js` `<Elements>` + `<PaymentElement>`. Handles `redirect: 'if_required'` so most cards confirm inline; 3DS redirects to `#/?paid=<bookingId>` and the user comes back to a "thanks" state. Renders a clearly-labeled simulation placeholder when keys aren't set.

### Modified

- **`shared/schema.ts`** — added `paymentMethod`, `cardFeeAmount`, `paidAt`, `stripePaymentIntentId` columns to the `bookings` schema; added Stripe fee constants and `computeCardSurcharge` helper; widened `bookingDtoSchema` and `createHoldSchema` to include `paymentMethod`.
- **`server/storage.ts`** — idempotent ALTER TABLE for the four new columns (existing Render `data.db` is preserved); `createHold` now reads `paymentMethod` from the input, computes the surcharge server-side from the live activity rate + addons, and persists it on the row. New methods: `setStripePaymentIntent`, `findBookingByStripePaymentIntent`, `markPaid`. Local pricing helper (`computeServerBaseTotal`) mirrors the constants from `@shared/schema` so we don't drift.
- **`server/integrations.ts`** — `PriceSummary` now exposes `cardFee` + `subtotal` alongside `total`; `computeBookingPricing` adds a card-fee line when `paymentMethod === "card"`. Confirmation + owner-alert emails now branch on payment method — Zelle path is untouched; card path swaps in receipt-style wording.
- **`server/routes.ts`** — extracted the existing confirm chain into a shared `runConfirmChain(bookingId)` so the admin button and the Stripe webhook do the same thing. New routes: `GET /api/stripe/config` (public — returns publishable key + fee constants), `POST /api/bookings/:id/stripe/intent` (creates/updates the PaymentIntent for a booking), `POST /api/webhooks/stripe` (verifies signature, handles `payment_intent.succeeded` → confirm chain; idempotent on retries). `/api/integrations/status` now includes a `stripe` block.
- **`client/src/lib/booking-data.ts`** — `PaymentMethod` type, `STRIPE_FEE_PERCENT`/`STRIPE_FEE_FIXED`/`computeCardSurcharge`. `PriceBreakdown` carries `subtotal` + `cardFee` + `total`. `computePriceBreakdown` adds the card-fee line.
- **`client/src/lib/booking-store.tsx`** — `CreateHoldClientInput` now includes `paymentMethod`. New hook `useStripeConfig()` and helper `fetchStripeIntentForBooking(id)`.
- **`client/src/pages/book.tsx`** — new `<PaymentMethodPicker>` block in the right-rail summary; `handleBookNow` threads `paymentMethod` and, when card is chosen, calls `fetchStripeIntentForBooking` immediately after the hold is created so the dialog opens with the Stripe Element ready to mount. Confirmation dialog branches on method.
- **`client/src/pages/admin.tsx`** — every booking row gets a payment-method badge; the confirm modal shows a "Payment" row; the admin breakdown threads `paymentMethod` so the displayed totals match what the customer was charged.
- **`package.json`** — adds `stripe`, `@stripe/stripe-js`, `@stripe/react-stripe-js`. (`stripe` was already in the build allowlist, so no `script/build.ts` changes were needed.)

## Database migration

On the next boot, `server/storage.ts` will run `ALTER TABLE bookings ADD COLUMN ...` for each new column. The function uses `PRAGMA table_info()` to skip columns that already exist, so this is idempotent and safe to run against the live Render `data.db` (any existing rows just get `payment_method='zelle'`, `card_fee_amount=0`, `paid_at=NULL`, `stripe_payment_intent_id=NULL`). No `drizzle-kit push` required.

## Render — env vars to set

Set these in Render → Environment Variables. After setting them, redeploy via Manual Deploy → Deploy latest commit (a restart alone doesn't reliably pick up new env values, per the existing `claude.md` note).

```
STRIPE_SECRET_KEY=sk_live_…           # or sk_test_… for staging
STRIPE_PUBLISHABLE_KEY=pk_live_…      # or pk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…         # see "Stripe Dashboard" below
```

All three must be set for `/api/integrations/status` to report `stripe.mode === "live"`. Without them the app stays usable — Zelle works as today, and choosing card shows a "simulation mode" placeholder.

## Stripe Dashboard — one-time setup

1. **Create a restricted key, not the standard secret key.** Dashboard → Developers → API keys → "Create restricted key". Grant write on `PaymentIntents` and `Refunds`, read on `Webhook Endpoints`. Paste it into `STRIPE_SECRET_KEY`. This limits blast radius if the key ever leaks.
2. **Add the webhook endpoint.** Dashboard → Developers → Webhooks → "Add endpoint":
   - URL: `https://studio-clyx-booking.onrender.com/api/webhooks/stripe`
   - Events: at minimum `payment_intent.succeeded`. Also subscribe to `payment_intent.payment_failed` (we log it).
   - Copy the resulting signing secret into `STRIPE_WEBHOOK_SECRET`.
3. **Verify card surcharging rules for your region.** Card surcharging is legal in NY at up to the actual cost of acceptance (Stripe's 2.9% + $0.30 is well within that ceiling). Visa/Mastercard require the surcharge to be (a) disclosed at point of sale (the booking form line item satisfies this) and (b) registered with the card networks 30 days before you start. Stripe surfaces a "Surcharging" capability under Settings → Payments → Surcharging — turn it on. If you'd rather not register, the alternative is to keep the line item but call it a "convenience fee", which has slightly different rules. I'd default to the formal "surcharge" path since you're already itemizing it.

## Render — webhook reachability

Your Render service is publicly addressable at `https://studio-clyx-booking.onrender.com` so Stripe can hit the webhook directly. **Important:** if Render's free tier is still in use, cold starts take ~50–60s. Stripe will retry webhooks with exponential backoff for up to 3 days, so a single cold-start delay isn't a problem, but if you're on free tier you may want to graduate to a paid Render instance now that money is moving through.

The Squarespace iframe is irrelevant to the webhook — Stripe calls the Render origin directly, not the embedded view.

## Verification checklist (run on Render after deploy)

1. `curl https://studio-clyx-booking.onrender.com/api/integrations/status` — `stripe.mode` should read `"live"`.
2. `curl https://studio-clyx-booking.onrender.com/api/stripe/config` — `publishableKey` should match what you set, and not be `null`.
3. In Stripe Dashboard → Developers → Webhooks → your endpoint → "Send test event" → `payment_intent.succeeded`. Check Render logs for `[stripe] webhook payment_intent.succeeded received but no booking id resolvable for PI pi_test_…` — that's the expected response for a test event (no matching booking in your DB), and it tells you signature verification is working.
4. End-to-end on the live site, with Stripe in **test mode** first:
   - Place a Card booking with the Stripe test card `4242 4242 4242 4242`.
   - Verify the dialog flips to "Payment received".
   - Verify Stripe Dashboard shows the charge with metadata `bookingId`, `baseTotal`, `cardFeeAmount`, `customerTotal`.
   - Verify the booking flips to `confirmed` in `/#/admin` and the `[HOLD]` Google Calendar event is patched.
   - Verify the customer confirmation email arrives with the "Charged to your card via Stripe" copy.
5. Try a 3DS test card (`4000 0027 6000 3184`) — the redirect should return to `/#/?paid=<bookingId>` and the dialog should still show "payment received" if you re-open it.
6. Flip Stripe to **live mode** keys only after all the above passes.

## What this does NOT change

- Existing Zelle flow is untouched. Customers who pick Zelle (the default) see exactly the same thing they see today.
- Existing admin confirm button still works — both manual confirm and webhook-driven confirm run the same `runConfirmChain`, so a card booking that for any reason doesn't auto-confirm via webhook can still be confirmed by the operator.
- The cancellation policy is unchanged. Refunds via Stripe are a one-line API call (`refundPaymentIntent` is exposed in `server/stripe.ts` and ready to be wired to an admin "Cancel booking" button when that feature ships).
- Add-on catalog, hold lifecycle, owner reminder email, Google Calendar conflict detection — all unchanged.

## Known follow-ups (not blockers for shipping Stripe)

1. **Admin "Cancel booking" button**: `refundPaymentIntent` is already exported. Hook it up when the cancel feature lands so refunds match the cancellation policy (full / 50% / 0%).
2. **Audit log**: track who confirmed each booking and whether confirm came from admin or webhook. Useful for disputes later.
3. **Postgres migration**: still flagged in `claude.md`. With money flowing through, the SQLite-on-Render risk goes up. Recommend doing this before adding the customer DB + newsletter (feature #2 in the user's roadmap), since that's the next batch of writes.
4. **PaymentIntent retention**: if a customer abandons the dialog and the hold expires, the PaymentIntent stays open on Stripe's side for 24h. They're not charged, but it shows in the Stripe Dashboard as "incomplete". Optional cleanup: when `expireHolds` flips a card booking to inactive, also call `paymentIntents.cancel`. Not urgent.

## Cost / risk summary

- **Cost to studio**: zero per transaction. The whole point is that the customer absorbs the Stripe fee. The only ongoing Stripe cost would come from refunds (Stripe doesn't refund their 30¢ fixed fee on refunds) — in practice that's a tiny cost the policy already captures via the non-refundable windows.
- **Risk surface**: PCI scope stays minimal (Stripe Elements means card data never touches your server). The webhook is the most security-sensitive new endpoint; signature verification is enforced and will reject any unsigned/wrong-secret request with a 400. The new env vars must not be committed.
