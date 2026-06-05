import fs from "node:fs";
import path from "node:path";
import { storage } from "./storage";
import type { AgentConversationDto, BookingDto } from "@shared/schema";

// ---------------------------------------------------------------------------
// Peerspace email-reply agent — Claude draft generation.
//
// Given an inbound Peerspace message (already stored as a conversation), we
// assemble a prompt from the markdown knowledge base + the full thread history
// + any matched booking context, ask Claude for a reply, and persist it as a
// `pending` draft for an operator to approve/edit/reject in the admin Inbox.
//
// Following the rest of this codebase (Resend, Google Calendar), we call the
// Claude API via direct `fetch` rather than adding an SDK dependency.
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 1024;

const SPACE_LABELS: Record<string, string> = {
  "studio-1": "Studio 1",
  "studio-2": "Studio 2",
  "studio-3": "Studio 3",
  "lincoln-apartment": "Lincoln Apartment",
};

export function agentEnabled(): boolean {
  // Opt-in kill switch. Defaults to disabled unless explicitly turned on, so a
  // misconfigured deploy never auto-emails guests through an unreviewed path.
  return (process.env.AGENT_ENABLED ?? "").toLowerCase() === "true";
}

export function agentModel(): string {
  return process.env.AGENT_MODEL || DEFAULT_MODEL;
}

export function agentStatus() {
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  return {
    enabled: agentEnabled(),
    mode: hasKey ? ("live" as const) : ("simulation" as const),
    model: agentModel(),
    credentialEnv: "ANTHROPIC_API_KEY",
    credentialConfigured: hasKey,
    knowledgeBaseFound: Boolean(loadKnowledgeBase()),
  };
}

// ----- Knowledge base -----

let knowledgeCache: { mtimeMs: number; text: string } | null = null;

function knowledgeBasePath(): string {
  // Resolve relative to cwd (the project root, where the server is started) so
  // it works both in dev and in the bundled production build on Render.
  return (
    process.env.AGENT_KNOWLEDGE_PATH ||
    path.join(process.cwd(), "docs", "agent-knowledge.md")
  );
}

export function loadKnowledgeBase(): string | null {
  const file = knowledgeBasePath();
  try {
    const stat = fs.statSync(file);
    if (knowledgeCache && knowledgeCache.mtimeMs === stat.mtimeMs) {
      return knowledgeCache.text;
    }
    const text = fs.readFileSync(file, "utf8");
    knowledgeCache = { mtimeMs: stat.mtimeMs, text };
    return text;
  } catch {
    return null;
  }
}

// ----- Booking context matching -----

function bookingMatchesName(b: BookingDto, name: string | null): boolean {
  if (!name) return false;
  const hay = `${b.guest.firstName} ${b.guest.lastName}`.toLowerCase();
  const needle = name.toLowerCase().trim();
  if (!needle) return false;
  // Match if the booking's full name contains the guest's name or vice-versa,
  // or if both first and last name tokens appear.
  if (hay.includes(needle) || needle.includes(hay)) return true;
  const tokens = needle.split(/\s+/).filter((t) => t.length > 1);
  return tokens.length >= 2 && tokens.every((t) => hay.includes(t));
}

// Try to link the conversation to an existing booking. Peerspace usually masks
// the guest's real email, so email match often fails — fall back to name. Only
// active/real bookings (not rejected, not external google placeholders) count.
export async function matchBookingForConversation(
  convo: AgentConversationDto
): Promise<BookingDto | null> {
  const all = await storage.listBookings();
  const candidates = all.filter(
    (b) => b.source !== "google" && b.status !== "rejected"
  );

  if (convo.guestEmail) {
    const byEmail = candidates.find(
      (b) => b.guest.email.toLowerCase() === convo.guestEmail!.toLowerCase()
    );
    if (byEmail) return byEmail;
  }

  const byName = candidates.filter((b) =>
    bookingMatchesName(b, convo.guestName ?? null)
  );
  if (byName.length === 1) return byName[0];
  // Ambiguous (multiple same-name bookings) — don't guess; prefer the most
  // recent upcoming one if all share the same email-less identity.
  if (byName.length > 1) {
    byName.sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());
    return byName[0];
  }
  return null;
}

function formatBookingContext(b: BookingDto): string {
  const space = SPACE_LABELS[b.spaceId] ?? b.spaceId;
  const start = new Date(b.start);
  const end = new Date(b.end);
  const fmt = (d: Date) =>
    d.toLocaleString("en-US", {
      timeZone: "America/New_York",
      dateStyle: "full",
      timeStyle: "short",
    });
  const lines = [
    `- Guest on file: ${b.guest.firstName} ${b.guest.lastName}`,
    `- Space: ${space}`,
    `- Activity: ${b.activityId}`,
    `- When: ${fmt(start)} to ${fmt(end)} (America/New_York)`,
    `- Status: ${b.status}${b.paidAt ? " (paid)" : ""}`,
    `- Guests: ${b.guestCount}`,
  ];
  if (b.addons && b.addons.length > 0) {
    lines.push(`- Add-ons: ${b.addons.map((a) => `${a.quantity}× ${a.name}`).join(", ")}`);
  }
  return lines.join("\n");
}

// ----- Prompt assembly -----

// Format the Peerspace "Inquiry details" JSON into prompt context.
function formatInquiryContext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as {
      listing?: string | null;
      dateTime?: string | null;
      attendees?: string | null;
    };
    const lines: string[] = [];
    if (d.listing) lines.push(`- Peerspace listing the guest is asking about: ${d.listing}`);
    if (d.dateTime) lines.push(`- Requested date/time: ${d.dateTime}`);
    if (d.attendees) lines.push(`- Party size on the original inquiry: ${d.attendees}`);
    return lines.length ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

function buildSystemPrompt(
  knowledge: string,
  bookingContext: string | null,
  inquiryContext: string | null
): string {
  return [
    "You are the email assistant for Studio Clyx, replying to a guest who",
    "contacted us through Peerspace. You are drafting a reply for a human",
    "operator to review before it is sent — write the final email body only.",
    "",
    "Use ONLY the knowledge base below for facts about spaces, pricing, policy,",
    "and booking rules. Follow the guardrails in it strictly. Do not invent",
    "availability, prices, or policies. Be warm, concise, and professional, and",
    "sign off as \"Studio Clyx\".",
    "",
    "Output plain text only: no subject line, no markdown, no placeholders like",
    "[name] — write a complete, ready-to-send email body.",
    "",
    "===== KNOWLEDGE BASE =====",
    knowledge,
    "===== END KNOWLEDGE BASE =====",
    ...(inquiryContext
      ? [
          "",
          "===== PEERSPACE INQUIRY CONTEXT (what the guest's request is about — reference naturally) =====",
          inquiryContext,
          "===== END INQUIRY CONTEXT =====",
        ]
      : []),
    ...(bookingContext
      ? [
          "",
          "===== MATCHED BOOKING (internal context — reference naturally, do not paste verbatim) =====",
          bookingContext,
          "===== END MATCHED BOOKING =====",
        ]
      : []),
  ].join("\n");
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// Map stored thread history to Claude messages. Inbound (from the guest) is the
// user; our outbound replies are the assistant. Collapse consecutive same-role
// turns and ensure the sequence ends on a user turn (the message to reply to).
function buildMessages(convo: AgentConversationDto): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (const m of convo.messages) {
    const role: ChatMessage["role"] =
      m.direction === "inbound" ? "user" : "assistant";
    const body = (m.bodyText || m.bodyHtml || "").trim();
    if (!body) continue;
    const text =
      role === "user" && m.subject
        ? `Subject: ${m.subject}\n\n${body}`
        : body;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) {
      last.content += `\n\n${text}`;
    } else {
      msgs.push({ role, content: text });
    }
  }
  if (msgs.length === 0 || msgs[0].role !== "user") {
    // Claude requires the first message to be from the user.
    msgs.unshift({ role: "user", content: "(no message body)" });
  }
  return msgs;
}

// ----- Claude call -----

interface GenerateResult {
  ok: boolean;
  text?: string;
  error?: string;
  simulated?: boolean;
}

async function callClaude(
  system: string,
  messages: ChatMessage[]
): Promise<GenerateResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: true,
      simulated: true,
      text:
        "[SIMULATED DRAFT — ANTHROPIC_API_KEY not set]\n\n" +
        "Hi there,\n\nThanks so much for reaching out about Studio Clyx! " +
        "I'd be happy to help. (This is placeholder text generated without an " +
        "AI key — set ANTHROPIC_API_KEY to get real drafts.)\n\nBest,\nStudio Clyx",
    };
  }
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: agentModel(),
        max_tokens: MAX_TOKENS,
        system,
        messages,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Claude API ${res.status}: ${body.slice(0, 500)}` };
    }
    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text as string)
      .join("\n")
      .trim();
    if (!text) return { ok: false, error: "Claude returned no text content" };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function replySubject(convo: AgentConversationDto): string {
  const base = convo.subject?.trim();
  if (!base) return "Re: Your Studio Clyx inquiry";
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

// ----- Orchestration (called from the inbound route) -----

export async function generateDraftForConversation(
  conversationId: string,
  inboundMessageId: string
): Promise<void> {
  if (!agentEnabled()) {
    console.log(
      `[agent] AGENT_ENABLED is not 'true'; skipping draft for ${conversationId}`
    );
    return;
  }

  const convo = await storage.getAgentConversation(conversationId);
  if (!convo) {
    console.error(`[agent] conversation ${conversationId} not found for draft`);
    return;
  }

  const knowledge = loadKnowledgeBase();
  if (!knowledge) {
    console.error("[agent] knowledge base missing; recording error draft");
    await storage.createAgentDraft({
      conversationId,
      inboundMessageId,
      status: "error",
      error: "Knowledge base (docs/agent-knowledge.md) not found.",
      model: agentModel(),
    });
    return;
  }

  // Link a booking if we can, and persist it on the conversation for context.
  let booking: BookingDto | null = null;
  try {
    booking = await matchBookingForConversation(convo);
    if (booking && booking.id !== convo.bookingId) {
      await storage.setConversationBooking(conversationId, booking.id);
    }
  } catch (e) {
    console.error("[agent] booking match error (continuing without):", e);
  }

  const system = buildSystemPrompt(
    knowledge,
    booking ? formatBookingContext(booking) : null,
    formatInquiryContext(convo.inquiryDetails)
  );
  const messages = buildMessages(convo);

  const result = await callClaude(system, messages);
  if (!result.ok) {
    console.error(`[agent] draft generation failed for ${conversationId}: ${result.error}`);
    await storage.createAgentDraft({
      conversationId,
      inboundMessageId,
      status: "error",
      error: result.error ?? "Unknown Claude error",
      model: agentModel(),
    });
    return;
  }

  await storage.createAgentDraft({
    conversationId,
    inboundMessageId,
    proposedSubject: replySubject(convo),
    proposedBodyText: result.text,
    status: "pending",
    model: result.simulated ? "simulation" : agentModel(),
  });
  console.log(
    `[agent] created ${result.simulated ? "simulated " : ""}draft for conversation ${conversationId}`
  );
}
