import fs from "node:fs";
import path from "node:path";
import { storage } from "./storage";
import { sendAgentReplyEmail } from "./gmail";
import { sendAgentNovelQuestionAlert } from "./integrations";
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

// Auto-send: when on, confident *Q&A reply* drafts are emailed automatically (no
// manual approval). Off by default — flip on only when you trust the bot's answers.
export function agentAutoSend(): boolean {
  return (process.env.AGENT_AUTO_SEND ?? "").toLowerCase() === "true";
}

// Auto-send for *booking entry instructions* — independent of Q&A auto-send, since
// instructions are deterministic verbatim templates (no AI). Also on whenever the
// global auto-send is on. Lets you auto-send instructions while keeping replies
// in draft mode.
export function agentAutoSendInstructions(): boolean {
  return (
    (process.env.AGENT_AUTO_SEND_INSTRUCTIONS ?? "").toLowerCase() === "true" ||
    agentAutoSend()
  );
}

// Phrases that mean the reply is deferring to a human — never auto-send these,
// even if the model marked itself confident.
const ESCALATION_PHRASES = [
  "team member will follow up",
  "team will follow up",
  "we'll follow up",
  "we will follow up",
  "get back to you",
  "follow up personally",
];
function deferringToHuman(text: string): boolean {
  const s = text.toLowerCase();
  return ESCALATION_PHRASES.some((p) => s.includes(p));
}

// Name the bot signs Q&A replies as. Defaults to Gladys; override per-deploy.
export function signoffName(): string {
  return (process.env.AGENT_SIGNOFF_NAME || "Gladys").trim() || "Gladys";
}

// Force every outgoing Q&A reply to close with the configured signer. The system
// prompt already asks for it; this is a deterministic backstop so a reply never
// goes out signed as "Studio Clyx"/"the team" or unsigned if the model deviates.
function enforceSignoff(reply: string, name: string): string {
  const text = reply.replace(/\s+$/, "");
  // Already signed by them near the end → leave as-is.
  if (text.slice(-60).toLowerCase().includes(name.toLowerCase())) return text;
  // A trailing studio-name sign-off → swap it for the signer (won't touch
  // "Studio Clyx" mentions elsewhere in the body).
  const trailingStudio = /(the\s+)?studio\s+clyx(\s+team)?\s*$/i;
  if (trailingStudio.test(text)) return text.replace(trailingStudio, name);
  // No detectable sign-off → append one.
  return `${text}\n\nWarmly,\n${name}`;
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
    knowledgeSource: getEffectiveKnowledge().source,
    autoSend: agentAutoSend(),
    autoSendInstructions: agentAutoSendInstructions(),
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

const KNOWLEDGE_SETTING_KEY = "agent_knowledge";

function readKnowledgeFile(): string | null {
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

// Effective knowledge base: the operator's DB-saved version (edited from the
// admin Knowledge tab) wins; otherwise fall back to the committed file default.
export function getEffectiveKnowledge(): {
  text: string | null;
  source: "db" | "file" | null;
} {
  const dbVal = storage.getSetting(KNOWLEDGE_SETTING_KEY);
  if (dbVal && dbVal.trim()) return { text: dbVal, source: "db" };
  const fileVal = readKnowledgeFile();
  if (fileVal && fileVal.trim()) return { text: fileVal, source: "file" };
  return { text: null, source: null };
}

export function loadKnowledgeBase(): string | null {
  return getEffectiveKnowledge().text;
}

// The committed file default (used by the editor's "reset to default").
export function getKnowledgeFileDefault(): string | null {
  return readKnowledgeFile();
}

export function saveKnowledge(text: string): void {
  storage.setSetting(KNOWLEDGE_SETTING_KEY, text);
}

export function resetKnowledgeToFile(): void {
  storage.deleteSetting(KNOWLEDGE_SETTING_KEY);
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
    "contacted us through Peerspace.",
    "",
    "CRITICAL: Answer ONLY using facts explicitly stated in the knowledge base",
    "below. Never invent or guess availability, prices, fees, policies, amenities,",
    "or any other fact. If the guest's question is not fully covered by the",
    "knowledge base — or it needs human judgment (a pricing exception, a discount,",
    "a dispute/refund, confirming a specific date is free, or anything sensitive)",
    "— you are NOT confident.",
    "",
    "Respond with ONLY a single JSON object (no markdown, no code fences, nothing",
    "else), in this exact shape:",
    '{"confident": true|false, "reply": "<the full email body>", "missing": "<short note>"}',
    "",
    "- If the knowledge base fully covers the question: set confident=true, put a",
    "  complete, ready-to-send plain-text email body in \"reply\" (warm, concise,",
    `  professional; ALWAYS sign off as "${signoffName()}" (e.g. "Warmly,\\n${signoffName()}");`,
    "  do NOT sign as \"Studio Clyx\" or \"the team\"; no placeholders like [name]), and",
    "  set \"missing\" to \"\".",
    "- Otherwise: set confident=false, set \"reply\" to \"\", and in \"missing\"",
    "  briefly describe what information is needed to answer. Do NOT write a",
    "  guessed reply.",
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
      text: JSON.stringify({
        confident: true,
        reply:
          "[SIMULATED DRAFT — ANTHROPIC_API_KEY not set]\n\nHi there,\n\nThanks " +
          "so much for reaching out about Studio Clyx! (Placeholder reply — set " +
          "ANTHROPIC_API_KEY for real drafts.)\n\nBest,\nStudio Clyx",
        missing: "",
      }),
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

interface StructuredReply {
  confident: boolean;
  reply: string;
  missing: string;
}

// Parse the model's JSON answer leniently. Anything we can't parse, or that
// claims confidence without a real reply, is treated as NOT confident — the safe
// default (a human reviews it; nothing auto-sends).
function parseStructured(text: string): StructuredReply {
  let raw = text.trim();
  // Strip ```json fences or stray prose around the object.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) raw = raw.slice(first, last + 1);
  try {
    const o = JSON.parse(raw) as Partial<StructuredReply>;
    const reply = typeof o.reply === "string" ? o.reply.trim() : "";
    const confident = o.confident === true && reply.length > 0;
    return {
      confident,
      reply,
      missing: typeof o.missing === "string" ? o.missing.trim() : "",
    };
  } catch {
    return {
      confident: false,
      reply: "",
      missing: "The assistant's response could not be parsed.",
    };
  }
}

// Shared send path: email an approved/auto-approved reply into the Peerspace
// thread, record the outbound message, and mark the draft sent. Used by both the
// admin Approve button and auto-send.
export async function deliverReply(args: {
  conversation: { id: string; peerspaceReplyTo?: string | null };
  draftId: string;
  subject: string;
  text: string;
  auto?: boolean; // true when sent automatically (not operator-approved)
}): Promise<{ ok: boolean; simulated: boolean; error?: string }> {
  const to = args.conversation.peerspaceReplyTo;
  if (!to || !to.includes("@")) {
    return { ok: false, simulated: false, error: "No reply address on this conversation." };
  }
  const send = await sendAgentReplyEmail({
    to,
    subject: args.subject,
    text: args.text,
    conversationId: args.conversation.id,
  });
  if (!send.ok) {
    const error = ("error" in send && send.error) || "Failed to send reply.";
    await storage.updateAgentDraft(args.draftId, { status: "error", error: String(error) });
    return { ok: false, simulated: false, error: String(error) };
  }
  const providerId = "providerId" in send ? (send.providerId ?? null) : null;
  await storage.addAgentMessage({
    conversationId: args.conversation.id,
    direction: "outbound",
    fromAddress: process.env.GMAIL_USER || null,
    toAddress: to,
    subject: args.subject,
    bodyText: args.text,
    providerMessageId: providerId,
  });
  await storage.updateAgentDraft(args.draftId, {
    status: "sent",
    sentAt: Date.now(),
    reviewedAt: Date.now(),
    resendId: providerId,
    autoSent: Boolean(args.auto),
  });
  return { ok: true, simulated: send.mode === "simulation" };
}

// Append an operator's answer to a guest question into the knowledge base (the
// editable DB copy) under a "Learned answers" section, so the bot can handle
// similar questions itself next time.
export function appendLearnedAnswer(question: string, answer: string): void {
  const q = question.trim();
  const a = answer.trim();
  if (!a) return;
  const current = getEffectiveKnowledge().text || "";
  const entry = `\n\n**Q: ${q || "(guest question)"}**\n${a}\n`;
  const hasSection = /(^|\n)##\s*Learned answers/i.test(current);
  const next = hasSection
    ? current.replace(/\s*$/, "") + entry
    : current.replace(/\s*$/, "") +
      "\n\n## Learned answers\n\n_Added from operator replies to novel questions._\n" +
      entry;
  saveKnowledge(next);
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

  const model = result.simulated ? "simulation" : agentModel();
  const structured = parseStructured(result.text ?? "");
  const subject = replySubject(convo);

  // Novel / not-confident → flag for a human, do NOT send, and alert the operator.
  if (!structured.confident) {
    await storage.createAgentDraft({
      conversationId,
      inboundMessageId,
      proposedSubject: subject,
      proposedBodyText: null,
      status: "pending",
      needsHuman: true,
      model,
      error:
        structured.missing ||
        "Not confident this question is covered by the knowledge base.",
    });
    console.log(
      `[agent] novel question in conversation ${conversationId}; flagged for human`
    );
    try {
      const lastInbound = [...convo.messages]
        .reverse()
        .find((m) => m.direction === "inbound");
      await sendAgentNovelQuestionAlert({
        guestName: convo.guestName ?? null,
        question: lastInbound?.bodyText ?? convo.subject ?? "(no message)",
        missing: structured.missing || null,
        conversationId,
      });
    } catch (e) {
      console.error("[agent] novel-question alert failed:", e);
    }
    return;
  }

  // Confident → create the draft. Auto-send only if enabled and the reply isn't
  // itself deferring to a human. Enforce the Gladys sign-off on the way out.
  const replyText = enforceSignoff(structured.reply, signoffName());
  const draft = await storage.createAgentDraft({
    conversationId,
    inboundMessageId,
    proposedSubject: subject,
    proposedBodyText: replyText,
    status: "pending",
    model,
  });

  if (agentAutoSend() && !deferringToHuman(replyText)) {
    const sent = await deliverReply({
      conversation: convo,
      draftId: draft.id,
      subject,
      text: replyText,
      auto: true,
    });
    console.log(
      sent.ok
        ? `[agent] auto-sent reply for conversation ${conversationId}${sent.simulated ? " (simulation)" : ""}`
        : `[agent] auto-send failed for ${conversationId}: ${sent.error}`
    );
    return;
  }

  console.log(
    `[agent] created ${result.simulated ? "simulated " : ""}draft for conversation ${conversationId}`
  );
}
