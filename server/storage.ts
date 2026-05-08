import { users, bookings } from "@shared/schema";
import type {
  User,
  InsertUser,
  BookingRow,
  BookingDto,
  CreateHoldInput,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
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
    hold_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'internal'
  );
`);

export const db = drizzle(sqlite);

// ----- Domain helpers (mirrors client/src/lib/booking-data.ts but server-owned) -----

const SLOT_MINUTES = 30;
export const HOLD_DURATION_MINUTES = 30;

function addMinutes(d: Date, m: number) {
  return new Date(d.getTime() + m * 60 * 1000);
}
function floorToSlot(d: Date) {
  const step = SLOT_MINUTES * 60 * 1000;
  return new Date(Math.floor(d.getTime() / step) * step);
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
    holdExpiresAt: r.holdExpiresAt ?? undefined,
    createdAt: r.createdAt,
    source: r.source as BookingDto["source"],
  };
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
  releaseBooking(id: string): Promise<boolean>;
  expireHolds(now: number): Promise<number>;
  purgePrototypeSeedBookings(): Promise<number>;
  seedIfEmpty(): Promise<void>;
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
      if (b.status === "held" && b.holdExpiresAt && b.holdExpiresAt <= Date.now()) {
        return false; // expired holds are not blockers
      }
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
    // Captures Peerspace/Giggster bookings synced into Google Calendar.
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
        // Don't block the booking on a Google outage — log and continue.
        console.warn(
          `[storage] Google Calendar conflict check failed (allowing booking): ${gc.error}`
        );
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
      status: "held",
      guestFirstName: input.guest.firstName,
      guestLastName: input.guest.lastName,
      guestEmail: input.guest.email,
      guestPhone: input.guest.phone ?? null,
      holdExpiresAt: now + HOLD_DURATION_MINUTES * 60 * 1000,
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
      .set({ status: "confirmed", holdExpiresAt: null })
      .where(eq(bookings.id, id))
      .run();
    const updated = db.select().from(bookings).where(eq(bookings.id, id)).get();
    return updated ? rowToDto(updated) : undefined;
  }

  async releaseBooking(id: string) {
    const result = db.delete(bookings).where(eq(bookings.id, id)).run();
    return result.changes > 0;
  }

  async expireHolds(now: number): Promise<number> {
    // Delete held bookings whose hold has expired.
    const all = db.select().from(bookings).all();
    let removed = 0;
    for (const b of all) {
      if (b.status === "held" && b.holdExpiresAt && b.holdExpiresAt <= now) {
        db.delete(bookings).where(eq(bookings.id, b.id)).run();
        removed++;
      }
    }
    return removed;
  }

  async purgePrototypeSeedBookings(): Promise<number> {
    const result = sqlite.prepare("DELETE FROM bookings WHERE id LIKE 'seed-%'").run();
    return result.changes;
  }

  async seedIfEmpty(): Promise<void> {
    // Production app should start with real bookings only. Prototype seed
    // bookings were useful for visual QA, but they block real availability.
    return;
    const count = db.select().from(bookings).all().length;
    if (count > 0) return;
    const now = new Date();
    const today = floorToSlot(now);
    const day0 = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);

    type Seed = {
      spaceId: BookingDto["spaceId"];
      activityId: BookingDto["activityId"];
      dayOffset: number;
      startHour: number;
      durationHours: number;
      status: BookingDto["status"];
      guest: BookingDto["guest"];
      source: BookingDto["source"];
    };

    const seeds: Seed[] = [
      { spaceId: "studio-1", activityId: "production", dayOffset: 0, startHour: 10, durationHours: 4, status: "confirmed", guest: { firstName: "Maya", lastName: "Okafor", email: "maya@northlightstudio.com", phone: "415-555-0182" }, source: "peerspace" },
      { spaceId: "studio-2", activityId: "production", dayOffset: 0, startHour: 14, durationHours: 3, status: "confirmed", guest: { firstName: "Jordan", lastName: "Reyes", email: "jordan@reyesfilm.co" }, source: "giggster" },
      { spaceId: "studio-3", activityId: "meeting", dayOffset: 0, startHour: 18, durationHours: 2, status: "confirmed", guest: { firstName: "Priya", lastName: "Shah", email: "priya@shahcollective.com", phone: "718-555-0144" }, source: "internal" },
      { spaceId: "lincoln-apartment", activityId: "event", dayOffset: 1, startHour: 19, durationHours: 4, status: "confirmed", guest: { firstName: "Carmen", lastName: "Ali", email: "carmen.ali@example.com" }, source: "internal" },
      { spaceId: "studio-1", activityId: "production", dayOffset: 1, startHour: 9, durationHours: 5, status: "confirmed", guest: { firstName: "Theo", lastName: "Brand", email: "theo@brandhouse.tv" }, source: "peerspace" },
      { spaceId: "studio-2", activityId: "event", dayOffset: 2, startHour: 17, durationHours: 4, status: "confirmed", guest: { firstName: "Ines", lastName: "Larsson", email: "ines@nordicpop.se" }, source: "peerspace" },
      { spaceId: "studio-3", activityId: "production", dayOffset: 3, startHour: 11, durationHours: 3.5, status: "confirmed", guest: { firstName: "Marcus", lastName: "Oduya", email: "marcus@oduyamusic.com" }, source: "giggster" },
      { spaceId: "lincoln-apartment", activityId: "production", dayOffset: 3, startHour: 13, durationHours: 6, status: "confirmed", guest: { firstName: "Saoirse", lastName: "Doyle", email: "saoirse@example.com" }, source: "internal" },
      { spaceId: "studio-1", activityId: "meeting", dayOffset: 4, startHour: 15, durationHours: 2.5, status: "confirmed", guest: { firstName: "Kenji", lastName: "Watanabe", email: "kenji@watanabearch.com" }, source: "internal" },
      { spaceId: "studio-2", activityId: "production", dayOffset: 2, startHour: 10, durationHours: 3, status: "held", guest: { firstName: "Lila", lastName: "Bennett", email: "lila.bennett@example.com" }, source: "internal" },
      { spaceId: "studio-3", activityId: "event", dayOffset: 5, startHour: 20, durationHours: 4, status: "pending", guest: { firstName: "Devon", lastName: "Park", email: "devon@parkstudios.io", phone: "212-555-0169" }, source: "internal" },
      { spaceId: "lincoln-apartment", activityId: "meeting", dayOffset: 6, startHour: 14, durationHours: 2, status: "pending", guest: { firstName: "Anya", lastName: "Volkov", email: "anya.volkov@example.com" }, source: "internal" },
      { spaceId: "studio-1", activityId: "production", dayOffset: 7, startHour: 12, durationHours: 4, status: "confirmed", guest: { firstName: "Ravi", lastName: "Iyer", email: "ravi@iyerco.com" }, source: "peerspace" },
      { spaceId: "studio-2", activityId: "production", dayOffset: 8, startHour: 9, durationHours: 3, status: "confirmed", guest: { firstName: "Noor", lastName: "Hassan", email: "noor@hassanvisual.com" }, source: "internal" },
      { spaceId: "studio-3", activityId: "production", dayOffset: 10, startHour: 16, durationHours: 5, status: "confirmed", guest: { firstName: "Eli", lastName: "Mendez", email: "eli@mendezsound.fm" }, source: "giggster" },
      { spaceId: "lincoln-apartment", activityId: "event", dayOffset: 11, startHour: 18, durationHours: 6, status: "confirmed", guest: { firstName: "Tess", lastName: "Galloway", email: "tess.g@example.com" }, source: "internal" },
      { spaceId: "studio-1", activityId: "meeting", dayOffset: 13, startHour: 11, durationHours: 2, status: "confirmed", guest: { firstName: "Aiko", lastName: "Tanaka", email: "aiko@tanakapress.jp" }, source: "internal" },
    ];

    const insertOne = (s: Seed, idx: number) => {
      const start = new Date(day0);
      start.setDate(start.getDate() + s.dayOffset);
      start.setHours(Math.floor(s.startHour), (s.startHour % 1) * 60, 0, 0);
      const end = addMinutes(start, s.durationHours * 60);
      const nowMs = Date.now();
      const row: BookingRow = {
        id: `seed-${s.spaceId}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
        spaceId: s.spaceId,
        activityId: s.activityId,
        start: start.toISOString(),
        end: end.toISOString(),
        status: s.status,
        guestFirstName: s.guest.firstName,
        guestLastName: s.guest.lastName,
        guestEmail: s.guest.email,
        guestPhone: s.guest.phone ?? null,
        holdExpiresAt: s.status === "held" ? nowMs + 18 * 60 * 1000 : null,
        createdAt: nowMs - 3600_000 * 24,
        source: s.source ?? "internal",
      };
      db.insert(bookings).values(row).run();
    };

    seeds.forEach(insertOne);
  }
}

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
