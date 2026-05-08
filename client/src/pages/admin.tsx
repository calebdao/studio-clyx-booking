import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ACTIVITIES,
  Booking,
  computePrice,
  fmtDay,
  fmtDayLong,
  fmtMoney,
  fmtTime12,
  SPACES,
  spaceById,
  activityById,
  STUDIO_OWNER_EMAIL,
} from "@/lib/booking-data";
import { useAdmin, useBookings } from "@/lib/booking-store";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CheckCircle2,
  Mail,
  Clock,
  Lock,
  X,
  AlertTriangle,
  ExternalLink,
  ShieldCheck,
  KeyRound,
  Activity as ActivityIcon,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

type IntegrationStatus = {
  google: {
    name: string;
    mode: "live" | "simulation";
    detail: { spaceId: string; envVar: string; configured: boolean; live: boolean }[];
    credentialEnv: string;
    credentialConfigured: boolean;
    credentialError?: string | null;
    liveSpaces: number;
    totalSpaces: number;
  };
  resend: {
    name: string;
    mode: "live" | "simulation";
    credentialEnv: string;
    credentialConfigured: boolean;
    fromEnv: string;
    fromConfigured: boolean;
  };
  adminGate: {
    name: string;
    mode: "live" | "simulation";
    credentialEnv: string;
    credentialConfigured: boolean;
    defaultPinHint: string | null;
  };
};

export default function AdminPage() {
  const { isUnlocked } = useAdmin();
  if (!isUnlocked) return <AdminGate />;
  return <AdminConsole />;
}

function AdminConsole() {
  const {
    bookings,
    confirmPaymentAsync,
    releaseHoldAsync,
    now,
    isLoading,
    mutationPendingId,
  } = useBookings();
  const { lock } = useAdmin();
  const { toast } = useToast();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [emailToast, setEmailToast] = useState<{
    email: string;
    mode: "live" | "simulation";
    ok: boolean;
    detail?: string;
  } | null>(null);

  const integrations = useQuery<IntegrationStatus>({
    queryKey: ["/api/integrations/status"],
  });

  const pending = bookings
    .filter((b) => b.status === "held" || b.status === "pending")
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  const confirmed = bookings
    .filter((b) => b.status === "confirmed")
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  const target = confirmId ? bookings.find((b) => b.id === confirmId) : null;

  async function doConfirm() {
    if (!target) return;
    const guestEmail = target.guest.email;
    try {
      const result = await confirmPaymentAsync(target.id);
      setConfirmId(null);
      const email = result.email;
      const mode = email?.mode ?? "simulation";
      const ok = email?.ok ?? true;
      const detail = !ok
        ? email?.error ?? `Send failed (status ${email?.status ?? "?"})`
        : email?.reason;
      setEmailToast({ email: guestEmail, mode, ok, detail });
      setTimeout(() => setEmailToast(null), 6000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not confirm.";
      toast({
        title: "Could not confirm booking",
        description: msg.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      });
    }
  }

  async function doRelease(id: string) {
    try {
      await releaseHoldAsync(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not release hold.";
      toast({
        title: "Could not release hold",
        description: msg.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      });
    }
  }

  return (
    <div className="max-w-[1280px] mx-auto px-5 lg:px-8 py-8 lg:py-12">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
        <div>
          <div className="text-eyebrow mb-2 flex items-center gap-2">
            <ShieldCheck className="w-3 h-3" />
            Operator console · preview
          </div>
          <h1 className="text-xl lg:text-[1.875rem] font-semibold tracking-tight leading-[1.15]">
            Bookings dashboard
          </h1>
          <p className="mt-2 text-sm text-muted-foreground max-w-xl">
            Review pending holds, confirm payments, and see what's already on the calendar.
            PIN-gated. Production keys arrive via env vars; bookings persist in the
            backend and reflect server state. Owner of record:{" "}
            <span className="font-mono text-foreground">{STUDIO_OWNER_EMAIL}</span>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <KpiPill label="Pending" value={pending.length} tone="warn" />
          <KpiPill label="Confirmed" value={confirmed.length} tone="ok" />
          <Button
            size="sm"
            variant="outline"
            onClick={lock}
            data-testid="button-lock-admin"
          >
            <Lock className="w-3.5 h-3.5 mr-1.5" /> Lock
          </Button>
        </div>
      </div>

      {/* Integration status callout (above tabs so it's always visible) */}
      <IntegrationsCallout status={integrations.data} loading={integrations.isLoading} />

      <Tabs defaultValue="pending" className="space-y-5">
        <TabsList className="bg-muted/40">
          <TabsTrigger value="pending" data-testid="tab-pending">
            Pending <span className="ml-2 font-mono text-[11px]">{pending.length}</span>
          </TabsTrigger>
          <TabsTrigger value="confirmed" data-testid="tab-confirmed">
            Confirmed <span className="ml-2 font-mono text-[11px]">{confirmed.length}</span>
          </TabsTrigger>
          <TabsTrigger value="calendar" data-testid="tab-calendar">
            Calendar
          </TabsTrigger>
        </TabsList>

        {/* PENDING */}
        <TabsContent value="pending" className="space-y-3">
          {pending.length === 0 ? (
            <EmptyState
              title="No pending holds"
              detail="When a guest reserves, you'll see them here until their Zelle payment lands."
            />
          ) : (
            pending.map((b) => (
              <BookingRow
                key={b.id}
                booking={b}
                now={now}
                actions={
                  <>
                    <Button
                      size="sm"
                      onClick={() => setConfirmId(b.id)}
                      data-testid={`button-confirm-${b.id}`}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                      Confirm payment
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => doRelease(b.id)}
                      disabled={mutationPendingId === b.id}
                      data-testid={`button-release-${b.id}`}
                    >
                      {mutationPendingId === b.id ? (
                        <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <X className="w-3.5 h-3.5 mr-1.5" />
                      )}
                      Release
                    </Button>
                  </>
                }
              />
            ))
          )}
        </TabsContent>

        {/* CONFIRMED */}
        <TabsContent value="confirmed" className="space-y-3">
          {confirmed.length === 0 ? (
            <EmptyState title="Nothing confirmed yet" detail="Locked-in bookings will appear here." />
          ) : (
            confirmed.map((b) => (
              <BookingRow
                key={b.id}
                booking={b}
                now={now}
                actions={
                  <span className="inline-flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
                    <Lock className="w-3 h-3" />
                    locked
                  </span>
                }
              />
            ))
          )}
        </TabsContent>

        {/* CALENDAR PREVIEW */}
        <TabsContent value="calendar">
          <CalendarPreview bookings={bookings} />
        </TabsContent>
      </Tabs>

      {/* Confirm dialog */}
      <Dialog open={!!confirmId} onOpenChange={(o) => !o && setConfirmId(null)}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-confirm-payment">
          <DialogHeader>
            <div className="text-eyebrow text-primary mb-1.5">Confirm payment</div>
            <DialogTitle className="tracking-tight">Lock in this booking?</DialogTitle>
            <DialogDescription className="leading-relaxed">
              This marks the booking as paid, blocks the slots, and sends a confirmation email to the
              guest. In production, it would also write the event to the corresponding Google Calendar.
            </DialogDescription>
          </DialogHeader>
          {target && (
            <div className="mt-2 rounded-md border border-card-border bg-background/40 divide-y divide-card-border text-sm">
              <Row label="Guest" value={`${target.guest.firstName} ${target.guest.lastName}`} />
              <Row label="Email" value={target.guest.email} />
              <Row label="Space" value={spaceById(target.spaceId).name} />
              <Row
                label="When"
                value={
                  <span className="font-mono text-xs tabular-nums">
                    {fmtTime12(new Date(target.start))} → {fmtTime12(new Date(target.end))} ·{" "}
                    {fmtDay(new Date(target.start))}
                  </span>
                }
              />
              <Row
                label="Total"
                value={
                  <span className="font-mono font-semibold">
                    {fmtMoney(
                      computePrice(
                        activityById(target.activityId),
                        Math.round(
                          (new Date(target.end).getTime() - new Date(target.start).getTime()) /
                            (30 * 60 * 1000)
                        )
                      )
                    )}
                  </span>
                }
              />
            </div>
          )}
          <DialogFooter className="mt-3">
            <Button variant="outline" onClick={() => setConfirmId(null)} data-testid="button-cancel-confirm">
              Cancel
            </Button>
            <Button
              onClick={doConfirm}
              disabled={!!target && mutationPendingId === target.id}
              data-testid="button-confirm-lock"
            >
              {target && mutationPendingId === target.id ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
              )}
              Confirm & email guest
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email-sent toast — reflects real vs simulated send */}
      {emailToast && (
        <div
          className={cn(
            "fixed bottom-6 right-6 z-50 max-w-sm rounded-md border bg-card shadow-lg p-4",
            emailToast.ok
              ? "border-primary/30"
              : "border-destructive/40"
          )}
          data-testid="toast-email-sent"
          data-email-mode={emailToast.mode}
          data-email-ok={emailToast.ok ? "true" : "false"}
        >
          <div className="flex items-start gap-3">
            <div className={cn("mt-0.5", emailToast.ok ? "text-primary" : "text-destructive")}>
              <Mail className="w-4 h-4" />
            </div>
            <div>
              <div
                className={cn(
                  "text-eyebrow mb-0.5",
                  emailToast.ok ? "text-primary" : "text-destructive"
                )}
              >
                {emailToast.ok
                  ? emailToast.mode === "live"
                    ? "Confirmation email sent"
                    : "Confirmation email simulated"
                  : "Email send failed"}
              </div>
              <div className="text-sm font-medium">Booking locked in</div>
              <p className="mt-1 text-xs text-muted-foreground">
                {emailToast.ok && emailToast.mode === "live" && (
                  <>
                    Resend delivered the confirmation to{" "}
                    <span className="font-mono">{emailToast.email}</span>.
                  </>
                )}
                {emailToast.ok && emailToast.mode === "simulation" && (
                  <>
                    Simulation only — set <span className="font-mono">RESEND_API_KEY</span> and{" "}
                    <span className="font-mono">RESEND_FROM_ADDRESS</span> to send a real email to{" "}
                    <span className="font-mono">{emailToast.email}</span>.
                  </>
                )}
                {!emailToast.ok && (
                  <>
                    Booking is locked in, but the email to{" "}
                    <span className="font-mono">{emailToast.email}</span> didn’t go through.
                    {emailToast.detail ? <> {emailToast.detail}</> : null}
                  </>
                )}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function KpiPill({ label, value, tone }: { label: string; value: number; tone: "ok" | "warn" }) {
  return (
    <div className="rounded-md border border-card-border bg-card px-3.5 py-2">
      <div className="text-eyebrow">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-2xl font-semibold tabular-nums" data-testid={`kpi-${label.toLowerCase()}`}>{value}</span>
        <span
          className={cn(
            "inline-block w-1.5 h-1.5 rounded-full",
            tone === "ok" ? "bg-primary" : "bg-amber-500"
          )}
        />
      </div>
    </div>
  );
}

function BookingRow({
  booking,
  now,
  actions,
}: {
  booking: Booking;
  now: Date;
  actions: React.ReactNode;
}) {
  const space = spaceById(booking.spaceId);
  const activity = activityById(booking.activityId);
  const start = new Date(booking.start);
  const end = new Date(booking.end);
  const slots = Math.round((end.getTime() - start.getTime()) / (30 * 60 * 1000));
  const price = computePrice(activity, slots);

  const isHeld = booking.status === "held";
  const isPending = booking.status === "pending";
  const remainingMs = booking.holdExpiresAt ? Math.max(0, booking.holdExpiresAt - now.getTime()) : 0;
  const remainingMin = Math.floor(remainingMs / 60000);
  const remainingSec = Math.floor((remainingMs % 60000) / 1000);

  const isExpiringSoon = isHeld && remainingMs > 0 && remainingMs < 5 * 60 * 1000;

  return (
    <div
      className="rounded-md border border-card-border bg-card p-4 lg:p-5 grid grid-cols-1 lg:grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 lg:gap-6"
      data-testid={`row-booking-${booking.id}`}
    >
      <div className="flex items-center gap-3">
        <span
          className="inline-block w-1 h-12 rounded-full"
          style={{ background: space.hex }}
          aria-hidden
        />
        <div>
          <div className="text-eyebrow flex items-center gap-2">
            {space.name} · {activity.name}
            {booking.source && booking.source !== "internal" && (
              <span className="font-mono text-[10px] text-muted-foreground/80">
                via {booking.source}
              </span>
            )}
          </div>
          <div className="font-medium tracking-tight">
            {booking.guest.firstName} {booking.guest.lastName}
          </div>
          <div className="text-xs text-muted-foreground font-mono">{booking.guest.email}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-sm">
        <span className="font-mono tabular-nums">
          {fmtTime12(start)} → {fmtTime12(end)}
        </span>
        <span className="text-muted-foreground">{fmtDay(start)}</span>
        <span className="font-mono tabular-nums text-muted-foreground">
          {slots * 0.5} hr · {fmtMoney(price)}
        </span>
        {isHeld && (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 font-mono text-[11px] border",
              isExpiringSoon
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
            )}
          >
            <Clock className="w-3 h-3" />
            {remainingMs > 0
              ? `${String(remainingMin).padStart(2, "0")}:${String(remainingSec).padStart(2, "0")} hold`
              : "expired"}
          </span>
        )}
        {isPending && (
          <span className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 font-mono text-[11px] border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-3 h-3" />
            awaiting payment
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 lg:justify-end">{actions}</div>
    </div>
  );
}

function CalendarPreview({ bookings }: { bookings: Booking[] }) {
  // Show next 14 days: rows = days, columns = spaces; cells show count + bars
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const days: Date[] = useMemo(() => {
    const arr: Date[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      arr.push(d);
    }
    return arr;
  }, [today]);

  const bookingsByDayAndSpace = useMemo(() => {
    const m = new Map<string, Booking[]>();
    for (const b of bookings) {
      const start = new Date(b.start);
      const key = `${start.toDateString()}|${b.spaceId}`;
      const arr = m.get(key) ?? [];
      arr.push(b);
      m.set(key, arr);
    }
    return m;
  }, [bookings]);

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-card-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-card-border flex items-center justify-between">
          <div>
            <div className="text-eyebrow">Next 14 days</div>
            <div className="text-sm font-medium">Calendar overview by space</div>
          </div>
          <div className="text-xs text-muted-foreground hidden md:block">
            One row per space. Each block represents a booking. In production, this view reads
            directly from Google Calendar (one calendar per space).
          </div>
        </div>

        <div className="grid" style={{ gridTemplateColumns: "180px repeat(14, minmax(0, 1fr))" }}>
          {/* header */}
          <div className="text-eyebrow p-2 border-b border-card-border bg-background/40">Space</div>
          {days.map((d) => (
            <div
              key={`h-${d.toISOString()}`}
              className="border-b border-l border-card-border bg-background/40 px-1 py-2 text-center"
            >
              <div className="text-eyebrow">{d.toLocaleDateString("en-US", { weekday: "short" })}</div>
              <div className="text-xs font-mono tabular-nums">
                {d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}
              </div>
            </div>
          ))}

          {/* rows */}
          {SPACES.map((space) => (
            <div key={space.id} className="contents">
              <div className="border-t border-card-border p-3 flex items-center gap-2">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-sm"
                  style={{ background: space.hex }}
                  aria-hidden
                />
                <div>
                  <div className="text-sm font-medium tracking-tight">{space.name}</div>
                  <div className="text-[10px] font-mono text-muted-foreground">
                    cal · {space.id}
                  </div>
                </div>
              </div>
              {days.map((d) => {
                const list = bookingsByDayAndSpace.get(`${d.toDateString()}|${space.id}`) ?? [];
                const total = list.reduce((acc, b) => {
                  const slots = Math.round(
                    (new Date(b.end).getTime() - new Date(b.start).getTime()) / (30 * 60 * 1000)
                  );
                  return acc + slots;
                }, 0);
                const utilization = Math.min(1, total / 48);
                return (
                  <div
                    key={`${space.id}-${d.toISOString()}`}
                    className="border-t border-l border-card-border min-h-[64px] p-1.5 relative"
                    title={`${list.length} booking${list.length === 1 ? "" : "s"} · ${total / 2} hr`}
                  >
                    {list.length === 0 ? (
                      <span className="text-[10px] text-muted-foreground/50 font-mono">—</span>
                    ) : (
                      <>
                        <div className="absolute inset-x-1.5 top-1.5 flex flex-col gap-0.5">
                          {list.slice(0, 3).map((b) => {
                            const tone =
                              b.status === "confirmed"
                                ? "bg-primary/80 text-primary-foreground"
                                : "bg-amber-500/40 text-foreground";
                            return (
                              <div
                                key={b.id}
                                className={cn(
                                  "rounded-[3px] px-1 py-0.5 text-[10px] font-mono truncate",
                                  tone
                                )}
                                title={`${b.guest.firstName} ${b.guest.lastName} · ${activityById(b.activityId).name}`}
                              >
                                {fmtTime12(new Date(b.start))} {b.guest.firstName}
                              </div>
                            );
                          })}
                          {list.length > 3 && (
                            <div className="text-[10px] font-mono text-muted-foreground">
                              +{list.length - 3} more
                            </div>
                          )}
                        </div>
                        <div
                          className="absolute bottom-0 left-0 h-0.5 bg-primary/40"
                          style={{ width: `${utilization * 100}%` }}
                          aria-hidden
                        />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Future integration callout */}
      <div className="rounded-md border border-dashed border-card-border bg-background/40 p-4 text-xs text-muted-foreground flex items-start gap-3">
        <ExternalLink className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <div>
          <span className="font-medium text-foreground">Future integration:</span> when wired up,
          each space writes to its own Google Calendar (4 calendars total). Reads from Peerspace and
          Giggster events on those calendars are honored as blocked time. Confirmation emails are
          sent through Resend. None of this is live in the prototype.
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-3.5 py-2.5 flex items-center justify-between gap-4">
      <span className="text-eyebrow">{label}</span>
      <span className="text-sm font-medium text-right">{value}</span>
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md border border-dashed border-card-border bg-background/40 px-6 py-12 text-center">
      <div className="text-base font-medium tracking-tight">{title}</div>
      <p className="mt-1.5 text-sm text-muted-foreground max-w-md mx-auto">{detail}</p>
    </div>
  );
}

// ----- Admin gate (PIN, in-memory only) -----

function AdminGate() {
  const { unlock } = useAdmin();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pin.trim()) return;
    setSubmitting(true);
    setError(null);
    const ok = await unlock(pin.trim());
    setSubmitting(false);
    if (!ok) {
      setError("Incorrect PIN. Try again.");
      setPin("");
    }
  }

  return (
    <div className="max-w-[1280px] mx-auto px-5 lg:px-8 py-12 lg:py-20">
      <div className="max-w-md mx-auto">
        <div className="text-eyebrow mb-2 flex items-center gap-2">
          <KeyRound className="w-3 h-3" /> Operator console
        </div>
        <h1 className="text-xl lg:text-[1.875rem] font-semibold tracking-tight leading-[1.15]">
          Enter admin PIN
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Studio Clyx operators only. The PIN is set via the{" "}
          <span className="font-mono text-foreground">ADMIN_PIN</span> env var. In
          simulation mode the default PIN is{" "}
          <span className="font-mono text-foreground">0000</span>.
        </p>

        <form
          onSubmit={handleSubmit}
          className="mt-6 rounded-md border border-card-border bg-card p-5 space-y-3"
          data-testid="form-admin-gate"
        >
          <Input
            type="password"
            inputMode="numeric"
            autoFocus
            placeholder="••••"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            data-testid="input-admin-pin"
            className="font-mono tracking-[0.3em] text-center text-base"
          />
          {error && (
            <div className="text-xs text-destructive font-medium" data-testid="text-admin-error">
              {error}
            </div>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={submitting || !pin.trim()}
            data-testid="button-admin-unlock"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <ShieldCheck className="w-4 h-4 mr-1.5" />
            )}
            Unlock console
          </Button>
        </form>

        <p className="mt-4 text-[11px] text-muted-foreground leading-relaxed">
          PIN state lives only in memory — not in localStorage, sessionStorage, or
          cookies. Refreshing the page locks the console again.
        </p>
      </div>
    </div>
  );
}

// ----- Integrations callout (server-driven simulation/live status) -----

function IntegrationsCallout({
  status,
  loading,
}: {
  status: IntegrationStatus | undefined;
  loading: boolean;
}) {
  if (loading || !status) {
    return (
      <div className="mb-5 rounded-md border border-dashed border-card-border bg-background/40 px-4 py-3 text-xs text-muted-foreground">
        Loading integration status…
      </div>
    );
  }

  const SPACE_LABELS: Record<string, string> = {
    "studio-1": "Studio 1",
    "studio-2": "Studio 2",
    "studio-3": "Studio 3",
    "lincoln-apartment": "Lincoln Apartment",
  };
  const liveSpaceLabels = status.google.detail
    .filter((d) => d.live)
    .map((d) => SPACE_LABELS[d.spaceId] ?? d.spaceId);
  const offlineSpaceLabels = status.google.detail
    .filter((d) => !d.live)
    .map((d) => SPACE_LABELS[d.spaceId] ?? d.spaceId);

  const googleDetail = status.google.credentialError
    ? `Service account JSON invalid: ${status.google.credentialError}. Set ${status.google.credentialEnv} to a single-line JSON.`
    : status.google.mode === "live"
    ? `Live — events post to all ${status.google.totalSpaces} space calendars.`
    : status.google.liveSpaces > 0
    ? `Live for ${status.google.liveSpaces}/${status.google.totalSpaces} spaces (${liveSpaceLabels.join(", ")}). Simulation for: ${offlineSpaceLabels.join(", ")}.`
    : !status.google.credentialConfigured
    ? `Set ${status.google.credentialEnv} (service account JSON) and per-space calendar IDs to go live.`
    : `Service account is set; missing per-space calendar IDs for: ${offlineSpaceLabels.join(", ")}.`;

  const items = [
    {
      key: "google",
      name: "Google Calendar",
      mode: status.google.mode,
      detail: googleDetail,
      env: [status.google.credentialEnv, ...status.google.detail.map((d) => d.envVar)],
    },
    {
      key: "resend",
      name: "Resend email",
      mode: status.resend.mode,
      detail:
        status.resend.mode === "live"
          ? "Live — confirmation emails delivered via Resend."
          : `Confirmation emails will deliver once ${status.resend.credentialEnv} and ${status.resend.fromEnv} are set.`,
      env: [status.resend.credentialEnv, status.resend.fromEnv],
    },
    {
      key: "admin",
      name: "Admin gate",
      mode: status.adminGate.mode,
      detail:
        status.adminGate.mode === "live"
          ? "Custom PIN configured via env var."
          : `Default PIN is 0000. Set ${status.adminGate.credentialEnv} to override.`,
      env: [status.adminGate.credentialEnv],
    },
  ] as const;

  const anySim = items.some((i) => i.mode === "simulation");

  return (
    <div
      className={cn(
        "mb-5 rounded-md border bg-card",
        anySim ? "border-amber-500/30" : "border-primary/30"
      )}
      data-testid="callout-integrations"
    >
      <div className="px-4 py-3 border-b border-card-border flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ActivityIcon className="w-3.5 h-3.5 text-muted-foreground" />
          <div className="text-eyebrow">Integrations</div>
          <span
            className={cn(
              "font-mono text-[10px] px-1.5 py-0.5 rounded-sm border",
              anySim
                ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : "border-primary/40 bg-primary/10 text-primary"
            )}
            data-testid="text-integrations-mode"
          >
            {anySim ? "Simulation mode" : "Live"}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground hidden md:block">
          Status is read from the server. Set env vars to swap any service into live mode.
        </p>
      </div>
      <ul className="divide-y divide-card-border">
        {items.map((item) => (
          <li
            key={item.key}
            className="px-4 py-3 flex items-start justify-between gap-4 text-sm"
            data-testid={`integration-${item.key}`}
          >
            <div>
              <div className="font-medium tracking-tight">{item.name}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{item.detail}</div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span
                className={cn(
                  "font-mono text-[10px] px-1.5 py-0.5 rounded-sm border",
                  item.mode === "live"
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                )}
              >
                {item.mode}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground text-right break-all max-w-[260px]">
                {item.env.join(", ")}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
