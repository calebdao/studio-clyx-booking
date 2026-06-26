import {
  users,
  bookings,
  addOnCatalog,
  agentConversations,
  agentMessages,
  agentDrafts,
  appSettings,
  peerspaceBookings,
} from "@shared/schema";
import {
  computeCardSurcharge,
  GUEST_TIER_15_RATE,
  GUEST_TIER_25_RATE,
  GUEST_TIER_40_RATE,
  GUEST_MAX,
  EVENT_CLEANING_FEE,
  ALCOHOL_FEE,
  promoDiscountForBase,
  evaluatePromo,
} from "@shared/schema";
import type {
  User,
  InsertUser,
  BookingRow,
  BookingDto,
  CreateHoldInput,
  AddOnCatalogRow,
  AddOnDto,
  CreateAddOnInput,
  UpdateAddOnInput,
  SelectedAddOn,
  AgentConversationRow,
  AgentMessageRow,
  AgentDraftRow,
  AgentConversationDto,
  AgentMessageDto,
  AgentDraftDto,
  PeerspaceBookingRow,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, and } from "drizzle-orm";
import {
  isCalendarLiveForSpace,
  listEventsForSpace,
} from "./google-calendar";

// SQLite database file location.
//
// Render's standard web service has an ephemeral filesystem — every redeploy
// resets the disk. To keep our SQLite database from being wiped, we let the
// path be overridden via DATABASE_PATH. In production we point it at a Render
// persistent disk mount (e.g. /var/data/data.db). Locally / in tests, the
// default `data.db` in the working directory still works.
const DB_PATH = process.env.DATABASE_PATH || "data.db";
console.log(`[storage] opening SQLite at ${DB_PATH}`);
const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");

// Bootstrap tables (drizzle-kit not run inside the sandbox; create idempotently).
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    activity_id TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    status TEXT NOT NULL,
    guest_first_name TEXT NOT NULL,
    guest_last_name TEXT NOT NULL,
    guest_email TEXT NOT NULL,
    guest_phone TEXT,
    guest_count INTEGER NOT NULL DEFAULT 1,
    alcohol INTEGER NOT NULL DEFAULT 0,
    addons TEXT,
    hold_expires_at INTEGER,
    hold_active INTEGER NOT NULL DEFAULT 1,
    reminder_sent_at INTEGER,
    google_event_id TEXT,
    google_calendar_id TEXT,
    payment_method TEXT NOT NULL DEFAULT 'zelle',
    card_fee_amount REAL NOT NULL DEFAULT 0,
    paid_at INTEGER,
    stripe_payment_intent_id TEXT,
    created_at INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'internal'
  );
  CREATE TABLE IF NOT EXISTS addon_catalog (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    price_type TEXT NOT NULL DEFAULT 'per_item',
    image_url TEXT,
    quantity_available INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_conversations (
    id TEXT PRIMARY KEY,
    thread_token TEXT NOT NULL UNIQUE,
    peerspace_reply_to TEXT,
    guest_name TEXT,
    guest_email TEXT,
    booking_id TEXT,
    subject TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    inquiry_details TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    from_address TEXT,
    to_address TEXT,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    provider_message_id TEXT,
    raw_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_drafts (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    inbound_message_id TEXT NOT NULL,
    proposed_subject TEXT,
    proposed_body_text TEXT,
    proposed_body_html TEXT,
    edited_body TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    needs_human INTEGER NOT NULL DEFAULT 0,
    auto_sent INTEGER NOT NULL DEFAULT 0,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    sent_at INTEGER,
    resend_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation
    ON agent_messages (conversation_id);
  CREATE INDEX IF NOT EXISTS idx_agent_messages_provider
    ON agent_messages (provider_message_id);
  CREATE INDEX IF NOT EXISTS idx_agent_drafts_conversation
    ON agent_drafts (conversation_id);
  CREATE INDEX IF NOT EXISTS idx_agent_drafts_status
    ON agent_drafts (status);
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS peerspace_bookings (
    id TEXT PRIMARY KEY,
    booking_key TEXT NOT NULL UNIQUE,
    guest_name TEXT,
    studio TEXT,
    date_time_text TEXT,
    start_epoch INTEGER,
    addons TEXT,
    addons_truncated INTEGER NOT NULL DEFAULT 0,
    view_link TEXT,
    source_email_at INTEGER NOT NULL DEFAULT 0,
    reminder_sent_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// One-time reclaim: older agent_messages rows may hold huge HTML bodies
// (Peerspace emails embed large base64 inline images), which OOM the process
// when loaded back via `.all()`. Null the stored HTML and cap the stored text.
// Runs in SQLite's C layer (no giant JS strings materialized), so it's safe even
// for oversized rows, and idempotent (after the first pass there's nothing left).
try {
  sqlite.exec(`
    UPDATE agent_messages SET body_html = NULL WHERE body_html IS NOT NULL;
    UPDATE agent_messages SET body_text = substr(body_text, 1, 16000)
      WHERE body_text IS NOT NULL AND length(body_text) > 16000;
  `);
} catch (e) {
  console.error("[storage] agent_messages body cleanup error", e);
}

// Idempotent ADD COLUMN for agent_conversations upgrades (existing prod data.db).
function ensureColumn(table: string, name: string, ddl: string) {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!rows.some((r) => r.name === name)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("bookings", "promo_code", "promo_code TEXT");
ensureColumn("agent_conversations", "inquiry_details", "inquiry_details TEXT");
ensureColumn("agent_drafts", "needs_human", "needs_human INTEGER NOT NULL DEFAULT 0");
ensureColumn("agent_drafts", "auto_sent", "auto_sent INTEGER NOT NULL DEFAULT 0");

// ----- Idempotent ALTER TABLE for upgrade from older schema versions -----
// SQLite ALTER TABLE … ADD COLUMN throws if the column already exists; we
// detect via PRAGMA table_info() and add only what's missing. This keeps the
// production data.db (already on Render) intact while picking up new fields.
function ensureBookingColumn(name: string, ddl: string) {
  const rows = sqlite.prepare("PRAGMA table_info(bookings)").all() as Array<{
    name: string;
  }>;
  if (!rows.some((r) => r.name === name)) {
    sqlite.exec(`ALTER TABLE bookings ADD COLUMN ${ddl}`);
  }
}
ensureBookingColumn("guest_count", "guest_count INTEGER NOT NULL DEFAULT 1");
ensureBookingColumn("alcohol", "alcohol INTEGER NOT NULL DEFAULT 0");
ensureBookingColumn("addons", "addons TEXT");
ensureBookingColumn("hold_active", "hold_active INTEGER NOT NULL DEFAULT 1");
ensureBookingColumn("reminder_sent_at", "reminder_sent_at INTEGER");
ensureBookingColumn("google_event_id", "google_event_id TEXT");
ensureBookingColumn("google_calendar_id", "google_calendar_id TEXT");
ensureBookingColumn(
  "payment_method",
  "payment_method TEXT NOT NULL DEFAULT 'zelle'"
);
ensureBookingColumn(
  "card_fee_amount",
  "card_fee_amount REAL NOT NULL DEFAULT 0"
);
ensureBookingColumn("paid_at", "paid_at INTEGER");
ensureBookingColumn("stripe_payment_intent_id", "stripe_payment_intent_id TEXT");

export const db = drizzle(sqlite);

// ----- Domain helpers (mirrors client/src/lib/booking-data.ts but server-owned) -----

const SLOT_MINUTES = 30;
export const HOLD_DURATION_MINUTES = 60;
export const OWNER_REMINDER_MINUTES = 60;

function addMinutes(d: Date, m: number) {
  return new Date(d.getTime() + m * 60 * 1000);
}
function floorToSlot(d: Date) {
  const step = SLOT_MINUTES * 60 * 1000;
  return new Date(Math.floor(d.getTime() / step) * step);
}

function safeParseAddons(raw: string | null | undefined): SelectedAddOn[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SelectedAddOn[]) : [];
  } catch {
    return [];
  }
}

function rowToDto(r: BookingRow): BookingDto {
  return {
    id: r.id,
    spaceId: r.spaceId as BookingDto["spaceId"],
    activityId: r.activityId as BookingDto["activityId"],
    start: r.start,
    end: r.end,
    status: r.status as BookingDto["status"],
    guest: {
      firstName: r.guestFirstName,
      lastName: r.guestLastName,
      email: r.guestEmail,
      phone: r.guestPhone ?? undefined,
    },
    guestCount: r.guestCount ?? 1,
    alcohol: Boolean(r.alcohol),
    addons: safeParseAddons(r.addons),
    holdExpiresAt: r.holdExpiresAt ?? undefined,
    holdActive: Boolean(r.holdActive),
    reminderSentAt: r.reminderSentAt ?? undefined,
    googleEventId: r.googleEventId ?? undefined,
    googleCalendarId: r.googleCalendarId ?? undefined,
    paymentMethod:
      (r.paymentMethod as BookingDto["paymentMethod"]) ?? "zelle",
    promoCode: r.promoCode ?? undefined,
    cardFeeAmount: r.cardFeeAmount ?? 0,
    paidAt: r.paidAt ?? undefined,
    stripePaymentIntentId: r.stripePaymentIntentId ?? undefined,
    createdAt: r.createdAt,
    source: r.source as BookingDto["source"],
  };
}

function rowToAddOnDto(r: AddOnCatalogRow): AddOnDto {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    price: r.price,
    priceType: r.priceType as AddOnDto["priceType"],
    imageUrl: r.imageUrl ?? undefined,
    quantityAvailable: r.quantityAvailable ?? undefined,
    active: Boolean(r.active),
    sortOrder: r.sortOrder ?? 0,
  };
}

function agentMessageRowToDto(r: AgentMessageRow): AgentMessageDto {
  return {
    id: r.id,
    conversationId: r.conversationId,
    direction: r.direction as AgentMessageDto["direction"],
    fromAddress: r.fromAddress ?? undefined,
    toAddress: r.toAddress ?? undefined,
    subject: r.subject ?? undefined,
    bodyText: r.bodyText ?? undefined,
    bodyHtml: r.bodyHtml ?? undefined,
    createdAt: r.createdAt,
  };
}

function agentDraftRowToDto(r: AgentDraftRow): AgentDraftDto {
  return {
    id: r.id,
    conversationId: r.conversationId,
    inboundMessageId: r.inboundMessageId,
    proposedSubject: r.proposedSubject ?? undefined,
    proposedBodyText: r.proposedBodyText ?? undefined,
    editedBody: r.editedBody ?? undefined,
    model: r.model ?? undefined,
    status: r.status as AgentDraftDto["status"],
    needsHuman: Boolean(r.needsHuman),
    autoSent: Boolean(r.autoSent),
    reviewedAt: r.reviewedAt ?? undefined,
    sentAt: r.sentAt ?? undefined,
    resendId: r.resendId ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.createdAt,
  };
}

function agentConversationRowToDto(
  r: AgentConversationRow,
  messages: AgentMessageRow[],
  drafts: AgentDraftRow[]
): AgentConversationDto {
  return {
    id: r.id,
    threadToken: r.threadToken,
    peerspaceReplyTo: r.peerspaceReplyTo ?? undefined,
    guestName: r.guestName ?? undefined,
    guestEmail: r.guestEmail ?? undefined,
    bookingId: r.bookingId ?? undefined,
    subject: r.subject ?? undefined,
    status: r.status as AgentConversationDto["status"],
    inquiryDetails: r.inquiryDetails ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    messages: messages.map(agentMessageRowToDto),
    drafts: drafts.map(agentDraftRowToDto),
  };
}

// ----- Pricing helper used by addon line-total recompute -----
function computeAddOnLineTotal(item: {
  price: number;
  priceType: string;
}, qty: number): number {
  if (item.priceType === "flat") return Math.round(item.price * 100) / 100;
  return Math.round(item.price * qty * 100) / 100;
}

// Local activity rate table — must mirror server/integrations.ts ACTIVITY_LABELS
// and client/src/lib/booking-data.ts ACTIVITIES. Kept here to avoid pulling in
// integrations.ts (which would create an unnecessary dependency from storage).
const ACTIVITY_RATE_USD: Record<string, number> = {
  production: 60,
  meeting: 80,
  event: 80,
};

function localGuestSurchargeRate(count: number): number {
  if (count <= 15) return GUEST_TIER_15_RATE;
  if (count <= 25) return GUEST_TIER_25_RATE;
  if (count <= GUEST_MAX) return GUEST_TIER_40_RATE;
  return GUEST_TIER_40_RATE;
}

function computeServerBaseTotal(args: {
  activityId: string;
  start: string;
  end: string;
  guestCount: number;
  alcohol: boolean;
  addons: SelectedAddOn[];
  promoCode?: string | null;
}): number {
  const baseRate = ACTIVITY_RATE_USD[args.activityId] ?? 0;
  const hours = Math.max(
    0,
    (new Date(args.end).getTime() - new Date(args.start).getTime()) / 36e5
  );
  const surchargeRate = localGuestSurchargeRate(args.guestCount);
  const base = Math.round(baseRate * hours * 100) / 100;
  const guestSurcharge = surchargeRate * hours;
  const cleaningFee = args.activityId === "event" ? EVENT_CLEANING_FEE : 0;
  const alcoholFee = args.alcohol ? ALCOHOL_FEE : 0;
  const addonsTotal = args.addons.reduce(
    (s, a) => s + (a.lineTotal ?? 0),
    0
  );
  const promoDiscount = promoDiscountForBase(base, args.promoCode ?? null, args.start);
  return (
    Math.round(
      (base + guestSurcharge + cleaningFee + alcoholFee + addonsTotal - promoDiscount) * 100
    ) / 100
  );
}

export interface IStorage {
  // legacy
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  // bookings
  listBookings(): Promise<BookingDto[]>;
  getBooking(id: string): Promise<BookingDto | undefined>;
  createHold(input: CreateHoldInput): Promise<BookingDto>;
  confirmBooking(id: string): Promise<BookingDto | undefined>;
  rejectBooking(id: string): Promise<BookingDto | undefined>;
  releaseBooking(id: string): Promise<boolean>;
  expireHolds(now: number): Promise<{
    expired: BookingDto[];
  }>;
  listOverdueReminderTargets(now: number): Promise<BookingDto[]>;
  markReminderSent(id: string, now: number): Promise<void>;
  setGoogleEvent(
    id: string,
    eventId: string | null,
    calendarId: string | null
  ): Promise<void>;
  // Stripe
  setStripePaymentIntent(
    id: string,
    paymentIntentId: string | null
  ): Promise<void>;
  findBookingByStripePaymentIntent(
    paymentIntentId: string
  ): Promise<BookingDto | undefined>;
  markPaid(id: string, paidAt: number): Promise<BookingDto | undefined>;
  // Create a confirmed booking directly from a paid Stripe PaymentIntent.
  // Used by the no-hold card flow: we only insert the row once payment clears.
  // Returns { booking } on success or { conflict: true } if the slot was
  // grabbed by another channel between PI creation and webhook delivery.
  createConfirmedBookingFromDraft(args: {
    spaceId: BookingDto["spaceId"];
    activityId: BookingDto["activityId"];
    start: string;
    end: string;
    guest: BookingDto["guest"];
    guestCount: number;
    alcohol: boolean;
    addons: Array<{ addOnId: string; quantity: number }>;
    cardFeeAmount: number;
    promoCode?: string | null;
    stripePaymentIntentId: string;
    paidAt: number;
  }): Promise<
    | { ok: true; booking: BookingDto }
    | { ok: false; conflict: true; reason: string }
  >;
  purgePrototypeSeedBookings(): Promise<number>;
  // add-on catalog
  listAddOns(includeInactive?: boolean): Promise<AddOnDto[]>;
  getAddOn(id: string): Promise<AddOnDto | undefined>;
  createAddOn(input: CreateAddOnInput): Promise<AddOnDto>;
  updateAddOn(id: string, patch: UpdateAddOnInput): Promise<AddOnDto | undefined>;
  setAddOnActive(id: string, active: boolean): Promise<AddOnDto | undefined>;
  deleteAddOn(id: string): Promise<boolean>;
  seedAddOnCatalogIfEmpty(): Promise<number>;
  // ----- Peerspace email-reply agent -----
  // Record an inbound email: upsert the conversation by thread token and insert
  // the message. Idempotent on the provider message id (Resend retries / Gmail
  // double-forwards). Returns the conversation + message and whether it was a dup.
  recordInboundEmail(args: {
    threadToken: string;
    peerspaceReplyTo?: string | null;
    guestName?: string | null;
    guestEmail?: string | null;
    subject?: string | null;
    fromAddress?: string | null;
    toAddress?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
    providerMessageId?: string | null;
    rawJson?: string | null;
    inquiryDetails?: string | null;
  }): Promise<{
    conversation: AgentConversationRow;
    message: AgentMessageRow;
    duplicate: boolean;
  }>;
  addAgentMessage(args: {
    conversationId: string;
    direction: "inbound" | "outbound";
    fromAddress?: string | null;
    toAddress?: string | null;
    subject?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
    providerMessageId?: string | null;
    rawJson?: string | null;
  }): Promise<AgentMessageRow>;
  setConversationBooking(
    conversationId: string,
    bookingId: string | null
  ): Promise<void>;
  setConversationStatus(
    conversationId: string,
    status: "open" | "closed"
  ): Promise<void>;
  createAgentDraft(args: {
    conversationId: string;
    inboundMessageId: string;
    proposedSubject?: string | null;
    proposedBodyText?: string | null;
    proposedBodyHtml?: string | null;
    model?: string | null;
    status?: AgentDraftRow["status"];
    error?: string | null;
  }): Promise<AgentDraftRow>;
  getAgentDraft(id: string): Promise<AgentDraftRow | undefined>;
  updateAgentDraft(
    id: string,
    patch: Partial<
      Pick<
        AgentDraftRow,
        | "status"
        | "editedBody"
        | "reviewedBy"
        | "reviewedAt"
        | "sentAt"
        | "resendId"
        | "error"
        | "autoSent"
      >
    >
  ): Promise<AgentDraftRow | undefined>;
  listAgentConversations(): Promise<AgentConversationDto[]>;
  getAgentConversation(id: string): Promise<AgentConversationDto | undefined>;
  // App settings (sync — backed by SQLite). Used by the editable knowledge base.
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  deleteSetting(key: string): void;
  // Peerspace bookings (add-on prep reminders).
  upsertPeerspaceBooking(args: {
    bookingKey: string;
    guestName?: string | null;
    studio?: string | null;
    dateTimeText?: string | null;
    startEpoch?: number | null;
    addons?: string | null;
    addonsTruncated?: boolean;
    viewLink?: string | null;
    sourceEmailAt: number;
  }): void;
  listAddonReminderCandidates(): PeerspaceBookingRow[];
  markAddonReminderSent(id: string, now: number): void;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number) {
    return db.select().from(users).where(eq(users.id, id)).get();
  }
  async getUserByUsername(username: string) {
    return db.select().from(users).where(eq(users.username, username)).get();
  }
  async createUser(insertUser: InsertUser) {
    return db.insert(users).values(insertUser).returning().get();
  }

  async listBookings(): Promise<BookingDto[]> {
    const rows = db.select().from(bookings).all();
    return rows.map(rowToDto);
  }

  async getBooking(id: string) {
    const row = db.select().from(bookings).where(eq(bookings.id, id)).get();
    return row ? rowToDto(row) : undefined;
  }

  async createHold(input: CreateHoldInput): Promise<BookingDto> {
    // Conflict check: any existing held/pending/confirmed booking that overlaps.
    const start = new Date(input.start).getTime();
    const end = new Date(input.end).getTime();
    if (!(end > start)) throw new Error("End must be after start");

    const existing = db.select().from(bookings).all();
    const conflict = existing.find((b) => {
      if (b.spaceId !== input.spaceId) return false;
      // Inactive holds and rejected bookings never block. Active holds,
      // pending, and confirmed all block.
      if (b.status === "rejected") return false;
      if ((b.status === "held" || b.status === "pending") && !b.holdActive)
        return false;
      const bs = new Date(b.start).getTime();
      const be = new Date(b.end).getTime();
      return bs < end && be > start;
    });
    if (conflict) {
      const err = new Error("Slot is no longer available.");
      (err as any).status = 409;
      throw err;
    }

    // Google Calendar conflict check — only when configured for this space.
    if (isCalendarLiveForSpace(input.spaceId)) {
      const gc = await listEventsForSpace(
        input.spaceId,
        new Date(start),
        new Date(end)
      );
      if (gc.ok) {
        const blocker = gc.events.find((ev) => {
          const bs = new Date(ev.start).getTime();
          const be = new Date(ev.end).getTime();
          return bs < end && be > start;
        });
        if (blocker) {
          const err = new Error("Slot is no longer available.");
          (err as any).status = 409;
          (err as any).source = "google-calendar";
          (err as any).blocker = blocker;
          throw err;
        }
      } else if (gc.reason === "error") {
        console.warn(
          `[storage] Google Calendar conflict check failed (allowing booking): ${gc.error}`
        );
      }
    }

    // Resolve addon items from the live catalog (server is the source of
    // truth for prices). Unknown / inactive items are silently dropped.
    const resolvedAddons: SelectedAddOn[] = [];
    if (input.addons && input.addons.length > 0) {
      const catalog = db
        .select()
        .from(addOnCatalog)
        .where(eq(addOnCatalog.active, true))
        .all();
      const byId = new Map(catalog.map((c) => [c.id, c]));
      for (const a of input.addons) {
        const item = byId.get(a.addOnId);
        if (!item) continue;
        const lineTotal = computeAddOnLineTotal(item, a.quantity);
        resolvedAddons.push({
          addOnId: item.id,
          name: item.name,
          price: item.price,
          priceType: item.priceType as SelectedAddOn["priceType"],
          quantity: a.quantity,
          lineTotal,
        });
      }
    }

    // Compute card surcharge (server is authoritative). When the customer
    // chose Zelle this stays 0; when they chose card we gross up so Stripe's
    // fee is fully absorbed by the customer and the merchant nets the base.
    const paymentMethod = (input.paymentMethod ?? "zelle") as "zelle" | "card";
    // Validate the promo server-side; only store it when it actually applies
    // (correct code AND session date inside the window).
    const promo = evaluatePromo(input.promoCode ?? null, input.start);
    const promoCode = promo.applied ? promo.code : null;
    const baseTotal = computeServerBaseTotal({
      activityId: input.activityId,
      start: input.start,
      end: input.end,
      guestCount: input.guestCount,
      alcohol: input.alcohol ?? false,
      addons: resolvedAddons,
      promoCode,
    });
    const cardFeeAmount =
      paymentMethod === "card" ? computeCardSurcharge(baseTotal) : 0;

    const id = `bkg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const row: BookingRow = {
      id,
      spaceId: input.spaceId,
      activityId: input.activityId,
      start: input.start,
      end: input.end,
      status: "pending",
      guestFirstName: input.guest.firstName,
      guestLastName: input.guest.lastName,
      guestEmail: input.guest.email,
      guestPhone: input.guest.phone ?? null,
      guestCount: input.guestCount,
      alcohol: input.alcohol ?? false,
      addons: JSON.stringify(resolvedAddons),
      holdExpiresAt: now + HOLD_DURATION_MINUTES * 60 * 1000,
      holdActive: true,
      reminderSentAt: null,
      googleEventId: null,
      googleCalendarId: null,
      paymentMethod,
      promoCode,
      cardFeeAmount,
      paidAt: null,
      stripePaymentIntentId: null,
      createdAt: now,
      source: "internal",
    };
    db.insert(bookings).values(row).run();
    return rowToDto(row);
  }

  async confirmBooking(id: string) {
    const row = db.select().from(bookings).where(eq(bookings.id, id)).get();
    if (!row) return undefined;
    db.update(bookings)
      .set({
        status: "confirmed",
        holdExpiresAt: null,
        holdActive: false,
      })
      .where(eq(bookings.id, id))
      .run();
    const updated = db.select().from(bookings).where(eq(bookings.id, id)).get();
    return updated ? rowToDto(updated) : undefined;
  }

  async rejectBooking(id: string) {
    const row = db.select().from(bookings).where(eq(bookings.id, id)).get();
    if (!row) return undefined;
    db.update(bookings)
      .set({ status: "rejected", holdActive: false, holdExpiresAt: null })
      .where(eq(bookings.id, id))
      .run();
    const updated = db.select().from(bookings).where(eq(bookings.id, id)).get();
    return updated ? rowToDto(updated) : undefined;
  }

  async releaseBooking(id: string) {
    const result = db.delete(bookings).where(eq(bookings.id, id)).run();
    return result.changes > 0;
  }

  async expireHolds(now: number): Promise<{ expired: BookingDto[] }> {
    // Mark active holds whose expiry has passed as inactive. We do NOT delete
    // the booking — it remains in the system as a pending request until an
    // operator confirms or rejects it. It just stops blocking availability /
    // calendar.
    const all = db.select().from(bookings).all();
    const expired: BookingDto[] = [];
    for (const b of all) {
      if (
        (b.status === "held" || b.status === "pending") &&
        b.holdActive &&
        b.holdExpiresAt &&
        b.holdExpiresAt <= now
      ) {
        db.update(bookings)
          .set({ holdActive: false })
          .where(eq(bookings.id, b.id))
          .run();
        expired.push(rowToDto({ ...b, holdActive: false }));
      }
    }
    return { expired };
  }

  async listOverdueReminderTargets(now: number): Promise<BookingDto[]> {
    const all = db.select().from(bookings).all();
    const threshold = OWNER_REMINDER_MINUTES * 60 * 1000;
    return all
      .filter((b) => {
        if (b.status !== "pending" && b.status !== "held") return false;
        if (b.reminderSentAt) return false;
        return now - b.createdAt >= threshold;
      })
      .map(rowToDto);
  }

  async markReminderSent(id: string, now: number) {
    db.update(bookings)
      .set({ reminderSentAt: now })
      .where(eq(bookings.id, id))
      .run();
  }

  async setGoogleEvent(
    id: string,
    eventId: string | null,
    calendarId: string | null
  ) {
    db.update(bookings)
      .set({ googleEventId: eventId, googleCalendarId: calendarId })
      .where(eq(bookings.id, id))
      .run();
  }

  async setStripePaymentIntent(id: string, paymentIntentId: string | null) {
    db.update(bookings)
      .set({ stripePaymentIntentId: paymentIntentId })
      .where(eq(bookings.id, id))
      .run();
  }

  async findBookingByStripePaymentIntent(paymentIntentId: string) {
    const row = db
      .select()
      .from(bookings)
      .where(eq(bookings.stripePaymentIntentId, paymentIntentId))
      .get();
    return row ? rowToDto(row) : undefined;
  }

  async markPaid(id: string, paidAt: number) {
    const row = db.select().from(bookings).where(eq(bookings.id, id)).get();
    if (!row) return undefined;
    db.update(bookings)
      .set({ paidAt })
      .where(eq(bookings.id, id))
      .run();
    const updated = db
      .select()
      .from(bookings)
      .where(eq(bookings.id, id))
      .get();
    return updated ? rowToDto(updated) : undefined;
  }

  async createConfirmedBookingFromDraft(args: {
    spaceId: BookingDto["spaceId"];
    activityId: BookingDto["activityId"];
    start: string;
    end: string;
    guest: BookingDto["guest"];
    guestCount: number;
    alcohol: boolean;
    addons: Array<{ addOnId: string; quantity: number }>;
    cardFeeAmount: number;
    promoCode?: string | null;
    stripePaymentIntentId: string;
    paidAt: number;
  }): Promise<
    | { ok: true; booking: BookingDto }
    | { ok: false; conflict: true; reason: string }
  > {
    // Idempotency: if a booking already exists for this PaymentIntent (Stripe
    // webhook retries are common), return that existing row instead of double-
    // inserting.
    const existingByPi = db
      .select()
      .from(bookings)
      .where(eq(bookings.stripePaymentIntentId, args.stripePaymentIntentId))
      .get();
    if (existingByPi) {
      return { ok: true, booking: rowToDto(existingByPi) };
    }

    // Conflict check: any active (held/pending hold, or confirmed) booking
    // that overlaps this slot in the same space blocks us.
    const start = new Date(args.start).getTime();
    const end = new Date(args.end).getTime();
    if (!(end > start)) {
      return {
        ok: false,
        conflict: true,
        reason: "Invalid time range on the PaymentIntent metadata.",
      };
    }
    const existing = db.select().from(bookings).all();
    const blocker = existing.find((b) => {
      if (b.spaceId !== args.spaceId) return false;
      if (b.status === "rejected") return false;
      if ((b.status === "held" || b.status === "pending") && !b.holdActive)
        return false;
      const bs = new Date(b.start).getTime();
      const be = new Date(b.end).getTime();
      return bs < end && be > start;
    });
    if (blocker) {
      return {
        ok: false,
        conflict: true,
        reason: `Slot ${args.spaceId} ${args.start}–${args.end} already booked by ${blocker.id} (status=${blocker.status}).`,
      };
    }

    // Google Calendar conflict check (peerspace / giggster sync via shared cal).
    if (isCalendarLiveForSpace(args.spaceId)) {
      const gc = await listEventsForSpace(
        args.spaceId,
        new Date(start),
        new Date(end)
      );
      if (gc.ok) {
        const gcBlocker = gc.events.find((ev) => {
          const bs = new Date(ev.start).getTime();
          const be = new Date(ev.end).getTime();
          return bs < end && be > start;
        });
        if (gcBlocker) {
          return {
            ok: false,
            conflict: true,
            reason: `Slot blocked by external calendar event ${gcBlocker.id} (${gcBlocker.summary ?? "no summary"}).`,
          };
        }
      } else if (gc.reason === "error") {
        console.warn(
          `[storage] Google Calendar conflict check failed during PI confirm (allowing booking): ${gc.error}`
        );
      }
    }

    // Resolve addons server-side from the live catalog.
    const resolvedAddons: SelectedAddOn[] = [];
    if (args.addons.length > 0) {
      const catalog = db
        .select()
        .from(addOnCatalog)
        .where(eq(addOnCatalog.active, true))
        .all();
      const byId = new Map(catalog.map((c) => [c.id, c]));
      for (const a of args.addons) {
        const item = byId.get(a.addOnId);
        if (!item) continue;
        const lineTotal = computeAddOnLineTotal(item, a.quantity);
        resolvedAddons.push({
          addOnId: item.id,
          name: item.name,
          price: item.price,
          priceType: item.priceType as SelectedAddOn["priceType"],
          quantity: a.quantity,
          lineTotal,
        });
      }
    }

    const id = `bkg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const row: BookingRow = {
      id,
      spaceId: args.spaceId,
      activityId: args.activityId,
      start: args.start,
      end: args.end,
      status: "confirmed",
      guestFirstName: args.guest.firstName,
      guestLastName: args.guest.lastName,
      guestEmail: args.guest.email,
      guestPhone: args.guest.phone ?? null,
      guestCount: args.guestCount,
      alcohol: args.alcohol,
      addons: JSON.stringify(resolvedAddons),
      holdExpiresAt: null,
      holdActive: false,
      reminderSentAt: null,
      googleEventId: null,
      googleCalendarId: null,
      paymentMethod: "card",
      promoCode: args.promoCode ?? null,
      cardFeeAmount: args.cardFeeAmount,
      paidAt: args.paidAt,
      stripePaymentIntentId: args.stripePaymentIntentId,
      createdAt: now,
      source: "internal",
    };
    db.insert(bookings).values(row).run();
    return { ok: true, booking: rowToDto(row) };
  }

  async purgePrototypeSeedBookings(): Promise<number> {
    const result = sqlite.prepare("DELETE FROM bookings WHERE id LIKE 'seed-%'").run();
    return result.changes;
  }

  // ----- Add-on catalog CRUD -----

  async listAddOns(includeInactive = false): Promise<AddOnDto[]> {
    const rows = db
      .select()
      .from(addOnCatalog)
      .all()
      .filter((r) => (includeInactive ? true : r.active));
    rows.sort(
      (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)
    );
    return rows.map(rowToAddOnDto);
  }

  async getAddOn(id: string) {
    const row = db
      .select()
      .from(addOnCatalog)
      .where(eq(addOnCatalog.id, id))
      .get();
    return row ? rowToAddOnDto(row) : undefined;
  }

  async createAddOn(input: CreateAddOnInput): Promise<AddOnDto> {
    const id = `ao-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const row: AddOnCatalogRow = {
      id,
      name: input.name,
      description: input.description ?? null,
      price: input.price,
      priceType: input.priceType ?? "per_item",
      imageUrl: input.imageUrl ? String(input.imageUrl) : null,
      quantityAvailable:
        input.quantityAvailable === undefined ||
        input.quantityAvailable === null
          ? null
          : Number(input.quantityAvailable),
      active: input.active ?? true,
      sortOrder: 0,
      createdAt: Date.now(),
    };
    db.insert(addOnCatalog).values(row).run();
    return rowToAddOnDto(row);
  }

  async updateAddOn(id: string, patch: UpdateAddOnInput) {
    const row = db
      .select()
      .from(addOnCatalog)
      .where(eq(addOnCatalog.id, id))
      .get();
    if (!row) return undefined;
    const set: Partial<AddOnCatalogRow> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined)
      set.description = patch.description ?? null;
    if (patch.price !== undefined) set.price = patch.price;
    if (patch.priceType !== undefined) set.priceType = patch.priceType;
    if (patch.imageUrl !== undefined)
      set.imageUrl = patch.imageUrl ? String(patch.imageUrl) : null;
    if (patch.quantityAvailable !== undefined)
      set.quantityAvailable =
        patch.quantityAvailable === null ? null : Number(patch.quantityAvailable);
    if (patch.active !== undefined) set.active = patch.active;
    if (Object.keys(set).length > 0) {
      db.update(addOnCatalog).set(set).where(eq(addOnCatalog.id, id)).run();
    }
    const updated = db
      .select()
      .from(addOnCatalog)
      .where(eq(addOnCatalog.id, id))
      .get();
    return updated ? rowToAddOnDto(updated) : undefined;
  }

  async setAddOnActive(id: string, active: boolean) {
    return this.updateAddOn(id, { active });
  }

  async deleteAddOn(id: string) {
    const result = db
      .delete(addOnCatalog)
      .where(eq(addOnCatalog.id, id))
      .run();
    return result.changes > 0;
  }

  async seedAddOnCatalogIfEmpty(): Promise<number> {
    const count = db.select().from(addOnCatalog).all().length;
    if (count > 0) return 0;
    const seeds: Array<
      Omit<AddOnCatalogRow, "id" | "createdAt" | "sortOrder"> & {
        sortOrder?: number;
      }
    > = [
      {
        name: "10 Foldable Chairs",
        description: "Set of ten foldable chairs.",
        price: 45.0,
        priceType: "per_item",
        imageUrl:
          "https://img.peerspace.com/image/upload/f_auto,q_auto,dpr_auto,w_96/q5dbynn5xqpteuvmxydx",
        quantityAvailable: null,
        active: true,
      },
      {
        name: "Cream Boucle Armchair",
        description: "Soft boucle armchair.",
        price: 150.0,
        priceType: "per_item",
        imageUrl:
          "https://img.peerspace.com/image/upload/f_auto,q_auto,dpr_auto,w_96/apcptls2emecnattppbg",
        quantityAvailable: null,
        active: true,
      },
      {
        name: "Herman Miller Eames Molded Plywood DCM",
        description: "Iconic molded plywood lounge chair.",
        price: 150.0,
        priceType: "per_item",
        imageUrl:
          "https://img.peerspace.com/image/upload/f_auto,q_auto,dpr_auto,w_96/jul9mh7vvapt1lzfk3pz",
        quantityAvailable: null,
        active: true,
      },
      {
        name: "Mario Botta La Quinta Chair",
        description: "Sculptural designer accent chair.",
        price: 200.0,
        priceType: "per_item",
        imageUrl:
          "https://img.peerspace.com/image/upload/f_auto,q_auto,dpr_auto,w_96/dxsfivlbjmhyigs0p8eh",
        quantityAvailable: null,
        active: true,
      },
      {
        name: "Stools",
        description: "Bar / counter stools (flat fee).",
        price: 20.0,
        priceType: "flat",
        imageUrl:
          "https://img.peerspace.com/image/upload/f_auto,q_auto,dpr_auto,w_96/qcpcfonpxu0w7xa4nnvr",
        quantityAvailable: null,
        active: true,
      },
      {
        name: "Courbe Green Ceramic Table Lamp with Rattan Shade",
        description: "Accent table lamp with green ceramic base and rattan shade.",
        price: 110.0,
        priceType: "per_item",
        imageUrl:
          "https://img.peerspace.com/image/upload/f_auto,q_auto,dpr_auto,w_96/k9bkfdbxdsf7tcage5id",
        quantityAvailable: null,
        active: true,
      },
    ];
    let inserted = 0;
    seeds.forEach((s, i) => {
      const id = `ao-seed-${i}`;
      const row: AddOnCatalogRow = {
        id,
        name: s.name,
        description: s.description ?? null,
        price: s.price,
        priceType: s.priceType,
        imageUrl: s.imageUrl ?? null,
        quantityAvailable: s.quantityAvailable ?? null,
        active: s.active,
        sortOrder: i,
        createdAt: Date.now(),
      };
      db.insert(addOnCatalog).values(row).run();
      inserted++;
    });
    return inserted;
  }

  // ----- Peerspace email-reply agent -----

  async addAgentMessage(args: {
    conversationId: string;
    direction: "inbound" | "outbound";
    fromAddress?: string | null;
    toAddress?: string | null;
    subject?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
    providerMessageId?: string | null;
    rawJson?: string | null;
  }): Promise<AgentMessageRow> {
    const id = `amsg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const row: AgentMessageRow = {
      id,
      conversationId: args.conversationId,
      direction: args.direction,
      fromAddress: args.fromAddress ?? null,
      toAddress: args.toAddress ?? null,
      subject: args.subject ?? null,
      bodyText: args.bodyText ?? null,
      bodyHtml: args.bodyHtml ?? null,
      providerMessageId: args.providerMessageId ?? null,
      rawJson: args.rawJson ?? null,
      createdAt: Date.now(),
    };
    db.insert(agentMessages).values(row).run();
    // Bump the parent conversation's updatedAt so the Inbox sorts by activity.
    db.update(agentConversations)
      .set({ updatedAt: row.createdAt })
      .where(eq(agentConversations.id, args.conversationId))
      .run();
    return row;
  }

  async recordInboundEmail(args: {
    threadToken: string;
    peerspaceReplyTo?: string | null;
    guestName?: string | null;
    guestEmail?: string | null;
    subject?: string | null;
    fromAddress?: string | null;
    toAddress?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
    providerMessageId?: string | null;
    rawJson?: string | null;
    inquiryDetails?: string | null;
  }): Promise<{
    conversation: AgentConversationRow;
    message: AgentMessageRow;
    duplicate: boolean;
  }> {
    // Upsert the conversation keyed by the Peerspace Reply-To thread token.
    let conversation = db
      .select()
      .from(agentConversations)
      .where(eq(agentConversations.threadToken, args.threadToken))
      .get();
    const now = Date.now();
    if (!conversation) {
      const convo: AgentConversationRow = {
        id: `aconv-${now}-${Math.random().toString(36).slice(2, 7)}`,
        threadToken: args.threadToken,
        peerspaceReplyTo: args.peerspaceReplyTo ?? null,
        guestName: args.guestName ?? null,
        guestEmail: args.guestEmail ?? null,
        bookingId: null,
        subject: args.subject ?? null,
        status: "open",
        inquiryDetails: args.inquiryDetails ?? null,
        createdAt: now,
        updatedAt: now,
      };
      db.insert(agentConversations).values(convo).run();
      conversation = convo;
    } else {
      // Backfill any fields we now know but didn't before; reopen if closed.
      const set: Partial<AgentConversationRow> = { updatedAt: now };
      // Always refresh the reply-to to the latest message's address.
      if (args.peerspaceReplyTo) set.peerspaceReplyTo = args.peerspaceReplyTo;
      if (!conversation.guestName && args.guestName)
        set.guestName = args.guestName;
      if (!conversation.guestEmail && args.guestEmail)
        set.guestEmail = args.guestEmail;
      if (!conversation.subject && args.subject) set.subject = args.subject;
      if (args.inquiryDetails) set.inquiryDetails = args.inquiryDetails;
      if (conversation.status === "closed") set.status = "open";
      db.update(agentConversations)
        .set(set)
        .where(eq(agentConversations.id, conversation.id))
        .run();
      conversation = { ...conversation, ...set };
    }

    // Idempotency: if we've already stored a message with this provider id for
    // this conversation, return it without inserting a duplicate.
    if (args.providerMessageId) {
      const dup = db
        .select()
        .from(agentMessages)
        .where(
          and(
            eq(agentMessages.conversationId, conversation.id),
            eq(agentMessages.providerMessageId, args.providerMessageId)
          )
        )
        .get();
      if (dup) {
        return { conversation, message: dup, duplicate: true };
      }
    }

    const message = await this.addAgentMessage({
      conversationId: conversation.id,
      direction: "inbound",
      fromAddress: args.fromAddress ?? null,
      toAddress: args.toAddress ?? null,
      subject: args.subject ?? null,
      bodyText: args.bodyText ?? null,
      bodyHtml: args.bodyHtml ?? null,
      providerMessageId: args.providerMessageId ?? null,
      rawJson: args.rawJson ?? null,
    });
    return { conversation, message, duplicate: false };
  }

  async setConversationBooking(conversationId: string, bookingId: string | null) {
    db.update(agentConversations)
      .set({ bookingId, updatedAt: Date.now() })
      .where(eq(agentConversations.id, conversationId))
      .run();
  }

  async setConversationStatus(
    conversationId: string,
    status: "open" | "closed"
  ) {
    db.update(agentConversations)
      .set({ status, updatedAt: Date.now() })
      .where(eq(agentConversations.id, conversationId))
      .run();
  }

  async createAgentDraft(args: {
    conversationId: string;
    inboundMessageId: string;
    proposedSubject?: string | null;
    proposedBodyText?: string | null;
    proposedBodyHtml?: string | null;
    model?: string | null;
    status?: AgentDraftRow["status"];
    error?: string | null;
    needsHuman?: boolean;
  }): Promise<AgentDraftRow> {
    const id = `adraft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const row: AgentDraftRow = {
      id,
      conversationId: args.conversationId,
      inboundMessageId: args.inboundMessageId,
      proposedSubject: args.proposedSubject ?? null,
      proposedBodyText: args.proposedBodyText ?? null,
      proposedBodyHtml: args.proposedBodyHtml ?? null,
      editedBody: null,
      model: args.model ?? null,
      status: args.status ?? "pending",
      needsHuman: args.needsHuman ?? false,
      autoSent: false,
      reviewedBy: null,
      reviewedAt: null,
      sentAt: null,
      resendId: null,
      error: args.error ?? null,
      createdAt: Date.now(),
    };
    db.insert(agentDrafts).values(row).run();
    return row;
  }

  async getAgentDraft(id: string): Promise<AgentDraftRow | undefined> {
    return db.select().from(agentDrafts).where(eq(agentDrafts.id, id)).get();
  }

  async updateAgentDraft(
    id: string,
    patch: Partial<
      Pick<
        AgentDraftRow,
        | "status"
        | "editedBody"
        | "reviewedBy"
        | "reviewedAt"
        | "sentAt"
        | "resendId"
        | "error"
        | "autoSent"
      >
    >
  ): Promise<AgentDraftRow | undefined> {
    const row = db.select().from(agentDrafts).where(eq(agentDrafts.id, id)).get();
    if (!row) return undefined;
    if (Object.keys(patch).length > 0) {
      db.update(agentDrafts).set(patch).where(eq(agentDrafts.id, id)).run();
    }
    return db.select().from(agentDrafts).where(eq(agentDrafts.id, id)).get();
  }

  async listAgentConversations(): Promise<AgentConversationDto[]> {
    const convos = db.select().from(agentConversations).all();
    convos.sort((a, b) => b.updatedAt - a.updatedAt);
    return convos.map((c) => {
      const messages = db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.conversationId, c.id))
        .all()
        .sort((a, b) => a.createdAt - b.createdAt);
      const drafts = db
        .select()
        .from(agentDrafts)
        .where(eq(agentDrafts.conversationId, c.id))
        .all()
        .sort((a, b) => a.createdAt - b.createdAt);
      return agentConversationRowToDto(c, messages, drafts);
    });
  }

  getSetting(key: string): string | null {
    const row = db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .get();
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    const now = Date.now();
    db.insert(appSettings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedAt: now },
      })
      .run();
  }

  deleteSetting(key: string): void {
    db.delete(appSettings).where(eq(appSettings.key, key)).run();
  }

  upsertPeerspaceBooking(args: {
    bookingKey: string;
    guestName?: string | null;
    studio?: string | null;
    dateTimeText?: string | null;
    startEpoch?: number | null;
    addons?: string | null;
    addonsTruncated?: boolean;
    viewLink?: string | null;
    sourceEmailAt: number;
  }): void {
    const now = Date.now();
    const existing = db
      .select()
      .from(peerspaceBookings)
      .where(eq(peerspaceBookings.bookingKey, args.bookingKey))
      .get();
    if (!existing) {
      db.insert(peerspaceBookings)
        .values({
          id: `psb-${now}-${Math.random().toString(36).slice(2, 7)}`,
          bookingKey: args.bookingKey,
          guestName: args.guestName ?? null,
          studio: args.studio ?? null,
          dateTimeText: args.dateTimeText ?? null,
          startEpoch: args.startEpoch ?? null,
          addons: args.addons ?? null,
          addonsTruncated: args.addonsTruncated ?? false,
          viewLink: args.viewLink ?? null,
          sourceEmailAt: args.sourceEmailAt,
          reminderSentAt: null,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return;
    }
    // Latest email wins: only overwrite when this email is newer.
    if (args.sourceEmailAt < existing.sourceEmailAt) return;
    db.update(peerspaceBookings)
      .set({
        guestName: args.guestName ?? existing.guestName,
        studio: args.studio ?? existing.studio,
        dateTimeText: args.dateTimeText ?? existing.dateTimeText,
        startEpoch: args.startEpoch ?? existing.startEpoch,
        addons: args.addons ?? existing.addons,
        addonsTruncated: args.addonsTruncated ?? existing.addonsTruncated,
        viewLink: args.viewLink ?? existing.viewLink,
        sourceEmailAt: args.sourceEmailAt,
        status: "active",
        updatedAt: now,
      })
      .where(eq(peerspaceBookings.id, existing.id))
      .run();
  }

  listAddonReminderCandidates(): PeerspaceBookingRow[] {
    return db
      .select()
      .from(peerspaceBookings)
      .where(eq(peerspaceBookings.status, "active"))
      .all()
      .filter(
        (b) =>
          !b.reminderSentAt &&
          b.startEpoch != null &&
          b.addons != null &&
          b.addons !== "[]"
      );
  }

  markAddonReminderSent(id: string, now: number): void {
    db.update(peerspaceBookings)
      .set({ reminderSentAt: now, updatedAt: now })
      .where(eq(peerspaceBookings.id, id))
      .run();
  }

  async getAgentConversation(
    id: string
  ): Promise<AgentConversationDto | undefined> {
    const c = db
      .select()
      .from(agentConversations)
      .where(eq(agentConversations.id, id))
      .get();
    if (!c) return undefined;
    const messages = db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.conversationId, id))
      .all()
      .sort((a, b) => a.createdAt - b.createdAt);
    const drafts = db
      .select()
      .from(agentDrafts)
      .where(eq(agentDrafts.conversationId, id))
      .all()
      .sort((a, b) => a.createdAt - b.createdAt);
    return agentConversationRowToDto(c, messages, drafts);
  }
}

// Used by drizzle filtering — keep here even if unused locally.
void and;

export const storage = new DatabaseStorage();

// Remove prototype seed bookings on boot and never create new fake bookings.
storage
  .purgePrototypeSeedBookings()
  .then((removed) => {
    if (removed > 0) {
      console.log(`[storage] removed ${removed} prototype seed booking(s)`);
    }
  })
  .catch((e) => console.error("seed cleanup error", e));

// Seed the add-on catalog with public Peerspace inventory if it's empty.
storage
  .seedAddOnCatalogIfEmpty()
  .then((inserted) => {
    if (inserted > 0) {
      console.log(`[storage] seeded ${inserted} add-on catalog item(s)`);
    }
  })
  .catch((e) => console.error("addon catalog seed error", e));
