import { useEffect, useMemo, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import { CreditCard, ShieldCheck } from "lucide-react";

// Cache the Stripe.js promise per publishable key so we don't re-load the
// script on every component mount.
const stripePromiseCache = new Map<string, Promise<Stripe | null>>();
function getStripePromise(publishableKey: string) {
  let p = stripePromiseCache.get(publishableKey);
  if (!p) {
    p = loadStripe(publishableKey);
    stripePromiseCache.set(publishableKey, p);
  }
  return p;
}

export interface StripePaymentBlockProps {
  // Returned by POST /api/bookings/:id/stripe/intent
  clientSecret: string;
  publishableKey: string | null;
  // Total the customer will be charged (in dollars, already includes card fee)
  customerTotal: number;
  // Card surcharge being passed through (in dollars)
  cardFeeAmount: number;
  // Booking id for the form's return_url
  bookingId: string;
  // Simulation banner — when server is in simulation mode, we can't render
  // a real Stripe Element. Show a helpful placeholder instead so QA still
  // sees the flow shape.
  simulationMode?: boolean;
  // Notified once Stripe reports payment_intent.succeeded client-side. The
  // server webhook also fires (and is the source of truth). This is mostly
  // used to flip the dialog into a "thanks, look out for the confirmation
  // email" state.
  onSuccess?: () => void;
}

/**
 * StripePaymentBlock renders the Stripe PaymentElement inside its own
 * <Elements> provider. The provider needs to be rebuilt whenever the
 * clientSecret changes, so we key the inner form on it.
 */
export function StripePaymentBlock(props: StripePaymentBlockProps) {
  // Simulation: no publishable key, or the server told us we're in simulation
  // mode. Render a static placeholder so the booking flow stays usable in dev.
  if (props.simulationMode || !props.publishableKey) {
    return (
      <div className="rounded-md border border-card-border bg-background/50 p-4">
        <div className="text-eyebrow text-primary mb-2 flex items-center gap-1.5">
          <CreditCard className="w-3.5 h-3.5" /> Credit card payment
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Card payment is in <strong>simulation mode</strong> in this environment.
          Once Stripe keys are configured on Render
          (<code className="font-mono text-[10px]">STRIPE_SECRET_KEY</code>,{" "}
          <code className="font-mono text-[10px]">STRIPE_PUBLISHABLE_KEY</code>,{" "}
          <code className="font-mono text-[10px]">STRIPE_WEBHOOK_SECRET</code>),
          the Stripe Element will render here and charge{" "}
          <strong>${props.customerTotal.toFixed(2)}</strong> (includes $
          {props.cardFeeAmount.toFixed(2)} card processing fee).
        </p>
      </div>
    );
  }
  const stripe = getStripePromise(props.publishableKey);
  return (
    <Elements
      stripe={stripe}
      options={{
        clientSecret: props.clientSecret,
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: "#01696F",
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          },
        },
      }}
      key={props.clientSecret}
    >
      <InnerForm
        customerTotal={props.customerTotal}
        cardFeeAmount={props.cardFeeAmount}
        bookingId={props.bookingId}
        onSuccess={props.onSuccess}
      />
    </Elements>
  );
}

function InnerForm({
  customerTotal,
  cardFeeAmount,
  bookingId,
  onSuccess,
}: {
  customerTotal: number;
  cardFeeAmount: number;
  bookingId: string;
  onSuccess?: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  const returnUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    // 3DS redirects come back here. Hash-routing app, so we land on /#/admin? No:
    // the booking page lives at /#/ so we just send them back to root.
    const url = new URL(window.location.href);
    url.hash = `#/?paid=${encodeURIComponent(bookingId)}`;
    return url.toString();
  }, [bookingId]);

  // If we already succeeded, surface a thank-you state.
  useEffect(() => {
    if (succeeded) onSuccess?.();
  }, [succeeded, onSuccess]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setErrorMessage(null);
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
      redirect: "if_required",
    });
    if (error) {
      setErrorMessage(error.message ?? "Could not process card.");
      setSubmitting(false);
      return;
    }
    if (paymentIntent && paymentIntent.status === "succeeded") {
      setSucceeded(true);
      setSubmitting(false);
      return;
    }
    if (paymentIntent && paymentIntent.status === "processing") {
      // Bank is taking a moment; the webhook will confirm.
      setSucceeded(true);
      setSubmitting(false);
      return;
    }
    setErrorMessage("Payment did not complete. Please try again.");
    setSubmitting(false);
  }

  if (succeeded) {
    return (
      <div className="rounded-md border border-primary/30 bg-primary/5 p-4">
        <div className="text-eyebrow text-primary mb-1 flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5" /> Payment received
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Thanks — your card was charged ${customerTotal.toFixed(2)}. We've sent a
          receipt by email and your booking will be confirmed once the payment
          processes (usually under a minute). You'll receive a confirmation
          email from Studio Clyx shortly.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-md border border-card-border bg-background/50 p-4"
      data-testid="form-stripe-payment"
    >
      <div className="text-eyebrow text-primary mb-2 flex items-center gap-1.5">
        <CreditCard className="w-3.5 h-3.5" /> Credit card payment
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed mb-3">
        You'll be charged <strong>${customerTotal.toFixed(2)}</strong> (includes{" "}
        <strong>${cardFeeAmount.toFixed(2)}</strong> card processing fee). To
        avoid the fee, pick Zelle instead.
      </p>
      <PaymentElement />
      {errorMessage && (
        <p className="mt-2 text-[11px] text-destructive">{errorMessage}</p>
      )}
      <Button
        type="submit"
        disabled={!stripe || submitting}
        className="mt-3 w-full"
        data-testid="button-stripe-pay"
      >
        {submitting ? "Processing…" : `Pay $${customerTotal.toFixed(2)}`}
      </Button>
      <p className="mt-2 text-[10px] text-muted-foreground leading-relaxed">
        Payments are processed securely by Stripe. Studio Clyx never sees your
        card number.
      </p>
    </form>
  );
}
