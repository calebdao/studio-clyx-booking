import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
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
  status: text("status").notNull(), // held | pending | confirmed
  guestFirstName: text("guest_first_name").notNull(),
  guestLastName: text("guest_last_name").notNull(),
  guestEmail: text("guest_email").notNull(),
  guestPhone: text("guest_phone"),
  holdExpiresAt: integer("hold_expires_at"), // epoch ms
  createdAt: integer("created_at").notNull(),
  source: text("source").notNull().default("internal"), // internal | peerspace | giggster | google
});

export type BookingRow = typeof bookings.$inferSelect;

// Public Booking shape used by the client API (matches existing client booking-data.ts shape)
export const bookingDtoSchema = z.object({
  id: z.string(),
  spaceId: z.enum(["studio-1", "studio-2", "studio-3", "lincoln-apartment"]),
  activityId: z.enum(["production", "meeting", "event"]),
  start: z.string(),
  end: z.string(),
  status: z.enum(["held", "pending", "confirmed"]),
  guest: z.object({
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    phone: z.string().optional(),
  }),
  holdExpiresAt: z.number().optional(),
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
});
export type CreateHoldInput = z.infer<typeof createHoldSchema>;
