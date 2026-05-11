import { users, bookings, addOnCatalog } from "@shared/schema";
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
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, and } from "drizzle-orm";
import {
  isCalendarLiveForSpace,
  listEventsForSpace,
} from "./google-calendar";

const sqlite = new Database("data.db");
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
`);

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

// ----- Pricing helper used by addon line-total recompute -----
function computeAddOnLineTotal(item: {
  price: number;
  priceType: string;
}, qty: number): number {
  if (item.priceType === "flat") return Math.round(item.price * 100) / 100;
  return Math.round(item.price * qty * 100) / 100;
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
  purgePrototypeSeedBookings(): Promise<number>;
  // add-on catalog
  listAddOns(includeInactive?: boolean): Promise<AddOnDto[]>;
  getAddOn(id: string): Promise<AddOnDto | undefined>;
  createAddOn(input: CreateAddOnInput): Promise<AddOnDto>;
  updateAddOn(id: string, patch: UpdateAddOnInput): Promise<AddOnDto | undefined>;
  setAddOnActive(id: string, active: boolean): Promise<AddOnDto | undefined>;
  deleteAddOn(id: string): Promise<boolean>;
  seedAddOnCatalogIfEmpty(): Promise<number>;
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
