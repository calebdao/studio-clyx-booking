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
  paymentMethod: text("payment_method").notNull().default("zelle"), // zelle | card
  cardFeeAmount: real("card_fee_amount").notNull().default(0), // Stripe surcharge passed to customer
  paidAt: integer("paid_at"), // epoch ms when payment cleared (Stripe webhook only; Zelle stays null)
  stripePaymentIntentId: text("stripe_payment_intent_id"),
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

// Stripe domestic-card fees (US): 2.9% + $0.30 per successful charge.
// We gross up so the customer absorbs the fee and the merchant nets the
// original booking total. Formula: gross = (base + 0.30) / (1 - 0.029).
// surcharge = gross - base. Numbers are kept here as a single source of
// truth so client preview and server-authoritative math always agree.
export const STRIPE_FEE_PERCENT = 0.029;
export const STRIPE_FEE_FIXED = 0.3;

export function computeCardSurcharge(baseTotal: number): number {
  if (!Number.isFinite(baseTotal) || baseTotal <= 0) return 0;
  const gross = (baseTotal + STRIPE_FEE_FIXED) / (1 - STRIPE_FEE_PERCENT);
  return Math.round((gross - baseTotal) * 100) / 100;
}

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
  paymentMethod: z.enum(["zelle", "card"]).default("zelle"),
  cardFeeAmount: z.number().default(0),
  paidAt: z.number().optional(),
  stripePaymentIntentId: z.string().optional(),
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
  paymentMethod: z.enum(["zelle", "card"]).default("zelle"),
});
export type CreateHoldInput = z.infer<typeof createHoldSchema>;

// ----- Peerspace email-reply agent -----
//
// Inbound Peerspace notification emails are forwarded into Resend Inbound,
// which POSTs the parsed message to /api/agent/inbound-email. Each Peerspace
// message thread has a unique Reply-To address; we use that address as the
// stable thread token to group an entire conversation. Claude drafts a reply
// (agent_drafts); an operator approves/edits/rejects it in the admin Inbox;
// on approve we email the reply back to the thread's Reply-To via Resend.

export const agentConversations = sqliteTable("agent_conversations", {
  id: text("id").primaryKey(),
  threadToken: text("thread_token").notNull().unique(), // normalized Peerspace Reply-To address
  peerspaceReplyTo: text("peerspace_reply_to"), // full Reply-To header value
  guestName: text("guest_name"),
  guestEmail: text("guest_email"), // may be masked by Peerspace / null
  bookingId: text("booking_id"), // matched booking, if any (refs bookings.id)
  subject: text("subject"),
  status: text("status").notNull().default("open"), // open | closed
  inquiryDetails: text("inquiry_details"), // JSON {listing,dateTime,attendees} parsed from the Peerspace email
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export type AgentConversationRow = typeof agentConversations.$inferSelect;

export const agentMessages = sqliteTable("agent_messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  direction: text("direction").notNull(), // inbound | outbound
  fromAddress: text("from_address"),
  toAddress: text("to_address"),
  subject: text("subject"),
  bodyText: text("body_text"),
  bodyHtml: text("body_html"),
  providerMessageId: text("provider_message_id"), // for inbound dedupe; Resend id for outbound
  rawJson: text("raw_json"), // original provider payload (inbound) for debugging
  createdAt: integer("created_at").notNull(),
});
export type AgentMessageRow = typeof agentMessages.$inferSelect;

export const agentDrafts = sqliteTable("agent_drafts", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  inboundMessageId: text("inbound_message_id").notNull(),
  proposedSubject: text("proposed_subject"),
  proposedBodyText: text("proposed_body_text"),
  proposedBodyHtml: text("proposed_body_html"),
  editedBody: text("edited_body"), // operator's edited plain-text override, if any
  model: text("model"),
  status: text("status").notNull().default("pending"), // pending | approved | rejected | sent | error
  reviewedBy: text("reviewed_by"),
  reviewedAt: integer("reviewed_at"),
  sentAt: integer("sent_at"),
  resendId: text("resend_id"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
});
export type AgentDraftRow = typeof agentDrafts.$inferSelect;

// DTOs returned by the admin Inbox API.
export const agentMessageDtoSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  fromAddress: z.string().nullable().optional(),
  toAddress: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  bodyText: z.string().nullable().optional(),
  bodyHtml: z.string().nullable().optional(),
  createdAt: z.number(),
});
export type AgentMessageDto = z.infer<typeof agentMessageDtoSchema>;

export const agentDraftDtoSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  inboundMessageId: z.string(),
  proposedSubject: z.string().nullable().optional(),
  proposedBodyText: z.string().nullable().optional(),
  editedBody: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  status: z.enum(["pending", "approved", "rejected", "sent", "error"]),
  reviewedAt: z.number().nullable().optional(),
  sentAt: z.number().nullable().optional(),
  resendId: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: z.number(),
});
export type AgentDraftDto = z.infer<typeof agentDraftDtoSchema>;

export const agentConversationDtoSchema = z.object({
  id: z.string(),
  threadToken: z.string(),
  peerspaceReplyTo: z.string().nullable().optional(),
  guestName: z.string().nullable().optional(),
  guestEmail: z.string().nullable().optional(),
  bookingId: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  status: z.enum(["open", "closed"]),
  inquiryDetails: z.string().nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messages: z.array(agentMessageDtoSchema).default([]),
  drafts: z.array(agentDraftDtoSchema).default([]),
});
export type AgentConversationDto = z.infer<typeof agentConversationDtoSchema>;

// Operator action on a draft from the admin Inbox.
export const agentDraftActionSchema = z.object({
  action: z.enum(["approve", "reject", "edit"]),
  editedBody: z.string().trim().min(1).optional(),
});
export type AgentDraftAction = z.infer<typeof agentDraftActionSchema>;
