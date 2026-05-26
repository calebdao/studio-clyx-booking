import { useEffect, useMemo, useState } from "react";
import {
  ACTIVITIES,
  ActivityId,
  AddOnCatalogItem,
  Booking,
  computePriceBreakdown,
  fmtDayLong,
  fmtMoney,
  fmtTime12,
  GUEST_MAX,
  GUEST_MIN,
  HOLD_DURATION_MINUTES,
  MIN_DURATION_HOURS,
  PaymentMethod,
  PriceBreakdown,
  SelectedAddOn,
  selectedFromCatalog,
  SpaceId,
  SPACES,
  ZELLE_RECIPIENT,
} from "@/lib/booking-data";
import { Scheduler } from "@/components/scheduler";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Copy, Check, ArrowRight, Mail, Phone, User, Tag, MapPin, Minus, Plus, Users, Wine, ShoppingBag, CreditCard, Banknote } from "lucide-react";
import {
  fetchStripeIntentForBooking,
  useBookings,
  usePublicAddOns,
  useStripeConfig,
  type StripeIntentResult,
} from "@/lib/booking-store";
import { StripePaymentBlock } from "@/components/stripe-payment";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  CANCELLATION_CONTACT_LINE,
  CANCELLATION_POLICY_ACKNOWLEDGEMENT,
  CANCELLATION_POLICY_ITEMS,
  CANCELLATION_POLICY_TITLE,
} from "@shared/cancellation-policy";

export default function BookPage() {
  const { bookings, createHoldAsync, createHoldPending, now } = useBookings();
  const { toast } = useToast();
  const { data: addOnCatalog } = usePublicAddOns();
  const { data: stripeConfig } = useStripeConfig();

  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);

  const [spaceId, setSpaceId] = useState<SpaceId>("studio-1");
  const [activityId, setActivityId] = useState<ActivityId>("production");
  const [selection, setSelection] = useState<{ start: Date; end: Date } | null>(null);

  const [guestCount, setGuestCount] = useState<number>(1);
  const [alcohol, setAlcohol] = useState<boolean>(false);
  // selected add-ons keyed by catalog id → quantity
  const [addonQty, setAddonQty] = useState<Record<string, number>>({});
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("zelle");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [heldBooking, setHeldBooking] = useState<Booking | null>(null);
  const [heldBreakdown, setHeldBreakdown] = useState<PriceBreakdown | null>(null);
  const [stripeIntent, setStripeIntent] = useState<StripeIntentResult | null>(null);
  const [stripeError, setStripeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [policyAccepted, setPolicyAccepted] = useState(false);

  const space = useMemo(() => SPACES.find((s) => s.id === spaceId)!, [spaceId]);
  const activity = useMemo(() => ACTIVITIES.find((a) => a.id === activityId)!, [activityId]);

  const slots = selection
    ? Math.round((selection.end.getTime() - selection.start.getTime()) / (30 * 60 * 1000))
    : 0;
  const hours = slots * 0.5;
  const isComplete = !!selection && slots > 0;
  const isChoosingEnd = !!selection && slots === 0;

  const selectedAddOns = useMemo<SelectedAddOn[]>(() => {
    if (!addOnCatalog) return [];
    const list: SelectedAddOn[] = [];
    for (const item of addOnCatalog) {
      const q = addonQty[item.id] ?? 0;
      if (q > 0) list.push(selectedFromCatalog(item, q));
    }
    return list;
  }, [addOnCatalog, addonQty]);

  const breakdown = useMemo<PriceBreakdown | null>(() => {
    if (!isComplete) return null;
    return computePriceBreakdown({
      activity,
      slots,
      guestCount,
      alcohol,
      activityId,
      addons: selectedAddOns,
      paymentMethod,
    });
  }, [
    isComplete,
    activity,
    slots,
    guestCount,
    alcohol,
    activityId,
    selectedAddOns,
    paymentMethod,
  ]);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const guestValid = !!(first.trim() && last.trim() && emailValid);
  const guestCountValid = Number.isInteger(guestCount) && guestCount >= GUEST_MIN && guestCount <= GUEST_MAX;

  function setAddonQuantity(item: AddOnCatalogItem, qty: number) {
    setAddonQty((prev) => {
      const next = { ...prev };
      const clamped = Math.max(0, Math.min(qty, item.quantityAvailable ?? 99));
      if (clamped === 0) delete next[item.id];
      else next[item.id] = clamped;
      return next;
    });
  }

  async function handleBookNow() {
    if (!isComplete || !selection || !guestValid || !guestCountValid || !policyAccepted || createHoldPending) return;
    try {
      const b = await createHoldAsync({
        spaceId,
        activityId,
        start: selection.start.toISOString(),
        end: selection.end.toISOString(),
        guest: {
          firstName: first.trim(),
          lastName: last.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
        },
        guestCount,
        alcohol,
        addons: selectedAddOns.map((a) => ({ addOnId: a.addOnId, quantity: a.quantity })),
        paymentMethod,
      });
      setHeldBooking(b);
      setHeldBreakdown(breakdown);
      setStripeIntent(null);
      setStripeError(null);
      setConfirmOpen(true);
      setSelection(null);

      // For card payments, immediately create a Stripe PaymentIntent so the
      // Elements form can render in the dialog. Failures here aren't fatal —
      // the hold is already placed; the customer can retry or switch to Zelle.
      if (paymentMethod === "card") {
        try {
          const intent = await fetchStripeIntentForBooking(b.id);
          if (intent.ok) {
            setStripeIntent(intent);
          } else {
            setStripeError(intent.error ?? "Could not start card payment.");
          }
        } catch (intentErr) {
          setStripeError(
            intentErr instanceof Error
              ? intentErr.message
              : "Could not start card payment."
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not place hold.";
      toast({
        title: "Could not place hold",
        description: msg.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      });
    }
  }

  function copyZelle() {
    navigator.clipboard?.writeText(ZELLE_RECIPIENT).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  // hold expiry countdown
  const holdRemaining = heldBooking?.holdExpiresAt
    ? Math.max(0, heldBooking.holdExpiresAt - now.getTime())
    : 0;
  const mm = Math.floor(holdRemaining / 60000);
  const ss = Math.floor((holdRemaining % 60000) / 1000);

  return (
    <div className="max-w-[1280px] mx-auto px-5 lg:px-8 py-8 lg:py-12">
      {/* Hero / intro */}
      <div className="mb-8 lg:mb-10">
        <div className="text-eyebrow mb-3" data-testid="text-eyebrow">
          Reservations · Studio Clyx · NYC
        </div>
        <h1 className="text-xl lg:text-[1.875rem] font-semibold leading-[1.15] tracking-tight max-w-2xl">
          Reserve a space.
          <span className="text-muted-foreground"> Pick your room, pick your hours.</span>
        </h1>
        <p className="mt-3 text-sm text-muted-foreground max-w-xl">
          Open 24/7. Two-hour minimum. Bookings up to twelve months out, with a seven-hour lead time.
          Confirmation by Zelle.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6 lg:gap-8 items-start">
        {/* LEFT: form + scheduler */}
        <div className="space-y-6">
          {/* Guest form */}
          <Section title="Guest" eyebrow="01">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="First name" required>
                <Input
                  value={first}
                  onChange={(e) => setFirst(e.target.value)}
                  placeholder="Alex"
                  data-testid="input-first-name"
                />
              </Field>
              <Field label="Last name" required>
                <Input
                  value={last}
                  onChange={(e) => setLast(e.target.value)}
                  placeholder="Morales"
                  data-testid="input-last-name"
                />
              </Field>
              <Field
                label="Email"
                required
                error={emailTouched && email && !emailValid ? "Use a valid email." : undefined}
              >
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => setEmailTouched(true)}
                  placeholder="alex@studio.com"
                  data-testid="input-email"
                />
              </Field>
              <Field label="Phone" hint="Optional">
                <Input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="(212) 555-0181"
                  data-testid="input-phone"
                />
              </Field>
            </div>
          </Section>

          {/* Space picker */}
          <Section title="Space" eyebrow="02">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {SPACES.map((s) => {
                const active = s.id === spaceId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setSpaceId(s.id);
                      setSelection(null);
                    }}
                    data-testid={`button-space-${s.id}`}
                    className={cn(
                      "relative text-left rounded-md border p-4 transition group",
                      "hover-elevate active-elevate-2",
                      active
                        ? "border-primary bg-primary/5"
                        : "border-card-border bg-card"
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-block w-2.5 h-2.5 rounded-sm"
                            style={{ background: s.hex }}
                            aria-hidden
                          />
                          <span className="font-medium tracking-tight">{s.name}</span>
                        </div>
                        <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
                          {s.description}
                        </p>
                      </div>
                      {active && (
                        <span className="text-eyebrow text-primary mt-0.5">Selected</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Activity */}
          <Section title="Activity" eyebrow="03">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {ACTIVITIES.map((a) => {
                const active = a.id === activityId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setActivityId(a.id)}
                    data-testid={`button-activity-${a.id}`}
                    className={cn(
                      "rounded-md border p-3.5 text-left transition",
                      "hover-elevate active-elevate-2",
                      active
                        ? "border-primary bg-primary/5"
                        : "border-card-border bg-card"
                    )}
                  >
                    <div className="flex items-baseline justify-between">
                      <span className="font-medium">{a.name}</span>
                      <span className="font-mono text-sm text-foreground">
                        ${a.rate}
                        <span className="text-muted-foreground text-xs">/hr</span>
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">{a.description}</p>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Scheduler */}
          <Section
            title="Time"
            eyebrow="04"
            note={
              !selection
                ? "Click a start time. Then click the last half-hour you want."
                : isChoosingEnd
                ? "Now click the last half-hour you want — we'll enforce the 2-hour minimum."
                : `Click anywhere to start over. Minimum ${MIN_DURATION_HOURS} hours.`
            }
          >
            <Scheduler
              space={space}
              activity={activity}
              bookings={bookings}
              selection={selection}
              onSelectionChange={setSelection}
            />
          </Section>

          {/* Guest count + alcohol */}
          <Section
            title="Guests & details"
            eyebrow="05"
            note="Guest tier and an alcohol consumption fee apply."
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field
                label="Number of guests"
                required
                hint={`1–${GUEST_MAX} max`}
                error={
                  !guestCountValid
                    ? `Enter a number between ${GUEST_MIN} and ${GUEST_MAX}.`
                    : undefined
                }
              >
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => setGuestCount((c) => Math.max(GUEST_MIN, c - 1))}
                    disabled={guestCount <= GUEST_MIN}
                    data-testid="button-guest-decrement"
                    aria-label="Decrease guests"
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </Button>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={GUEST_MIN}
                    max={GUEST_MAX}
                    value={guestCount}
                    onChange={(e) => {
                      const n = parseInt(e.target.value || "1", 10);
                      if (Number.isFinite(n)) {
                        setGuestCount(Math.max(GUEST_MIN, Math.min(GUEST_MAX, n)));
                      }
                    }}
                    className="text-center font-mono w-20"
                    data-testid="input-guest-count"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => setGuestCount((c) => Math.min(GUEST_MAX, c + 1))}
                    disabled={guestCount >= GUEST_MAX}
                    data-testid="button-guest-increment"
                    aria-label="Increase guests"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </Button>
                  <span className="ml-1 text-[11px] text-muted-foreground">
                    {guestCount <= 15
                      ? "no surcharge"
                      : guestCount <= 25
                      ? "+$10/hr"
                      : "+$20/hr"}
                  </span>
                </div>
              </Field>

              <Field label="Alcohol" hint="Adds a $50 fee">
                <label className="flex items-center gap-2.5 rounded-md border border-card-border bg-card px-3 h-9 text-sm cursor-pointer hover-elevate">
                  <input
                    type="checkbox"
                    checked={alcohol}
                    onChange={(e) => setAlcohol(e.target.checked)}
                    className="h-4 w-4 accent-primary"
                    data-testid="checkbox-alcohol"
                  />
                  <Wine className="w-3.5 h-3.5 text-muted-foreground" />
                  <span>Alcohol will be consumed.</span>
                </label>
              </Field>
            </div>
          </Section>

          {/* Add-ons */}
          <Section
            title="Add-ons"
            eyebrow="06"
            note="Optional rentals to enhance your space."
          >
            {!addOnCatalog ? (
              <div className="text-xs text-muted-foreground">Loading add-ons…</div>
            ) : addOnCatalog.length === 0 ? (
              <div className="text-xs text-muted-foreground">No add-ons available right now.</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {addOnCatalog.map((item) => {
                  const qty = addonQty[item.id] ?? 0;
                  const selected = qty > 0;
                  return (
                    <div
                      key={item.id}
                      data-testid={`card-addon-${item.id}`}
                      className={cn(
                        "flex gap-3 rounded-md border p-3 transition",
                        selected
                          ? "border-primary bg-primary/5"
                          : "border-card-border bg-card"
                      )}
                    >
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt=""
                          className="w-16 h-16 rounded-sm object-cover flex-shrink-0"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-16 h-16 rounded-sm bg-muted flex items-center justify-center flex-shrink-0">
                          <ShoppingBag className="w-4 h-4 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <div className="font-medium text-sm tracking-tight truncate">
                            {item.name}
                          </div>
                          <div className="font-mono text-xs whitespace-nowrap">
                            ${item.price.toFixed(2)}
                            <span className="text-muted-foreground">
                              {item.priceType === "per_item" ? "/ea" : " flat"}
                            </span>
                          </div>
                        </div>
                        {item.description && (
                          <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug line-clamp-2">
                            {item.description}
                          </p>
                        )}
                        <div className="mt-2 flex items-center gap-2">
                          {item.priceType === "per_item" ? (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-7 w-7"
                                disabled={qty <= 0}
                                onClick={() => setAddonQuantity(item, qty - 1)}
                                data-testid={`button-addon-decrement-${item.id}`}
                                aria-label={`Decrease ${item.name}`}
                              >
                                <Minus className="w-3 h-3" />
                              </Button>
                              <Input
                                type="number"
                                min={0}
                                max={item.quantityAvailable ?? 99}
                                value={qty}
                                onChange={(e) => {
                                  const n = parseInt(e.target.value || "0", 10);
                                  setAddonQuantity(item, Number.isFinite(n) ? n : 0);
                                }}
                                className="text-center font-mono w-14 h-7 text-xs"
                                data-testid={`input-addon-qty-${item.id}`}
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-7 w-7"
                                disabled={
                                  item.quantityAvailable != null &&
                                  qty >= item.quantityAvailable
                                }
                                onClick={() => setAddonQuantity(item, qty + 1)}
                                data-testid={`button-addon-increment-${item.id}`}
                                aria-label={`Increase ${item.name}`}
                              >
                                <Plus className="w-3 h-3" />
                              </Button>
                            </>
                          ) : (
                            <label className="flex items-center gap-2 text-xs cursor-pointer">
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={(e) =>
                                  setAddonQuantity(item, e.target.checked ? 1 : 0)
                                }
                                className="h-3.5 w-3.5 accent-primary"
                                data-testid={`checkbox-addon-${item.id}`}
                              />
                              <span>{selected ? "Added" : "Add"}</span>
                            </label>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
        </div>

        {/* RIGHT: sticky summary */}
        <aside className="lg:sticky lg:top-6">
          <div className="bg-card border border-card-border rounded-md overflow-hidden">
            <div className="px-5 py-4 border-b border-card-border flex items-center justify-between">
              <div className="text-eyebrow">Reservation</div>
              <span className="font-mono text-[10px] text-muted-foreground">
                ID · pending
              </span>
            </div>
            <dl className="divide-y divide-card-border text-sm">
              <SummaryRow icon={<MapPin className="w-3.5 h-3.5" />} label="Space" value={space.name} />
              <SummaryRow icon={<Tag className="w-3.5 h-3.5" />} label="Activity" value={`${activity.name} · $${activity.rate}/hr`} />
              <SummaryRow
                icon={<User className="w-3.5 h-3.5" />}
                label="Guest"
                value={guestValid ? `${first} ${last}` : <span className="text-muted-foreground">—</span>}
              />
              <SummaryRow
                icon={<Mail className="w-3.5 h-3.5" />}
                label="Email"
                value={emailValid ? email : <span className="text-muted-foreground">—</span>}
              />
              {phone && <SummaryRow icon={<Phone className="w-3.5 h-3.5" />} label="Phone" value={phone} />}
              <SummaryRow
                icon={<Users className="w-3.5 h-3.5" />}
                label="Guests"
                value={`${guestCount} ${guestCount === 1 ? "guest" : "guests"}`}
              />
              <SummaryRow
                icon={<Wine className="w-3.5 h-3.5" />}
                label="Alcohol"
                value={alcohol ? "Yes (+$50)" : <span className="text-muted-foreground">No</span>}
              />
              {selectedAddOns.length > 0 && (
                <SummaryRow
                  icon={<ShoppingBag className="w-3.5 h-3.5" />}
                  label="Add-ons"
                  value={
                    <span className="text-xs">
                      {selectedAddOns.length} item{selectedAddOns.length === 1 ? "" : "s"}
                    </span>
                  }
                />
              )}

              <div className="px-5 py-4">
                <div className="text-eyebrow mb-2">When</div>
                {isComplete ? (
                  <div className="space-y-1">
                    <div className="font-medium tracking-tight" data-testid="text-selection-day">
                      {fmtDayLong(selection!.start)}
                    </div>
                    <div className="font-mono text-sm tabular-nums" data-testid="text-selection-time">
                      {fmtTime12(selection!.start)} → {fmtTime12(selection!.end)}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {hours} hr · {slots} half-hour slots
                    </div>
                  </div>
                ) : isChoosingEnd ? (
                  <div className="space-y-1">
                    <div className="font-medium tracking-tight" data-testid="text-selection-day">
                      {fmtDayLong(selection!.start)}
                    </div>
                    <div className="font-mono text-sm tabular-nums">
                      Start · {fmtTime12(selection!.start)}
                    </div>
                    <div className="text-xs text-primary font-mono">
                      → click an end time
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground italic">
                    Select a time on the calendar.
                  </div>
                )}
              </div>

              <div className="px-5 py-4 bg-background/40">
                {breakdown && breakdown.lines.length > 0 && (
                  <div className="mb-3 space-y-1">
                    {breakdown.lines.map((line, idx) => (
                      <div
                        key={`${line.label}-${idx}`}
                        className="flex items-baseline justify-between gap-2 text-[11px]"
                      >
                        <div className="text-muted-foreground truncate">
                          <span className="text-foreground">{line.label}</span>
                          {line.detail && (
                            <span className="ml-1.5 font-mono text-[10px]">{line.detail}</span>
                          )}
                        </div>
                        <div className="font-mono tabular-nums">
                          {fmtMoney(line.amount)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-baseline justify-between">
                  <div className="text-eyebrow">Total</div>
                  <div className="font-mono text-2xl font-semibold tabular-nums" data-testid="text-total-price">
                    {breakdown ? fmtMoney(breakdown.total) : "$0.00"}
                  </div>
                </div>
                {!breakdown && (
                  <div className="mt-1 text-[11px] text-muted-foreground font-mono">
                    Pricing applies at selection
                  </div>
                )}
              </div>
            </dl>
            <div className="p-4 border-t border-card-border space-y-3">
              <PaymentMethodPicker
                value={paymentMethod}
                onChange={setPaymentMethod}
                subtotal={breakdown?.subtotal ?? 0}
                cardFee={breakdown?.cardFee ?? 0}
                disabled={createHoldPending}
              />
              <CancellationPolicyNotice />

              <label className="flex items-start gap-2.5 rounded-md border border-card-border bg-background/35 p-3 text-xs leading-relaxed cursor-pointer">
                <input
                  type="checkbox"
                  checked={policyAccepted}
                  onChange={(e) => setPolicyAccepted(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-primary"
                  data-testid="checkbox-cancellation-policy"
                />
                <span>
                  I have read and agree to the Studio Clyx cancellation policy.
                </span>
              </label>

              <Button
                size="lg"
                className="w-full text-sm"
                onClick={handleBookNow}
                disabled={
                  !isComplete ||
                  !guestValid ||
                  !guestCountValid ||
                  !policyAccepted ||
                  createHoldPending
                }
                data-testid="button-book-now"
              >
                {createHoldPending ? "Placing hold…" : "Book now"}
                <ArrowRight className="w-4 h-4 ml-1.5" />
              </Button>
              {!guestValid && (
                <p className="text-[11px] text-muted-foreground text-center">
                  Complete guest details to continue.
                </p>
              )}
              {guestValid && !selection && (
                <p className="text-[11px] text-muted-foreground text-center">
                  Pick a start and end on the calendar.
                </p>
              )}
              {guestValid && isChoosingEnd && (
                <p className="text-[11px] text-primary text-center">
                  Click an end time on the calendar.
                </p>
              )}
              {guestValid && selection && !policyAccepted && (
                <p className="text-[11px] text-muted-foreground text-center">
                  Review and accept the cancellation policy to continue.
                </p>
              )}
            </div>
          </div>

          <div className="mt-4 px-1 text-[11px] text-muted-foreground leading-relaxed">
            {paymentMethod === "card" ? (
              <>
                Payment is collected by credit card at the time of booking via
                Stripe. Slots are held for {HOLD_DURATION_MINUTES} minutes pending
                payment.
              </>
            ) : (
              <>
                Payment is collected via Zelle to{" "}
                <span className="font-mono text-foreground">{ZELLE_RECIPIENT}</span>{" "}
                after you reserve. Slots are held for {HOLD_DURATION_MINUTES} minutes
                pending confirmation. Payment confirmation typically takes
                approximately 10–30 minutes.
              </>
            )}
          </div>
        </aside>
      </div>

      {/* Confirmation dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto" data-testid="dialog-confirm">
          <DialogHeader>
            <div className="text-eyebrow text-primary mb-1.5">Hold confirmed</div>
            <DialogTitle className="tracking-tight">
              {heldBooking?.paymentMethod === "card"
                ? "Enter your card to lock in your booking"
                : "Send payment via Zelle to lock in your booking"}
            </DialogTitle>
            <DialogDescription className="leading-relaxed pt-1">
              {heldBooking?.paymentMethod === "card" ? (
                <>
                  We've placed a {HOLD_DURATION_MINUTES}-minute hold. Pay below to
                  confirm your booking — you'll receive a confirmation email as
                  soon as the charge settles.
                </>
              ) : (
                <>
                  We've placed a {HOLD_DURATION_MINUTES}-minute hold. Studio Clyx will
                  confirm your booking once payment arrives — payment confirmation
                  typically takes approximately 10–30 minutes, and you'll receive a
                  confirmation email.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {heldBooking && (
            <div className="mt-2 rounded-md border border-card-border bg-background/50 divide-y divide-card-border text-sm">
              <ConfirmRow label="Space" value={SPACES.find((s) => s.id === heldBooking.spaceId)!.name} />
              <ConfirmRow
                label="Activity"
                value={ACTIVITIES.find((a) => a.id === heldBooking.activityId)!.name}
              />
              <ConfirmRow
                label="When"
                value={
                  <span className="font-mono text-xs tabular-nums">
                    {fmtTime12(new Date(heldBooking.start))} → {fmtTime12(new Date(heldBooking.end))} ·{" "}
                    {fmtDayLong(new Date(heldBooking.start))}
                  </span>
                }
              />
              <ConfirmRow
                label="Guests"
                value={`${heldBooking.guestCount} ${heldBooking.guestCount === 1 ? "guest" : "guests"}`}
              />
              {heldBooking.alcohol && (
                <ConfirmRow label="Alcohol" value="Yes (+$50)" />
              )}
              {heldBooking.addons.length > 0 && (
                <ConfirmRow
                  label="Add-ons"
                  value={
                    <span className="text-xs">
                      {heldBooking.addons
                        .map((a) =>
                          a.priceType === "flat" ? a.name : `${a.name} × ${a.quantity}`
                        )
                        .join(", ")}
                    </span>
                  }
                />
              )}
              {heldBreakdown && (
                <div className="px-3.5 py-2.5 space-y-1">
                  {heldBreakdown.lines.map((line, idx) => (
                    <div
                      key={`${line.label}-${idx}`}
                      className="flex items-baseline justify-between gap-2 text-[11px]"
                    >
                      <span className="text-muted-foreground">
                        <span className="text-foreground">{line.label}</span>
                        {line.detail && (
                          <span className="ml-1.5 font-mono text-[10px]">{line.detail}</span>
                        )}
                      </span>
                      <span className="font-mono tabular-nums">{fmtMoney(line.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
              <ConfirmRow
                label="Total"
                value={
                  <span className="font-mono font-semibold">
                    {fmtMoney(heldBreakdown?.total ?? 0)}
                  </span>
                }
              />
            </div>
          )}

          {/* Payment handoff — card or Zelle, based on what the customer chose */}
          {heldBooking?.paymentMethod === "card" ? (
            <div className="mt-3 space-y-2">
              {stripeError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                  {stripeError}
                </div>
              )}
              {stripeIntent && stripeIntent.clientSecret ? (
                <StripePaymentBlock
                  clientSecret={stripeIntent.clientSecret}
                  publishableKey={stripeIntent.publishableKey ?? stripeConfig?.publishableKey ?? null}
                  customerTotal={stripeIntent.customerTotal ?? heldBreakdown?.total ?? 0}
                  cardFeeAmount={stripeIntent.cardFeeAmount ?? heldBreakdown?.cardFee ?? 0}
                  bookingId={heldBooking.id}
                  simulationMode={stripeIntent.mode === "simulation"}
                />
              ) : (
                !stripeError && (
                  <div className="rounded-md border border-card-border bg-background/50 p-4 text-xs text-muted-foreground">
                    Loading secure card form…
                  </div>
                )
              )}
            </div>
          ) : (
            <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 p-4">
              <div className="text-eyebrow text-primary mb-2">Zelle payment</div>
              <div className="flex items-center justify-between gap-3">
                <code className="font-mono text-sm break-all" data-testid="text-zelle-recipient">
                  {ZELLE_RECIPIENT}
                </code>
                <Button size="sm" variant="outline" onClick={copyZelle} data-testid="button-copy-zelle">
                  {copied ? <Check className="w-3.5 h-3.5 mr-1" /> : <Copy className="w-3.5 h-3.5 mr-1" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                Open your bank's Zelle, send the total above to this address, and include your name in
                the memo.
              </p>
            </div>
          )}

          <CancellationPolicyNotice compact />

          {/* Hold timer */}
          {heldBooking?.holdExpiresAt && (
            <div className="mt-2 flex items-center justify-between text-xs px-1">
              <span className="text-muted-foreground">Hold expires in</span>
              <span className="font-mono tabular-nums" data-testid="text-hold-timer">
                {String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}
              </span>
            </div>
          )}

          <DialogFooter className="mt-3">
            <Button variant="outline" onClick={() => setConfirmOpen(false)} data-testid="button-close-confirm">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Section({
  title,
  eyebrow,
  children,
  note,
}: {
  title: string;
  eyebrow: string;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-semibold tracking-tight text-base flex items-baseline gap-2.5">
          <span className="font-mono text-[11px] text-muted-foreground">{eyebrow}</span>
          {title}
        </h2>
        {note && <p className="text-xs text-muted-foreground hidden md:block max-w-md text-right">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="text-xs font-medium mb-1.5 flex items-center gap-1.5">
        {label}
        {required ? (
          <span className="text-primary text-[10px]">required</span>
        ) : hint ? (
          <span className="text-muted-foreground text-[10px]">{hint}</span>
        ) : null}
      </Label>
      {children}
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

function SummaryRow({ label, value, icon }: { label: string; value: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="px-5 py-3 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2 text-eyebrow">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        {label}
      </div>
      <div className="text-sm font-medium truncate text-right">{value}</div>
    </div>
  );
}

function ConfirmRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-3.5 py-2.5 flex items-center justify-between gap-4">
      <span className="text-eyebrow">{label}</span>
      <span className="text-sm font-medium text-right">{value}</span>
    </div>
  );
}

function PaymentMethodPicker({
  value,
  onChange,
  subtotal,
  cardFee,
  disabled,
}: {
  value: PaymentMethod;
  onChange: (next: PaymentMethod) => void;
  subtotal: number;
  cardFee: number;
  disabled?: boolean;
}) {
  return (
    <div
      className="rounded-md border border-card-border bg-background/45 p-3"
      data-testid="payment-method-picker"
    >
      <div className="text-eyebrow text-primary mb-2">Payment method</div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onChange("zelle")}
          disabled={disabled}
          className={cn(
            "rounded-md border p-2.5 text-left transition-colors",
            value === "zelle"
              ? "border-primary bg-primary/5"
              : "border-card-border bg-background/40 hover:border-primary/40",
            disabled && "opacity-60 cursor-not-allowed"
          )}
          data-testid="payment-method-zelle"
        >
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <Banknote className="w-3.5 h-3.5 text-primary" />
            Zelle
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground leading-tight">
            No fee · pay after holding
          </div>
        </button>
        <button
          type="button"
          onClick={() => onChange("card")}
          disabled={disabled}
          className={cn(
            "rounded-md border p-2.5 text-left transition-colors",
            value === "card"
              ? "border-primary bg-primary/5"
              : "border-card-border bg-background/40 hover:border-primary/40",
            disabled && "opacity-60 cursor-not-allowed"
          )}
          data-testid="payment-method-card"
        >
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <CreditCard className="w-3.5 h-3.5 text-primary" />
            Credit card
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground leading-tight">
            {subtotal > 0
              ? `+${fmtMoney(cardFee)} processing fee`
              : "Adds 2.9% + $0.30 fee"}
          </div>
        </button>
      </div>
      {value === "card" && subtotal > 0 && (
        <p className="mt-2 text-[10px] text-muted-foreground leading-relaxed">
          The card processing fee passes through Stripe's exact cost so Studio
          Clyx receives the full booking total. Choose Zelle to avoid it.
        </p>
      )}
    </div>
  );
}

function CancellationPolicyNotice({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-md border border-card-border bg-background/45",
        compact ? "mt-3 p-3" : "p-3"
      )}
      data-testid={compact ? "card-cancellation-policy-dialog" : "card-cancellation-policy"}
    >
      <div className="text-eyebrow text-primary mb-2">{CANCELLATION_POLICY_TITLE}</div>
      <p className="text-xs text-muted-foreground leading-relaxed mb-2">
        Bookings are confirmed upon receipt of payment and are subject to the following terms:
      </p>
      <ul className="space-y-1.5 text-[11px] text-muted-foreground leading-relaxed list-disc pl-4">
        {CANCELLATION_POLICY_ITEMS.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-foreground leading-relaxed">
        {CANCELLATION_POLICY_ACKNOWLEDGEMENT}
      </p>
      {compact && (
        <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
          {CANCELLATION_CONTACT_LINE}
        </p>
      )}
    </div>
  );
}
