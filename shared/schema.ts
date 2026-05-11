import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Legacy users table (template) — keep for compatibility, unused.
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// ----- Studio Clyx bookings -----

export const bookings = sqliteTable("bookings", {
  id: text("id").primaryKey(),
  spaceId: text("space_id").notNull(), // studio-1 | studio-2 | studio-3 | lincoln-apartment
  activityId: text("activity_id").notNull(), // production | meeting | event
  start: text("start").notNull(), // ISO string
  end: text("end").notNull(), // ISO string
  status: text("status").notNull(), // held | pending | confirmed | rejected
  guestFirstName: text("guest_first_name").notNull(),
  guestLastName: text("guest_last_name").notNull(),
  guestEmail: text("guest_email").notNull(),
  guestPhone: text("guest_phone"),
  guestCount: integer("guest_count").notNull().default(1),
  alcohol: integer("alcohol", { mode: "boolean" }).notNull().default(false),
  addons: text("addons"), // JSON-encoded SelectedAddOn[]
  holdExpiresAt: integer("hold_expires_at"), // epoch ms
  holdActive: integer("hold_active", { mode: "boolean" }).notNull().default(true),
  reminderSentAt: integer("reminder_sent_at"), // epoch ms when owner reminder was sent
  googleEventId: text("google_event_id"), // tentative or confirmed event id (last known)
  googleCalendarId: text("google_calendar_id"), // calendar the event lives on
  createdAt: integer("created_at").notNull(),
  source: text("source").notNull().default("internal"), // internal | peerspace | giggster | google
});

export type BookingRow = typeof bookings.$inferSelect;

// ----- Add-on catalog -----

export const addOnCatalog = sqliteTable("addon_catalog", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  price: real("price").notNull(),
  priceType: text("price_type").notNull().default("per_item"), // per_item | flat
  imageUrl: text("image_url"),
  quantityAvailable: integer("quantity_available"), // null = unspecified
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

export type AddOnCatalogRow = typeof addOnCatalog.$inferSelect;

export const addOnDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  price: z.number(),
  priceType: z.enum(["per_item", "flat"]),
  imageUrl: z.string().nullable().optional(),
  quantityAvailable: z.number().nullable().optional(),
  active: z.boolean(),
  sortOrder: z.number().optional(),
});
export type AddOnDto = z.infer<typeof addOnDtoSchema>;

export const createAddOnSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().max(500).optional().nullable(),
  price: z.number().min(0).max(100000),
  priceType: z.enum(["per_item", "flat"]).default("per_item"),
  imageUrl: z.string().trim().url().optional().nullable().or(z.literal("")),
  quantityAvailable: z.number().int().min(0).optional().nullable(),
  active: z.boolean().default(true),
});
export type CreateAddOnInput = z.infer<typeof createAddOnSchema>;

export const updateAddOnSchema = createAddOnSchema.partial();
export type UpdateAddOnInput = z.infer<typeof updateAddOnSchema>;

// Selected add-on on a booking (stored in the booking row as JSON).
export const selectedAddOnSchema = z.object({
  addOnId: z.string(),
  name: z.string(),
  price: z.number(),
  priceType: z.enum(["per_item", "flat"]),
  quantity: z.number().int().min(1).max(999),
  lineTotal: z.number(),
});
export type SelectedAddOn = z.infer<typeof selectedAddOnSchema>;

// Pricing constants (kept in sync with client/src/lib/booking-data.ts)
export const GUEST_MIN = 1;
export const GUEST_MAX = 40;
export const GUEST_TIER_15_RATE = 0; // 1–15 guests
export const GUEST_TIER_25_RATE = 10; // 16–25 guests, $/hr
export const GUEST_TIER_40_RATE = 20; // 26–40 guests, $/hr
export const EVENT_CLEANING_FEE = 75;
export const ALCOHOL_FEE = 50;

export function guestSurchargeRate(count: number): number {
  if (count <= 15) return GUEST_TIER_15_RATE;
  if (count <= 25) return GUEST_TIER_25_RATE;
  if (count <= GUEST_MAX) return GUEST_TIER_40_RATE;
  return GUEST_TIER_40_RATE;
}

// Public Booking shape used by the client API (matches existing client booking-data.ts shape)
export const bookingDtoSchema = z.object({
  id: z.string(),
  spaceId: z.enum(["studio-1", "studio-2", "studio-3", "lincoln-apartment"]),
  activityId: z.enum(["production", "meeting", "event"]),
  start: z.string(),
  end: z.string(),
  status: z.enum(["held", "pending", "confirmed", "rejected"]),
  guest: z.object({
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    phone: z.string().optional(),
  }),
  guestCount: z.number().int().min(1).max(GUEST_MAX),
  alcohol: z.boolean(),
  addons: z.array(selectedAddOnSchema).default([]),
  holdExpiresAt: z.number().optional(),
  holdActive: z.boolean().optional(),
  reminderSentAt: z.number().optional(),
  googleEventId: z.string().optional(),
  googleCalendarId: z.string().optional(),
  createdAt: z.number(),
  source: z.enum(["internal", "peerspace", "giggster", "google"]).optional(),
});
export type BookingDto = z.infer<typeof bookingDtoSchema>;

// Schema for creating a booking via the public API (always creates a "held" booking)
export const createHoldSchema = z.object({
  spaceId: z.enum(["studio-1", "studio-2", "studio-3", "lincoln-apartment"]),
  activityId: z.enum(["production", "meeting", "event"]),
  start: z.string(),
  end: z.string(),
  guest: z.object({
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
  }),
  guestCount: z.number().int().min(GUEST_MIN).max(GUEST_MAX),
  alcohol: z.boolean().default(false),
  addons: z
    .array(
      z.object({
        addOnId: z.string(),
        quantity: z.number().int().min(1).max(999),
      })
    )
    .default([]),
});
export type CreateHoldInput = z.infer<typeof createHoldSchema>;
