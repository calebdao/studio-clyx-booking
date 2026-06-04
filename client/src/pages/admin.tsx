import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AddOnCatalogItem,
  Booking,
  computePriceBreakdown,
  fmtDay,
  fmtMoney,
  fmtTime12,
  SPACES,
  spaceById,
  activityById,
  STUDIO_OWNER_EMAIL,
} from "@/lib/booking-data";
import {
  CreateAddOnFields,
  useAdmin,
  useAdminAddOns,
  useAddOnMutations,
  useBookings,
  useAgentConversations,
  useAgentDraftActions,
  type AgentConversation,
  type AgentDraft,
} from "@/lib/booking-store";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CheckCircle2,
  Mail,
  Clock,
  Lock,
  X,
  AlertTriangle,
  ExternalLink,
  ShieldCheck,
  ShieldX,
  KeyRound,
  Activity as ActivityIcon,
  Loader2,
  Plus,
  Trash2,
  Power,
  PowerOff,
  Users,
  Wine,
  ShoppingBag,
  ImageOff,
  Inbox,
  Send,
  MessageSquare,
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
    rejectBookingAsync,
    now,
    mutationPendingId,
  } = useBookings();
  const { lock } = useAdmin();
  const { toast } = useToast();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [emailToast, setEmailToast] = useState<{
    email: string;
    mode: "live" | "simulation";
    ok: boolean;
    detail?: string;
  } | null>(null);

  const integrations = useQuery<IntegrationStatus>({
    queryKey: ["/api/integrations/status"],
  });

  const agentConversations = useAgentConversations();
  const inboxPending = (agentConversations.data ?? []).filter((c) =>
    c.drafts.some((d) => d.status === "pending")
  ).length;

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

  async function doReject() {
    if (!rejectId) return;
    try {
      await rejectBookingAsync(rejectId);
      setRejectId(null);
      toast({
        title: "Booking rejected",
        description: "Hold removed and calendar slot released.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not reject booking.";
      toast({
        title: "Could not reject booking",
        description: msg.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      });
    }
  }

  const rejectTarget = rejectId ? bookings.find((b) => b.id === rejectId) : null;

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
          <TabsTrigger value="addons" data-testid="tab-addons">
            Add-ons
          </TabsTrigger>
          <TabsTrigger value="inbox" data-testid="tab-inbox">
            <Inbox className="w-3.5 h-3.5 mr-1.5" /> Inbox
            {inboxPending > 0 && (
              <span className="ml-2 font-mono text-[11px] rounded-full bg-amber-500/15 text-amber-700 px-1.5">
                {inboxPending}
              </span>
            )}
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
                      onClick={() => setRejectId(b.id)}
                      disabled={mutationPendingId === b.id}
                      data-testid={`button-reject-${b.id}`}
                    >
                      <ShieldX className="w-3.5 h-3.5 mr-1.5" />
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
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

        {/* ADD-ONS MANAGER */}
        <TabsContent value="addons">
          <AddOnsManager />
        </TabsContent>

        {/* PEERSPACE EMAIL INBOX */}
        <TabsContent value="inbox" className="space-y-3">
          <InboxTab
            conversations={agentConversations.data ?? []}
            loading={agentConversations.isLoading}
          />
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
          {target && (() => {
            const slots = Math.round(
              (new Date(target.end).getTime() - new Date(target.start).getTime()) /
                (30 * 60 * 1000)
            );
            const breakdown = computePriceBreakdown({
              activity: activityById(target.activityId),
              slots,
              guestCount: target.guestCount,
              alcohol: target.alcohol,
              activityId: target.activityId,
              addons: target.addons,
              paymentMethod: target.paymentMethod,
            });
            return (
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
                  label="Payment"
                  value={
                    target.paymentMethod === "card"
                      ? target.paidAt
                        ? "Credit card · paid via Stripe"
                        : "Credit card · awaiting Stripe webhook"
                      : "Zelle"
                  }
                />
                <Row label="Guests" value={`${target.guestCount}`} />
                {target.alcohol && <Row label="Alcohol" value="Yes (+$50)" />}
                {target.addons.length > 0 && (
                  <Row
                    label="Add-ons"
                    value={
                      <span className="text-xs">
                        {target.addons
                          .map((a) =>
                            a.priceType === "flat" ? a.name : `${a.name} × ${a.quantity}`
                          )
                          .join(", ")}
                      </span>
                    }
                  />
                )}
                <div className="px-3.5 py-2.5 space-y-1">
                  {breakdown.lines.map((line, idx) => (
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
                <Row
                  label="Total"
                  value={
                    <span className="font-mono font-semibold">
                      {fmtMoney(breakdown.total)}
                    </span>
                  }
                />
              </div>
            );
          })()}
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

      {/* Reject dialog */}
      <Dialog open={!!rejectId} onOpenChange={(o) => !o && setRejectId(null)}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-reject-booking">
          <DialogHeader>
            <div className="text-eyebrow text-destructive mb-1.5">Reject booking</div>
            <DialogTitle className="tracking-tight">Reject this hold?</DialogTitle>
            <DialogDescription className="leading-relaxed">
              This marks the booking as rejected, removes the Google Calendar hold, and frees the
              slot. The guest is not auto-notified — follow up out-of-band if needed.
            </DialogDescription>
          </DialogHeader>
          {rejectTarget && (
            <div className="mt-2 rounded-md border border-card-border bg-background/40 divide-y divide-card-border text-sm">
              <Row label="Guest" value={`${rejectTarget.guest.firstName} ${rejectTarget.guest.lastName}`} />
              <Row label="Email" value={rejectTarget.guest.email} />
              <Row label="Space" value={spaceById(rejectTarget.spaceId).name} />
              <Row
                label="When"
                value={
                  <span className="font-mono text-xs tabular-nums">
                    {fmtTime12(new Date(rejectTarget.start))} →{" "}
                    {fmtTime12(new Date(rejectTarget.end))} · {fmtDay(new Date(rejectTarget.start))}
                  </span>
                }
              />
            </div>
          )}
          <DialogFooter className="mt-3">
            <Button variant="outline" onClick={() => setRejectId(null)} data-testid="button-cancel-reject">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={doReject}
              disabled={!!rejectTarget && mutationPendingId === rejectTarget.id}
              data-testid="button-confirm-reject"
            >
              {rejectTarget && mutationPendingId === rejectTarget.id ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <ShieldX className="w-3.5 h-3.5 mr-1.5" />
              )}
              Reject booking
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
  const breakdown = computePriceBreakdown({
    activity,
    slots,
    guestCount: booking.guestCount,
    alcohol: booking.alcohol,
    activityId: booking.activityId,
    addons: booking.addons,
    paymentMethod: booking.paymentMethod,
  });

  const isHeld = booking.status === "held";
  const isPending = booking.status === "pending";
  const holdActive = booking.holdActive !== false; // default true if missing
  const remainingMs = booking.holdExpiresAt ? Math.max(0, booking.holdExpiresAt - now.getTime()) : 0;
  const remainingMin = Math.floor(remainingMs / 60000);
  const remainingSec = Math.floor((remainingMs % 60000) / 1000);

  const isExpiringSoon = (isHeld || isPending) && holdActive && remainingMs > 0 && remainingMs < 5 * 60 * 1000;
  const isHoldExpired = (isHeld || isPending) && !holdActive;

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
          {slots * 0.5} hr · {fmtMoney(breakdown.total)}
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] font-mono text-muted-foreground">
          <Users className="w-3 h-3" />
          {booking.guestCount}
        </span>
        {booking.alcohol && (
          <span className="inline-flex items-center gap-1 text-[11px] font-mono text-muted-foreground">
            <Wine className="w-3 h-3" />
            alcohol
          </span>
        )}
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-mono",
            booking.paymentMethod === "card"
              ? booking.paidAt
                ? "border-primary/30 bg-primary/5 text-primary"
                : "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300"
              : "border-card-border bg-background/50 text-muted-foreground"
          )}
          title={
            booking.paymentMethod === "card"
              ? booking.paidAt
                ? "Card paid via Stripe"
                : "Card pending Stripe charge"
              : "Zelle"
          }
        >
          {booking.paymentMethod === "card"
            ? booking.paidAt
              ? "card · paid"
              : "card · pending"
            : "zelle"}
        </span>
        {booking.addons.length > 0 && (
          <span
            className="inline-flex items-center gap-1 text-[11px] font-mono text-muted-foreground"
            title={booking.addons
              .map((a) => (a.priceType === "flat" ? a.name : `${a.name} × ${a.quantity}`))
              .join(", ")}
          >
            <ShoppingBag className="w-3 h-3" />
            {booking.addons.length} add-on{booking.addons.length === 1 ? "" : "s"}
          </span>
        )}
        {(isHeld || isPending) && holdActive && (
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
              : "expiring"}
          </span>
        )}
        {isHoldExpired && (
          <span className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 font-mono text-[11px] border border-muted-foreground/30 bg-muted/40 text-muted-foreground">
            <AlertTriangle className="w-3 h-3" />
            hold expired
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

// ----- Add-ons manager -----

function AddOnsManager() {
  const { data: addons, isLoading } = useAdminAddOns();
  const { create, update, remove } = useAddOnMutations();
  const { toast } = useToast();
  const [editing, setEditing] = useState<AddOnCatalogItem | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleToggleActive(item: AddOnCatalogItem) {
    try {
      await update.mutateAsync({ id: item.id, patch: { active: !item.active } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not update add-on.";
      toast({ title: "Could not update add-on", description: msg.replace(/^\d+:\s*/, ""), variant: "destructive" });
    }
  }

  async function handleDelete(item: AddOnCatalogItem) {
    if (!confirm(`Deactivate "${item.name}"? Guests will no longer see it.`)) return;
    try {
      await remove.mutateAsync(item.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not deactivate add-on.";
      toast({ title: "Could not deactivate", description: msg.replace(/^\d+:\s*/, ""), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium tracking-tight">Add-on catalog</div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Manage the rentals guests can attach to a booking. Deactivating an item hides it without
            losing the price record on past bookings.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)} data-testid="button-create-addon">
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          New add-on
        </Button>
      </div>

      {isLoading ? (
        <div className="rounded-md border border-card-border bg-background/40 px-4 py-6 text-sm text-muted-foreground">
          Loading add-ons…
        </div>
      ) : !addons || addons.length === 0 ? (
        <EmptyState
          title="No add-ons yet"
          detail="Create your first add-on. Guests will see it on the booking page."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {addons.map((item) => (
            <div
              key={item.id}
              data-testid={`row-admin-addon-${item.id}`}
              className={cn(
                "flex gap-3 rounded-md border p-3",
                item.active ? "border-card-border bg-card" : "border-card-border/50 bg-background/40"
              )}
            >
              {item.imageUrl ? (
                <img
                  src={item.imageUrl}
                  alt=""
                  className={cn(
                    "w-16 h-16 rounded-sm object-cover flex-shrink-0",
                    !item.active && "opacity-50"
                  )}
                  loading="lazy"
                />
              ) : (
                <div className="w-16 h-16 rounded-sm bg-muted flex items-center justify-center flex-shrink-0">
                  <ImageOff className="w-4 h-4 text-muted-foreground" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-medium text-sm tracking-tight truncate">{item.name}</div>
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
                <div className="mt-1 flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
                  {item.quantityAvailable != null && <span>qty {item.quantityAvailable}</span>}
                  <span
                    className={cn(
                      "px-1.5 py-0.5 rounded-sm border",
                      item.active
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-muted-foreground/30 bg-muted/40 text-muted-foreground"
                    )}
                  >
                    {item.active ? "active" : "inactive"}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    onClick={() => setEditing(item)}
                    data-testid={`button-edit-addon-${item.id}`}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px]"
                    onClick={() => handleToggleActive(item)}
                    data-testid={`button-toggle-addon-${item.id}`}
                  >
                    {item.active ? (
                      <PowerOff className="w-3 h-3 mr-1" />
                    ) : (
                      <Power className="w-3 h-3 mr-1" />
                    )}
                    {item.active ? "Deactivate" : "Activate"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px] text-destructive hover:text-destructive"
                    onClick={() => handleDelete(item)}
                    data-testid={`button-delete-addon-${item.id}`}
                  >
                    <Trash2 className="w-3 h-3 mr-1" />
                    Remove
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <AddOnEditor
          item={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSubmit={async (values) => {
            try {
              if (editing) {
                await update.mutateAsync({ id: editing.id, patch: values });
              } else {
                await create.mutateAsync(values);
              }
              setCreating(false);
              setEditing(null);
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Could not save add-on.";
              toast({ title: "Could not save", description: msg.replace(/^\d+:\s*/, ""), variant: "destructive" });
            }
          }}
          isSaving={create.isPending || update.isPending}
        />
      )}
    </div>
  );
}

function AddOnEditor({
  item,
  onClose,
  onSubmit,
  isSaving,
}: {
  item: AddOnCatalogItem | null;
  onClose: () => void;
  onSubmit: (values: CreateAddOnFields) => Promise<void>;
  isSaving: boolean;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [price, setPrice] = useState<string>(item ? String(item.price) : "");
  const [priceType, setPriceType] = useState<"per_item" | "flat">(item?.priceType ?? "per_item");
  const [imageUrl, setImageUrl] = useState(item?.imageUrl ?? "");
  const [quantityAvailable, setQuantityAvailable] = useState<string>(
    item?.quantityAvailable != null ? String(item.quantityAvailable) : ""
  );
  const [active, setActive] = useState(item?.active ?? true);

  const priceNum = parseFloat(price);
  const qtyNum = quantityAvailable.trim() === "" ? null : parseInt(quantityAvailable, 10);
  const isValid = name.trim().length > 0 && Number.isFinite(priceNum) && priceNum >= 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;
    await onSubmit({
      name: name.trim(),
      description: description.trim() || null,
      price: priceNum,
      priceType,
      imageUrl: imageUrl.trim() || null,
      quantityAvailable: qtyNum,
      active,
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-addon-editor">
        <DialogHeader>
          <div className="text-eyebrow text-primary mb-1.5">
            {item ? "Edit add-on" : "New add-on"}
          </div>
          <DialogTitle className="tracking-tight">
            {item ? item.name : "Create a new add-on"}
          </DialogTitle>
          <DialogDescription className="leading-relaxed">
            Add-ons appear on the booking page. Pricing applies on top of the hourly room rate.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3" data-testid="form-addon-editor">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. 10 Foldable Chairs"
              data-testid="input-addon-name"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Price (USD)</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="45"
                className="font-mono"
                data-testid="input-addon-price"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Pricing</Label>
              <Select value={priceType} onValueChange={(v) => setPriceType(v as "per_item" | "flat")}>
                <SelectTrigger data-testid="select-addon-price-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="per_item">Per item</SelectItem>
                  <SelectItem value="flat">Flat fee</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">
                Quantity available <span className="text-muted-foreground text-[10px]">optional</span>
              </Label>
              <Input
                type="number"
                min="0"
                value={quantityAvailable}
                onChange={(e) => setQuantityAvailable(e.target.value)}
                placeholder="unlimited"
                className="font-mono"
                data-testid="input-addon-quantity"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Status</Label>
              <label className="flex items-center gap-2 rounded-md border border-card-border bg-card px-3 h-9 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                  data-testid="checkbox-addon-active"
                />
                <span>{active ? "Active" : "Inactive"}</span>
              </label>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              Image URL <span className="text-muted-foreground text-[10px]">optional</span>
            </Label>
            <Input
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://..."
              className="font-mono text-xs"
              data-testid="input-addon-image-url"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              Description <span className="text-muted-foreground text-[10px]">optional</span>
            </Label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short note shown to guests…"
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="textarea-addon-description"
            />
          </div>

          <DialogFooter className="mt-1">
            <Button type="button" variant="outline" onClick={onClose} data-testid="button-cancel-addon">
              Cancel
            </Button>
            <Button type="submit" disabled={!isValid || isSaving} data-testid="button-save-addon">
              {isSaving ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
              )}
              {item ? "Save changes" : "Create add-on"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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

// ----- Peerspace email Inbox -----

function fmtAgentTime(ms: number) {
  return new Date(ms).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function InboxTab({
  conversations,
  loading,
}: {
  conversations: AgentConversation[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="text-sm text-muted-foreground py-10 text-center">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading inbox…
      </div>
    );
  }
  if (conversations.length === 0) {
    return (
      <div className="border rounded-xl p-10 text-center">
        <MessageSquare className="w-6 h-6 mx-auto mb-3 text-muted-foreground" />
        <p className="text-sm font-medium">No Peerspace messages yet</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
          When a Peerspace notification email is forwarded in, the assistant
          drafts a reply here for you to approve, edit, or reject.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {conversations.map((c) => (
        <ConversationCard key={c.id} convo={c} />
      ))}
    </div>
  );
}

function ConversationCard({ convo }: { convo: AgentConversation }) {
  const actions = useAgentDraftActions();
  const { toast } = useToast();

  const pendingDraft =
    [...convo.drafts].reverse().find((d) => d.status === "pending") ?? null;
  const sentDraft =
    [...convo.drafts].reverse().find((d) => d.status === "sent") ?? null;
  const errorDraft =
    [...convo.drafts].reverse().find((d) => d.status === "error") ?? null;

  const initial = pendingDraft
    ? pendingDraft.editedBody ?? pendingDraft.proposedBodyText ?? ""
    : "";
  const [text, setText] = useState(initial);
  useEffect(() => {
    setText(
      pendingDraft
        ? pendingDraft.editedBody ?? pendingDraft.proposedBodyText ?? ""
        : ""
    );
    // Reset the editor whenever a different pending draft surfaces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDraft?.id]);

  const busy = actions.isPending;

  async function run(action: "approve" | "reject" | "edit") {
    if (!pendingDraft) return;
    const proposed = pendingDraft.proposedBodyText ?? "";
    const edited = text.trim() && text !== proposed ? text : undefined;
    const editedBody =
      action === "edit"
        ? text.trim()
          ? text
          : undefined
        : edited;
    try {
      const r = await actions.mutateAsync({
        draftId: pendingDraft.id,
        action,
        editedBody,
      });
      if (action === "approve") {
        toast({
          title: r.simulated ? "Reply sent (simulation)" : "Reply sent",
          description: r.simulated
            ? "Resend isn't configured — the reply was logged, not emailed."
            : "Your reply was sent back to the Peerspace thread.",
        });
      } else if (action === "reject") {
        toast({ title: "Draft rejected", description: "Nothing was sent." });
      } else {
        toast({ title: "Edit saved" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Could not ${action}.`;
      toast({
        title: `Could not ${action} draft`,
        description: msg.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      });
    }
  }

  return (
    <div className="border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-muted/30 border-b">
        <div className="min-w-0">
          <div className="font-medium text-sm truncate">
            {convo.guestName || convo.guestEmail || "Peerspace guest"}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {convo.subject || "(no subject)"}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {convo.bookingId && (
            <span className="text-[10px] font-mono rounded-full bg-emerald-500/15 text-emerald-700 px-2 py-0.5">
              booking linked
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">
            {fmtAgentTime(convo.updatedAt)}
          </span>
        </div>
      </div>

      {/* Thread */}
      <div className="px-4 py-3 space-y-3 max-h-[320px] overflow-y-auto">
        {convo.messages.map((m) => {
          const inbound = m.direction === "inbound";
          return (
            <div
              key={m.id}
              className={cn(
                "rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap",
                inbound
                  ? "bg-background"
                  : "bg-primary/5 border-primary/20"
              )}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {inbound
                    ? convo.guestName || m.fromAddress || "Guest"
                    : "Studio Clyx"}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {fmtAgentTime(m.createdAt)}
                </span>
              </div>
              {m.bodyText || (m.bodyHtml ? "(HTML message)" : "(empty)")}
            </div>
          );
        })}
      </div>

      {/* Draft / actions */}
      <div className="px-4 py-3 border-t bg-muted/20">
        {pendingDraft ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-eyebrow">Proposed reply</span>
              <span className="text-[10px] font-mono text-muted-foreground">
                {pendingDraft.model || "draft"}
              </span>
            </div>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              className="text-sm"
              data-testid={`textarea-draft-${pendingDraft.id}`}
            />
            <div className="flex flex-wrap gap-2 justify-end">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => run("reject")}
                data-testid={`button-reject-draft-${pendingDraft.id}`}
              >
                <X className="w-3.5 h-3.5 mr-1.5" /> Reject
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => run("edit")}
              >
                Save edit
              </Button>
              <Button
                size="sm"
                disabled={busy || !text.trim()}
                onClick={() => run("approve")}
                data-testid={`button-approve-draft-${pendingDraft.id}`}
              >
                {busy ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5 mr-1.5" />
                )}
                Approve &amp; send
              </Button>
            </div>
          </div>
        ) : errorDraft ? (
          <div className="text-sm text-destructive flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Draft generation failed</div>
              <div className="text-xs text-muted-foreground break-all">
                {errorDraft.error}
              </div>
            </div>
          </div>
        ) : sentDraft ? (
          <div className="text-sm text-emerald-700 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            Replied{sentDraft.sentAt ? ` · ${fmtAgentTime(sentDraft.sentAt)}` : ""}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            No draft yet. (Is <span className="font-mono">AGENT_ENABLED</span>{" "}
            set to <span className="font-mono">true</span>?)
          </div>
        )}
      </div>
    </div>
  );
}
