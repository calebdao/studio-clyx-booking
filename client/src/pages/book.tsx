import { useEffect, useMemo, useState } from "react";
import {
  ACTIVITIES,
  Activity,
  ActivityId,
  Booking,
  computePrice,
  fmtDayLong,
  fmtMoney,
  fmtTime12,
  HOLD_DURATION_MINUTES,
  MIN_DURATION_HOURS,
  Space,
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
import { Copy, Check, ArrowRight, Mail, Phone, User, Tag, MapPin } from "lucide-react";
import { useBookings } from "@/lib/booking-store";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type Step = "details" | "select" | "review";

export default function BookPage() {
  const { bookings, createHoldAsync, createHoldPending, now } = useBookings();
  const { toast } = useToast();

  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);

  const [spaceId, setSpaceId] = useState<SpaceId>("studio-1");
  const [activityId, setActivityId] = useState<ActivityId>("production");
  const [selection, setSelection] = useState<{ start: Date; end: Date } | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [heldBooking, setHeldBooking] = useState<Booking | null>(null);
  const [copied, setCopied] = useState(false);

  const space = useMemo(() => SPACES.find((s) => s.id === spaceId)!, [spaceId]);
  const activity = useMemo(() => ACTIVITIES.find((a) => a.id === activityId)!, [activityId]);

  const slots = selection
    ? Math.round((selection.end.getTime() - selection.start.getTime()) / (30 * 60 * 1000))
    : 0;
  const hours = slots * 0.5;
  const price = selection ? computePrice(activity, slots) : 0;
  const isComplete = !!selection && slots > 0;
  const isChoosingEnd = !!selection && slots === 0;

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const guestValid = first.trim() && last.trim() && emailValid;

  async function handleBookNow() {
    if (!isComplete || !selection || !guestValid || createHoldPending) return;
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
      });
      setHeldBooking(b);
      setConfirmOpen(true);
      setSelection(null);
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
                <div className="flex items-baseline justify-between">
                  <div className="text-eyebrow">Total</div>
                  <div className="font-mono text-2xl font-semibold tabular-nums" data-testid="text-total-price">
                    {selection ? fmtMoney(price) : "$0.00"}
                  </div>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground font-mono">
                  {selection
                    ? `${activity.rate} × ${hours} hr`
                    : "Pricing applies at selection"}
                </div>
              </div>
            </dl>
            <div className="p-4 border-t border-card-border space-y-2">
              <Button
                size="lg"
                className="w-full text-sm"
                onClick={handleBookNow}
                disabled={!isComplete || !guestValid || createHoldPending}
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
            </div>
          </div>

          <div className="mt-4 px-1 text-[11px] text-muted-foreground leading-relaxed">
            Payment is collected via Zelle to{" "}
            <span className="font-mono text-foreground">{ZELLE_RECIPIENT}</span> after you reserve.
            Slots are held for 30 minutes pending confirmation.
          </div>
        </aside>
      </div>

      {/* Confirmation dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-confirm">
          <DialogHeader>
            <div className="text-eyebrow text-primary mb-1.5">Hold confirmed</div>
            <DialogTitle className="tracking-tight">
              Send payment via Zelle to lock in your booking
            </DialogTitle>
            <DialogDescription className="leading-relaxed pt-1">
              We've placed a 30-minute hold. Studio Clyx will confirm the booking once the payment
              arrives, and you'll receive a confirmation email.
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
                label="Total"
                value={
                  <span className="font-mono font-semibold">
                    {fmtMoney(
                      computePrice(
                        ACTIVITIES.find((a) => a.id === heldBooking.activityId)!,
                        Math.round(
                          (new Date(heldBooking.end).getTime() - new Date(heldBooking.start).getTime()) /
                            (30 * 60 * 1000)
                        )
                      )
                    )}
                  </span>
                }
              />
            </div>
          )}

          {/* Zelle handoff */}
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
