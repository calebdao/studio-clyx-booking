import { storage } from "./storage";
import { sendAddonReminderEmail } from "./integrations";

// ---------------------------------------------------------------------------
// Peerspace add-on prep reminder: capture each booking's equipment add-ons from
// the confirmation / "booking updated" emails, then email the operator at 6 PM
// (NY) the night before listing what to prepare. Peerspace truncates the email's
// add-on list to ~5 items + "See all add-ons", so we flag when the list may be
// incomplete and include the booking link.
// ---------------------------------------------------------------------------

const SPACE_LABELS: Record<string, string> = {
  "studio-1": "Studio 1",
  "studio-2": "Studio 2",
  "studio-3": "Studio 3",
  "lincoln-apartment": "Lincoln Apartment",
};

function reminderHourET(): number {
  const n = Number(process.env.AGENT_REMINDER_HOUR_ET || 18);
  return Math.min(23, Math.max(0, Number.isFinite(n) ? n : 18));
}

export interface AddonItem {
  name: string;
  qty: number;
}

// ----- Detection -----

export function isBookingUpdate(subject: string | null, text: string | null): boolean {
  const s = `${subject || ""}\n${text || ""}`;
  return /has been updated/i.test(s) || /accepted your booking update/i.test(s);
}

// ----- Parsing -----

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function detectStudio(text: string): string | null {
  const rn = text.match(/studio\s*clyx\s*(iii|ii|i)\b/i);
  if (rn) {
    const r = rn[1].toLowerCase();
    if (r === "iii") return "studio-3";
    if (r === "ii") return "studio-2";
    if (r === "i") return "studio-1";
  }
  if (/lincoln/i.test(text)) return "lincoln-apartment";
  return null;
}

function extractGuest(text: string): string | null {
  let m = text.match(/reply to this email to message\s+(.+?)\s*[\n.]/i);
  if (m) return m[1].trim();
  m = text.match(/booking is confirmed with\s+(.+?)\s+on\b/i);
  if (m) return m[1].trim();
  m = text.match(/^(.+?)\s+booked your space/im);
  if (m) return m[1].trim();
  return null;
}

// The Peerspace booking id (24-hex) lives inside the base64 tracking links; it's
// stable across the confirmation and all updates, so it's our booking key.
function extractBookingId(text: string): string | null {
  const re = /[?&]p=([A-Za-z0-9_-]+={0,2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    try {
      let b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      const idm = decoded.match(/inbox(?:%2F|\/)([0-9a-f]{24})/i);
      if (idm) return idm[1].toLowerCase();
    } catch {
      /* ignore */
    }
  }
  return null;
}

function parseDate(text: string): { y: number; mo: number; d: number } | null {
  const m = text.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i
  );
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
  if (mo === undefined) return null;
  return { y: parseInt(m[3], 10), mo, d: parseInt(m[2], 10) };
}

function parseStartTime(text: string): { h: number; m: number } | null {
  const idx = text.search(/Date and time/i);
  const region = idx !== -1 ? text.slice(idx, idx + 220) : text;
  const m = region.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  const h = (parseInt(m[1], 10) % 12) + (/pm/i.test(m[3]) ? 12 : 0);
  return { h, m: parseInt(m[2], 10) };
}

function nyOffsetMinutes(utc: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(utc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return (asIfUtc - utc.getTime()) / 60000;
}

function nyWallToEpoch(y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  let off = nyOffsetMinutes(new Date(guess));
  let epoch = guess - off * 60000;
  off = nyOffsetMinutes(new Date(epoch));
  return guess - off * 60000;
}

// Parse the email's "Add-ons" list. Returns items + whether it's likely
// truncated (Peerspace caps the email at ~5 with a "See all add-ons" link).
export function parseAddons(text: string): { items: AddonItem[]; truncated: boolean } {
  const start = text.search(/(^|\n)\s*Add-ons\b/i);
  if (start === -1) return { items: [], truncated: false };
  let region = text.slice(start).replace(/^.*Add-ons\b/i, "");
  const endRe = /see all add-ons|payment details|payouts will be|©|\bterms\b/i;
  const em = region.search(endRe);
  if (em !== -1) region = region.slice(0, em);

  const lines = region
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const items: AddonItem[] = [];
  let name = "";
  for (const line of lines) {
    const inline = line.match(/^(.*\S)\s+x\s*(\d+)$/i);
    const qtyOnly = line.match(/^x\s*(\d+)$/i);
    if (qtyOnly) {
      if (name) {
        items.push({ name: name.trim(), qty: parseInt(qtyOnly[1], 10) });
        name = "";
      }
    } else if (inline) {
      items.push({
        name: ((name ? name + " " : "") + inline[1]).trim(),
        qty: parseInt(inline[2], 10),
      });
      name = "";
    } else {
      name = name ? `${name} ${line}` : line;
    }
  }
  // Peerspace caps the email's add-on list at 5; hitting 5 means there may be
  // more that aren't in the email.
  return { items, truncated: items.length >= 5 };
}

// ----- Capture (from confirmation / update emails) -----

export function captureBookingAddons(
  subject: string | null,
  text: string | null,
  emailDate: Date | null,
  isUpdate: boolean
): void {
  const blob = `${subject || ""}\n${text || ""}`;
  const body = text || "";
  const { items, truncated } = parseAddons(body);
  // Only track bookings that have add-ons (or updates, which may clear them).
  if (items.length === 0 && !isUpdate) return;

  const bookingId = extractBookingId(body);
  const studio = detectStudio(blob);
  const guest = extractGuest(body);
  const date = parseDate(body);
  const time = parseStartTime(body);
  const startEpoch =
    date && time ? nyWallToEpoch(date.y, date.mo, date.d, time.h, time.m) : null;

  const key =
    bookingId ||
    (guest && studio && date
      ? `${guest.toLowerCase()}|${studio}|${date.y}-${date.mo + 1}-${date.d}`
      : null);
  if (!key) {
    console.warn("[addon-reminder] couldn't derive a booking key; skipping");
    return;
  }

  const dateTimeText = (() => {
    const dm = body.match(
      /([A-Z][a-z]{2,},?\s+[A-Z][a-z]{2,}\s+\d{1,2},?\s+\d{4}[\s\S]{0,40}?(?:AM|PM)[^\n]*)/
    );
    return dm ? dm[1].replace(/\s+/g, " ").trim().slice(0, 80) : null;
  })();

  storage.upsertPeerspaceBooking({
    bookingKey: key,
    guestName: guest,
    studio,
    dateTimeText,
    startEpoch,
    addons: JSON.stringify(items),
    addonsTruncated: truncated,
    viewLink: bookingId ? `https://www.peerspace.com/inbox/${bookingId}` : null,
    sourceEmailAt: emailDate ? emailDate.getTime() : Date.now(),
  });
  console.log(
    `[addon-reminder] captured booking ${key} (${studio ?? "?"}) with ${items.length} add-on(s)${truncated ? " [truncated]" : ""}`
  );
}

// ----- Nightly scheduler -----

function nyParts(d: Date): { y: number; mo: number; day: number; hour: number } {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric",
  }).formatToParts(d);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: get("year"), mo: get("month"), day: get("day"), hour: get("hour") };
}

function nyDateStr(epoch: number): string {
  const p = nyParts(new Date(epoch));
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function tomorrowNyStr(now: Date): string {
  const p = nyParts(now);
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.day, 12));
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

async function runReminderCheck(): Promise<void> {
  const now = new Date();
  if (nyParts(now).hour < reminderHourET()) return; // not reminder time yet
  const tomorrow = tomorrowNyStr(now);
  for (const b of storage.listAddonReminderCandidates()) {
    if (b.startEpoch == null) continue;
    if (nyDateStr(b.startEpoch) !== tomorrow) continue;
    let items: AddonItem[] = [];
    try {
      items = JSON.parse(b.addons || "[]");
    } catch {
      items = [];
    }
    if (items.length === 0) continue;
    const res = await sendAddonReminderEmail({
      studioLabel: SPACE_LABELS[b.studio || ""] || b.studio || "a studio",
      guestName: b.guestName,
      dateTimeText: b.dateTimeText,
      items,
      truncated: Boolean(b.addonsTruncated),
      viewLink: b.viewLink,
    });
    if (res.ok) {
      storage.markAddonReminderSent(b.id, Date.now());
      console.log(`[addon-reminder] sent prep reminder for booking ${b.bookingKey}`);
    } else {
      console.error(`[addon-reminder] send failed for ${b.bookingKey}`);
    }
  }
}

let started = false;
let running = false;

export function startAddonReminderScheduler(): void {
  if (started) return;
  started = true;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runReminderCheck();
    } catch (e) {
      console.error("[addon-reminder] scheduler error:", e);
    } finally {
      running = false;
    }
  };
  console.log(
    `[addon-reminder] scheduler started (sends at ${reminderHourET()}:00 ET the night before)`
  );
  setTimeout(tick, 30000);
  setInterval(tick, 15 * 60 * 1000);
}
