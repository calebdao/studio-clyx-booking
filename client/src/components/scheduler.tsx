import { useMemo, useRef, useState, useEffect } from "react";
import { ChevronLeft, ChevronRight, Lock, Clock, Calendar } from "lucide-react";
import {
  ACTIVITIES,
  Activity,
  Booking,
  BOOKING_WINDOW_MONTHS,
  bookingsToOccupiedSlots,
  fmtDay,
  fmtTime12,
  MIN_DURATION_HOURS,
  MIN_LEAD_HOURS,
  NY_TZ,
  nyParts,
  nyWallToUtc,
  SLOT_MINUTES,
  Space,
} from "@/lib/booking-data";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  space: Space;
  activity: Activity;
  bookings: Booking[];
  selection: { start: Date; end: Date } | null;
  onSelectionChange: (sel: { start: Date; end: Date } | null) => void;
};

// Internal selection state allows a 'start-only' phase (end === start)
type Phase = "empty" | "choosing-end" | "complete";

const DAYS_VISIBLE = 7;

// "9 AM", "12 PM", "11 PM" — the hour-rail label. `hour` is a NY wall-clock hour
// (0–23), so no timezone conversion is needed here.
function hourLabel(hour: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${period}`;
}

export function Scheduler({ space, activity, bookings, selection, onSelectionChange }: Props) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // All day/slot values below are ABSOLUTE instants anchored to New York wall
  // clock (built via nyWallToUtc), never the browser's local zone. That's what
  // makes the grid identical for a guest in Madrid and one in Brooklyn.
  // `today` = NY midnight of the current NY calendar day.
  const today = useMemo(() => {
    const p = nyParts(new Date());
    return nyWallToUtc(p.year, p.month - 1, p.day, 0, 0);
  }, []);

  const maxDate = useMemo(() => {
    const p = nyParts(today);
    return nyWallToUtc(p.year, p.month - 1 + BOOKING_WINDOW_MONTHS, p.day, 0, 0);
  }, [today]);

  const [weekStart, setWeekStart] = useState<Date>(today);

  // Days currently visible — NY midnights, so the day columns are NY days.
  const days = useMemo(() => {
    const p = nyParts(weekStart);
    const arr: Date[] = [];
    for (let i = 0; i < DAYS_VISIBLE; i++) {
      arr.push(nyWallToUtc(p.year, p.month - 1, p.day + i, 0, 0));
    }
    return arr;
  }, [weekStart]);

  // 48 half-hour rows, described by NY wall-clock hour/minute (no zone ambiguity).
  const rowMeta = useMemo(
    () =>
      Array.from({ length: 48 }, (_, i) => ({
        hour: Math.floor(i / 2),
        minute: i % 2 === 0 ? 0 : 30,
      })),
    []
  );

  // Precompute the bookable instant for every [day][row] cell once per week so
  // hover re-renders stay cheap. slotGrid[dayIdx][rowIdx] is a NY-anchored Date.
  const slotGrid = useMemo(
    () =>
      days.map((d) => {
        const p = nyParts(d);
        return rowMeta.map((r) =>
          nyWallToUtc(p.year, p.month - 1, p.day, r.hour, r.minute)
        );
      }),
    [days, rowMeta]
  );

  // Occupied slots for this space (across all bookings, regardless of day)
  const occupiedMap = useMemo(
    () => bookingsToOccupiedSlots(bookings, space.id),
    [bookings, space.id]
  );

  const minBookableTime = useMemo(
    () => new Date(now.getTime() + MIN_LEAD_HOURS * 60 * 60 * 1000),
    [now]
  );

  // For range hover preview
  const [hoverEnd, setHoverEnd] = useState<Date | null>(null);

  // Whenever selection changes (especially to 'complete' or 'empty'), drop hover
  useEffect(() => {
    setHoverEnd(null);
  }, [selection?.start, selection?.end]);

  const start = selection?.start ?? null;
  const end = selection?.end ?? null;
  const phase: Phase =
    !start || !end
      ? "empty"
      : start.getTime() === end.getTime()
      ? "choosing-end"
      : "complete";
  const minSlots = (MIN_DURATION_HOURS * 60) / SLOT_MINUTES;

  // Track ref to the time column for syncing scroll
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to a sensible time on mount (scroll to current hour - 1, or 9am if it's far off)
  useEffect(() => {
    if (!scrollRef.current) return;
    const targetHour = today.getTime() === days[0].getTime() ? Math.max(0, nyParts(now).hour - 1) : 9;
    const slotHeight = 28; // px
    scrollRef.current.scrollTop = targetHour * 2 * slotHeight;
  }, []); // mount only

  function handleSlotClick(slotDate: Date) {
    if (!isSlotInteractive(slotDate)) return;

    if (phase !== "choosing-end") {
      // First click: set start only (end === start as a sentinel for 'choosing-end').
      // Validate that at least the minimum duration is free — if not, ignore.
      const minEnd = addSlots(slotDate, minSlots);
      if (minEnd > maxDate) return;
      if (!isRangeFree(slotDate, minEnd)) return;
      onSelectionChange({ start: slotDate, end: slotDate });
      return;
    }

    // phase === 'choosing-end'
    if (!start) return;
    let endCandidate = addSlots(slotDate, 1); // end-exclusive: include the clicked slot
    if (endCandidate <= start) {
      // user clicked at or before start — restart with this as the new start
      const minEnd = addSlots(slotDate, minSlots);
      if (minEnd > maxDate) return;
      if (!isRangeFree(slotDate, minEnd)) return;
      onSelectionChange({ start: slotDate, end: slotDate });
      return;
    }
    const minEnd = addSlots(start, minSlots);
    if (endCandidate < minEnd) endCandidate = minEnd;
    if (!isRangeFree(start, endCandidate)) {
      const truncated = firstConflict(start, endCandidate);
      if (!truncated) return;
      // Only honor truncation if it still meets the minimum.
      if (truncated < addSlots(start, minSlots)) return;
      onSelectionChange({ start, end: truncated });
      return;
    }
    onSelectionChange({ start, end: endCandidate });
  }

  function addSlots(d: Date, n: number) {
    return new Date(d.getTime() + n * SLOT_MINUTES * 60 * 1000);
  }

  function isSlotInteractive(slotDate: Date): boolean {
    // Past min lead time?
    if (slotDate < minBookableTime) return false;
    // Beyond booking window?
    if (slotDate >= maxDate) return false;
    // Occupied?
    if (occupiedMap.has(slotDate.toISOString())) return false;
    return true;
  }

  function isRangeFree(a: Date, b: Date) {
    let cur = new Date(a);
    while (cur < b) {
      if (occupiedMap.has(cur.toISOString())) return false;
      cur = addSlots(cur, 1);
    }
    return true;
  }

  // Returns first occupied slot's start at or after `a` and before `b`, or null
  function firstConflict(a: Date, b: Date): Date | null {
    let cur = new Date(a);
    while (cur < b) {
      if (occupiedMap.has(cur.toISOString())) return cur;
      cur = addSlots(cur, 1);
    }
    return null;
  }

  function inSelection(slotDate: Date): boolean {
    if (!start) return false;
    // While choosing end, optionally show a hover-preview range.
    if (phase === "choosing-end") {
      const e = hoverEnd;
      if (!e || e <= start) return slotDate.getTime() === start.getTime();
      return slotDate >= start && slotDate < e;
    }
    if (!end) return false;
    if (end <= start) return slotDate.getTime() === start.getTime();
    return slotDate >= start && slotDate < end;
  }

  function handleHover(slotDate: Date) {
    if (phase !== "choosing-end" || !start) return;
    if (slotDate < start) {
      setHoverEnd(null);
      return;
    }
    let candidate = addSlots(slotDate, 1);
    const minEnd = addSlots(start, minSlots);
    if (candidate < minEnd) candidate = minEnd;
    if (!isRangeFree(start, candidate)) {
      const conflict = firstConflict(start, candidate);
      if (!conflict) {
        setHoverEnd(null);
        return;
      }
      if (conflict < addSlots(start, minSlots)) {
        setHoverEnd(null);
        return;
      }
      candidate = conflict;
      setHoverEnd(candidate);
      return;
    }
    setHoverEnd(candidate);
  }

  function shiftWeek(delta: number) {
    const p = nyParts(weekStart);
    const next = nyWallToUtc(p.year, p.month - 1, p.day + delta * DAYS_VISIBLE, 0, 0);
    if (next < today) {
      setWeekStart(today);
      return;
    }
    setWeekStart(next);
  }

  function clearHover() {
    setHoverEnd(null);
  }

  function jumpToToday() {
    setWeekStart(today);
  }

  const canGoBack = weekStart > today;
  const lastVisibleDay = days[DAYS_VISIBLE - 1];
  const canGoForward = lastVisibleDay < maxDate;

  return (
    <div className="bg-card border border-card-border rounded-md overflow-hidden">
      {/* Header — week navigation */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-card-border">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-primary" aria-hidden />
          <div>
            <div className="text-eyebrow">Availability</div>
            <div className="text-sm font-medium" data-testid="text-week-range">
              {fmtDay(days[0])} — {fmtDay(lastVisibleDay)}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              All times shown in New York (ET)
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => shiftWeek(-1)}
            disabled={!canGoBack}
            data-testid="button-week-prev"
            aria-label="Previous week"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={jumpToToday}
            data-testid="button-week-today"
          >
            Today
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => shiftWeek(1)}
            disabled={!canGoForward}
            data-testid="button-week-next"
            aria-label="Next week"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Day headers */}
      <div className="grid border-b border-card-border bg-background/40" style={{ gridTemplateColumns: "56px repeat(7, minmax(0, 1fr))" }}>
        <div className="p-2" />
        {days.map((d) => {
          const isToday = d.getTime() === today.getTime();
          return (
            <div
              key={d.toISOString()}
              className={cn(
                "px-2 py-2 text-center border-l border-card-border",
                isToday && "bg-primary/5"
              )}
            >
              <div className="text-eyebrow">
                {d.toLocaleDateString("en-US", { timeZone: NY_TZ, weekday: "short" })}
              </div>
              <div className={cn("text-sm font-medium tabular-nums", isToday && "text-primary")}>
                {d.toLocaleDateString("en-US", { timeZone: NY_TZ, month: "numeric", day: "numeric" })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Grid body */}
      <div ref={scrollRef} className="overflow-y-auto max-h-[560px] relative">
        <div
          className="grid relative"
          style={{ gridTemplateColumns: "56px repeat(7, minmax(0, 1fr))" }}
          onMouseLeave={() => setHoverEnd(null)}
        >
          {rowMeta.map((row, slotIdx) => {
            const isHourMark = row.minute === 0;
            const labelSlot = slotIdx % 2 === 0; // show label on hour marks
            return (
              <div key={`row-${slotIdx}`} className="contents">
                {/* time label column */}
                <div
                  className={cn(
                    "h-7 text-[10px] font-mono text-muted-foreground/80 px-1.5 flex items-start justify-end pt-0.5 select-none",
                    !isHourMark && "text-transparent",
                    isHourMark && "border-t border-card-border"
                  )}
                >
                  {labelSlot ? hourLabel(row.hour) : ""}
                </div>
                {/* 7 day columns */}
                {days.map((d, dayIdx) => {
                  const slotDate = slotGrid[dayIdx][slotIdx];
                  const occupied = occupiedMap.get(slotDate.toISOString());
                  const tooEarly = slotDate < minBookableTime;
                  const beyondWindow = slotDate >= maxDate;
                  const interactive = !occupied && !tooEarly && !beyondWindow;
                  const selected = inSelection(slotDate);
                  const isStart = start && slotDate.getTime() === start.getTime();
                  const isFirstOfHour = row.minute === 0;
                  const hour = row.hour;
                  const isNight = hour >= 20 || hour < 6;

                  let statusLabel = "";
                  if (occupied) {
                    statusLabel =
                      occupied.status === "confirmed"
                        ? "Booked"
                        : occupied.status === "held"
                        ? "Held"
                        : "Pending";
                  } else if (tooEarly) statusLabel = "Past lead time";
                  else if (beyondWindow) statusLabel = "Beyond window";

                  return (
                    <button
                      key={`cell-${slotIdx}-${dayIdx}`}
                      type="button"
                      onClick={() => handleSlotClick(slotDate)}
                      onMouseEnter={() => handleHover(slotDate)}
                      disabled={!interactive}
                      data-testid={`slot-${space.id}-${slotDate.toISOString()}`}
                      title={
                        statusLabel ||
                        `${fmtTime12(slotDate)} · ${slotDate.toLocaleDateString("en-US", { timeZone: NY_TZ, month: "short", day: "numeric" })}`
                      }
                      aria-label={`${fmtTime12(slotDate)} on ${slotDate.toLocaleDateString("en-US", { timeZone: NY_TZ, weekday: "long", month: "long", day: "numeric" })}${statusLabel ? `, ${statusLabel}` : ""}`}
                      className={cn(
                        "slot-cell relative h-7 border-l border-card-border text-left",
                        isFirstOfHour && "border-t border-card-border",
                        // night hours: subtle cool tint on available, unselected
                        // cells. Dropped when selected so the primary highlight
                        // (same @layer utilities) isn't shadowed by the tint.
                        interactive && isNight && !selected && "slot-night",
                        // base
                        interactive && "hover:bg-primary/10 cursor-pointer",
                        // disabled / occupied — diagonal hatch marks the whole block as blocked
                        occupied && "slot-blocked",
                        occupied?.status === "confirmed" && "bg-foreground/[0.08] text-muted-foreground cursor-not-allowed",
                        occupied?.status === "held" && "bg-amber-500/10 text-muted-foreground cursor-not-allowed",
                        occupied?.status === "pending" && "bg-amber-500/15 text-muted-foreground cursor-not-allowed",
                        // greyed for lead-time/window
                        (tooEarly || beyondWindow) && "bg-muted/30 cursor-not-allowed text-muted-foreground/50",
                        // selection
                        selected && "bg-primary text-primary-foreground hover:bg-primary",
                        isStart && "ring-2 ring-primary ring-inset"
                      )}
                    >
                      {/* Render booking glyph in the first slot of an occupied block */}
                      {occupied && slotDate.toISOString() === occupied.start && (
                        <span className="absolute inset-x-0 top-0 px-1.5 py-0.5 text-[10px] font-medium tracking-tight truncate flex items-center gap-1">
                          <Lock className="w-2.5 h-2.5 shrink-0" aria-hidden />
                          <span className="truncate">
                            {occupied.status === "confirmed"
                              ? "Booked"
                              : occupied.status === "held"
                              ? "On hold"
                              : "Pending pmt"}
                          </span>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 border-t border-card-border bg-background/30 text-xs">
        <LegendSwatch className="bg-card border" label="Available" />
        <LegendSwatch className="bg-primary" label="Your selection" />
        <LegendSwatch className="slot-blocked bg-foreground/[0.08] text-muted-foreground" label="Booked" />
        <LegendSwatch className="slot-blocked bg-amber-500/15 text-muted-foreground" label="Held / pending" />
        <LegendSwatch className="bg-muted/30" label="Outside window" />
        <LegendSwatch className="slot-night border" label="Night hours" />
        <span className="ml-auto text-muted-foreground flex items-center gap-1.5">
          <Clock className="w-3 h-3" />
          <span className="font-mono">
            {MIN_LEAD_HOURS}h lead · {MIN_DURATION_HOURS}h minimum · 30-min increments
          </span>
        </span>
      </div>
    </div>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("inline-block w-3 h-3 rounded-sm border-card-border", className)} />
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}
