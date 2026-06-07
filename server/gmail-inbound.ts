import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { storage } from "./storage";
import {
  agentAutoSendInstructions,
  agentEnabled,
  deliverReply,
  generateDraftForConversation,
} from "./agent";
import {
  EVENT_SECURITY_NOTE,
  isBookingEmail,
  isBookingReminder,
  parseBooking,
  selectInstruction,
} from "./booking-instructions";
import { sendAgentNovelQuestionAlert } from "./integrations";

// ---------------------------------------------------------------------------
// Gmail IMAP poller for the Peerspace email-reply agent.
//
// Peerspace notification emails land in the Gmail account linked to Peerspace
// (calebandgladys@gmail.com). Rather than pay for an inbound email service, we
// read them straight from that inbox over IMAP using the SAME app password the
// SMTP sender (server/gmail.ts) uses. Every poll we look for unread messages
// from Peerspace, parse them, feed them into the same pipeline as before
// (storage.recordInboundEmail → Claude draft), and mark them read.
//
// Env:
//   GMAIL_USER / GMAIL_APP_PASSWORD   the linked Gmail + app password (shared
//                                     with server/gmail.ts). Requires IMAP to be
//                                     enabled in Gmail settings.
//   PEERSPACE_SENDER_MATCH            substring matched against the From header
//                                     to pick out Peerspace mail (default
//                                     "peerspace.com") so we never touch the
//                                     account's other email.
//   AGENT_INBOX_FOLDER                mailbox/label to read (default "INBOX").
//   AGENT_POLL_SECONDS                poll interval (default 60, min 30).
// ---------------------------------------------------------------------------

function senderMatch(): string {
  return process.env.PEERSPACE_SENDER_MATCH || "peerspace.com";
}
function inboxFolder(): string {
  return process.env.AGENT_INBOX_FOLDER || "INBOX";
}
function pollMs(): number {
  const secs = Number(process.env.AGENT_POLL_SECONDS || 60);
  return Math.max(30, Number.isFinite(secs) ? secs : 60) * 1000;
}
function maxPerPoll(): number {
  // Hard cap on messages handled per cycle. Keeps memory bounded so a large
  // backlog of unread Peerspace mail can't OOM a small (512MB) instance — the
  // rest drain on later polls.
  const n = Number(process.env.AGENT_MAX_PER_POLL || 5);
  return Math.max(1, Number.isFinite(n) ? n : 5);
}

// Max characters of plain-text body we keep/draft from. Plenty for a guest
// message; keeps rows (and prompts) small.
const MAX_BODY_CHARS = 16000;

// Peerspace also emails automated notifications (booking confirmed, payment,
// review requests, etc.) from the same domain — those are NOT guest messages
// and shouldn't get a drafted reply. We skip any email whose subject matches one
// of these phrases. Override the whole list with PEERSPACE_IGNORE_SUBJECTS
// (comma-separated). Or, for a stricter allowlist, set PEERSPACE_MESSAGE_SUBJECTS
// and we ONLY process subjects containing one of those.
const DEFAULT_IGNORE_SUBJECTS = [
  "is confirmed",
  "booking confirmed",
  "booking request",
  "new booking request",
  "payment received",
  "you've been paid",
  "payout",
  "receipt",
  "leave a review",
  "review your",
  "how was your",
  "reminder",
  "upcoming booking",
  "has been cancelled",
  "booking declined",
  "request expired",
  "refund",
  "coming up",
  "starts soon",
  "action required",
  "respond now",
  "response rate",
];

// Peerspace operational nudges to the host (response-rate prompts, "respond now"
// payout reminders, etc.) are signed by the "Host success team" and aren't guest
// messages — a reliable body-level backstop in case the subject varies.
function isHostOpsEmail(text: string | null): boolean {
  if (!text) return false;
  return (
    /host success team/i.test(text) ||
    /protect your response rate/i.test(text) ||
    (/\brespond now\b/i.test(text) && /response rate/i.test(text))
  );
}

function csvEnv(name: string): string[] | null {
  const v = process.env[name];
  if (!v || !v.trim()) return null;
  return v
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Decide whether an email subject looks like an actual guest message (worth
// drafting a reply) vs. an automated Peerspace notification (skip).
function isActionableSubject(subject: string | null | undefined): boolean {
  const s = (subject || "").toLowerCase();
  const allow = csvEnv("PEERSPACE_MESSAGE_SUBJECTS");
  if (allow) return allow.some((a) => s.includes(a)); // strict allowlist mode
  const ignore = csvEnv("PEERSPACE_IGNORE_SUBJECTS") ?? DEFAULT_IGNORE_SUBJECTS;
  return !ignore.some((phrase) => s.includes(phrase)); // blocklist mode
}

export function gmailInboundConfigured(): boolean {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

export function gmailInboundStatus() {
  const live = gmailInboundConfigured() && agentEnabled();
  return {
    name: "Gmail inbound (Peerspace)",
    mode: live ? ("live" as const) : ("simulation" as const),
    userConfigured: Boolean(process.env.GMAIL_USER),
    passConfigured: Boolean(process.env.GMAIL_APP_PASSWORD),
    agentEnabled: agentEnabled(),
    folder: inboxFolder(),
    senderMatch: senderMatch(),
    pollSeconds: pollMs() / 1000,
    maxPerPoll: maxPerPoll(),
  };
}

// Pull the first usable address (+ display name) out of mailparser's
// AddressObject, which may be a single object or an array.
function firstAddress(a?: AddressObject | AddressObject[]): {
  address: string | null;
  name: string | null;
  text: string | null;
} {
  if (!a) return { address: null, name: null, text: null };
  const obj = Array.isArray(a) ? a[0] : a;
  const first = obj?.value?.[0];
  return {
    address: first?.address ? first.address.toLowerCase() : null,
    name: first?.name || null,
    text: obj?.text || null,
  };
}

// Best-effort un-masked guest email from the body (Peerspace usually masks it).
function findGuestEmailInBody(text: string | null): string | null {
  if (!text) return null;
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  if (!matches) return null;
  const candidate = matches.find(
    (m) => !/peerspace\.com$/i.test(m) && !/studioclyx\.com$/i.test(m)
  );
  return candidate ? candidate.toLowerCase() : null;
}

// Strip Peerspace email boilerplate (header preamble, footer links/legal) and
// quoted reply history so the stored body is just the guest's message.
// Conservative on purpose: if stripping would leave almost nothing, we keep the
// original text rather than risk hiding the message. The exact markers depend on
// Peerspace's email format — refine `LEAD_MARKERS`/`FOOTER_MARKERS` from a real
// sample.
const LEAD_MARKERS = [
  /sent you a message[^\n]*:?\s*\n/i,
  /new message from [^\n]+\n/i,
  /wrote:\s*\n/i,
  /sent you the following message[^\n]*:?\s*\n/i,
];
const FOOTER_MARKERS = [
  /\n\s*On .+?\bwrote:/i, // quoted reply history
  /reply (directly )?to this email/i,
  /view (the )?(conversation|message|thread)/i,
  /respond to .+ on peerspace/i,
  /go to your inbox/i,
  /unsubscribe/i,
  /manage your (email )?(notification|preference)/i,
  /this (email|message) was sent/i,
  /peerspace,? inc/i,
  /https?:\/\/\S*peerspace\.com/i,
  /©\s*\d{0,4}\s*peerspace/i,
  /get the (peerspace )?app/i,
];

function extractGuestMessage(raw: string | null): string | null {
  if (!raw) return raw;
  let text = raw.replace(/\r\n?/g, "\n");

  // Preferred: Peerspace puts the guest's message between a "Message from
  // <name>:" line and the "Stay safe on Peerspace" safety notice. Everything
  // else in the email is boilerplate.
  const startM = text.match(/Message from .+?:\s*\n/i);
  if (startM && startM.index !== undefined) {
    const rest = text.slice(startM.index + startM[0].length);
    const endIdx = rest.search(/Stay safe on Peerspace/i);
    const msg = (endIdx !== -1 ? rest.slice(0, endIdx) : rest)
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[\s*]+$/g, "") // drop trailing whitespace + the "*" before the notice
      .trim();
    if (msg.length >= 2) return msg;
  }

  // Fallback for any other format: strip footer/quoted history heuristically.
  // Cut everything from the first footer/quoted-history marker onward.
  let cut = text.length;
  for (const re of FOOTER_MARKERS) {
    const i = text.search(re);
    if (i !== -1 && i < cut) cut = i;
  }
  text = text.slice(0, cut);

  // Drop a leading header block ("… sent you a message:" etc.).
  for (const re of LEAD_MARKERS) {
    const m = text.match(re);
    if (m && m.index !== undefined) {
      text = text.slice(m.index + m[0].length);
      break;
    }
  }

  // Drop quoted ">" lines, collapse blank runs, trim.
  text = text
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Safety net: don't return an over-stripped result.
  return text.length >= 3 ? text : raw.trim();
}

interface InquiryDetails {
  listing: string | null;
  dateTime: string | null;
  attendees: string | null;
}

// Parse Peerspace's "Inquiry details" block (listing, date/time, attendees).
// Returns null if the section isn't present.
function parseInquiry(raw: string | null): InquiryDetails | null {
  if (!raw || !/Inquiry details/i.test(raw)) return null;
  const text = raw.replace(/\r\n?/g, "\n");
  const valueAfter = (label: string): string | null => {
    const re = new RegExp(
      label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\n+\\s*([^\\n]+)",
      "i"
    );
    const m = text.match(re);
    if (!m) return null;
    const v = m[1].trim().replace(/^\*+|\*+$/g, "").trim();
    return v || null;
  };
  const listing = valueAfter("Inquiry details");
  const dateTime = valueAfter("Date and time");
  const attendees = valueAfter("Attendees");
  if (!listing && !dateTime && !attendees) return null;
  return { listing, dateTime, attendees };
}

function norm(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Group all emails of one Peerspace conversation together. Peerspace's Reply-To
// token can differ between messages, so prefer a stable identity built from the
// guest name + listing + requested date/time (the inquiry's identity); fall back
// to the reply address when those aren't available.
function computeThreadKey(
  guestName: string | null,
  inquiry: InquiryDetails | null,
  fallbackAddress: string
): string {
  if (guestName && inquiry?.listing && inquiry?.dateTime) {
    return `ps:${norm(guestName)}|${norm(inquiry.listing)}|${norm(inquiry.dateTime)}`;
  }
  return fallbackAddress.toLowerCase();
}

async function ingestRawEmail(source: Buffer): Promise<void> {
  const parsed = await simpleParser(source);
  const from = firstAddress(parsed.from);
  const to = firstAddress(parsed.to);
  const replyTo = firstAddress(parsed.replyTo);

  // The address we'll reply to (Peerspace's threaded Reply-To; fall back to From).
  const replyAddress = replyTo.address || from.address;
  if (!replyAddress) {
    console.warn("[gmail-inbound] message had no resolvable reply address; skipping");
    return;
  }

  // Booking reminders ("your booking … is coming up") are neither a new booking
  // nor a guest message — ignore them entirely (don't reply, don't re-send
  // instructions).
  if (isBookingReminder(parsed.text || null)) {
    console.log("[gmail-inbound] booking reminder ('coming up'); skipping");
    return;
  }

  // Peerspace host-ops nudges (respond now / response rate / payout reminders).
  if (isHostOpsEmail(parsed.text || null)) {
    console.log("[gmail-inbound] Peerspace host-ops nudge; skipping");
    return;
  }

  // Confirmed-booking emails get the deterministic entry-instructions flow, not
  // the Q&A bot.
  if (isBookingEmail(parsed.text || null)) {
    await handleBookingEmail({
      rawText: parsed.text || "",
      from,
      to,
      replyAddress,
      subject: parsed.subject || null,
      messageId: parsed.messageId || null,
    });
    return;
  }

  const inquiry = parseInquiry(parsed.text || null);
  // Stable conversation identity (so follow-ups land in the same chatbox).
  const threadToken = computeThreadKey(from.name, inquiry, replyAddress);

  // Cap the stored body and DO NOT persist the HTML body. Peerspace HTML emails
  // can embed large base64 inline images (several MB); storing that and later
  // loading it via SQLite `.all()` is what OOM'd the process. We draft from the
  // plain-text body, which is small.
  const rawText = parsed.text || null;
  const cleaned = extractGuestMessage(rawText);
  const bodyText =
    cleaned && cleaned.length > MAX_BODY_CHARS
      ? cleaned.slice(0, MAX_BODY_CHARS) + "\n…[truncated]"
      : cleaned;

  const { conversation, message, duplicate } = await storage.recordInboundEmail({
    threadToken,
    peerspaceReplyTo: replyAddress, // where to send replies (latest wins)
    guestName: from.name,
    guestEmail: findGuestEmailInBody(rawText),
    subject: parsed.subject || null,
    fromAddress: from.text || from.address,
    toAddress: to.address,
    bodyText,
    bodyHtml: null, // never store HTML — see note above
    providerMessageId: parsed.messageId || null,
    rawJson: null,
    inquiryDetails: inquiry ? JSON.stringify(inquiry) : null,
  });

  if (duplicate) return;

  // Draft sequentially (awaited) — NOT fire-and-forget — so a backlog can't fan
  // out into many concurrent Claude calls + DB scans and exhaust memory. A draft
  // failure is logged but must not stop us marking the email read upstream
  // (generateDraftForConversation records its own error draft internally).
  try {
    await generateDraftForConversation(conversation.id, message.id);
  } catch (e) {
    console.error("[gmail-inbound] draft generation error:", e);
  }
}

// Deterministic flow for confirmed-booking emails: identify the studio + start
// time and send the matching entry instructions (codes come from the DB-stored
// templates). If we can't confidently resolve the studio/time/template, flag it
// for a human instead of sending a wrong or blank code.
async function handleBookingEmail(args: {
  rawText: string;
  from: { address: string | null; name: string | null; text: string | null };
  to: { address: string | null; name: string | null; text: string | null };
  replyAddress: string;
  subject: string | null;
  messageId: string | null;
}): Promise<void> {
  const info = parseBooking(args.rawText);
  const threadToken = computeThreadKey(
    args.from.name,
    { listing: info.spaceText, dateTime: info.dateTimeText, attendees: null },
    args.replyAddress
  );
  const summary =
    `📅 Booking confirmed${info.spaceText ? " — " + info.spaceText : ""}` +
    `${info.dateTimeText ? " · " + info.dateTimeText : ""}.` +
    (info.guestNote ? `\n\nGuest note:\n${info.guestNote}` : "");

  const { conversation, message, duplicate } = await storage.recordInboundEmail({
    threadToken,
    peerspaceReplyTo: args.replyAddress,
    guestName: args.from.name,
    guestEmail: null,
    subject: args.subject,
    fromAddress: args.from.text || args.from.address,
    toAddress: args.to.address,
    bodyText: summary.slice(0, MAX_BODY_CHARS),
    bodyHtml: null,
    providerMessageId: args.messageId,
    rawJson: null,
    inquiryDetails: JSON.stringify({
      listing: info.spaceText,
      dateTime: info.dateTimeText,
      attendees: null,
    }),
  });
  if (duplicate) return;

  const subject = "Studio Clyx — your booking & entry instructions";

  async function flag(reason: string) {
    await storage.createAgentDraft({
      conversationId: conversation.id,
      inboundMessageId: message.id,
      proposedSubject: subject,
      proposedBodyText: null,
      status: "pending",
      needsHuman: true,
      model: "booking",
      error: reason,
    });
    try {
      await sendAgentNovelQuestionAlert({
        guestName: conversation.guestName ?? null,
        question: summary,
        missing: reason,
        conversationId: conversation.id,
      });
    } catch (e) {
      console.error("[gmail-inbound] booking alert failed:", e);
    }
  }

  if (!info.studio) {
    console.log(`[gmail-inbound] booking with undetermined studio (${conversation.id}); flagged`);
    await flag("Couldn't determine which studio was booked — please send entry instructions manually.");
    return;
  }

  const tpl = selectInstruction(info.studio, info.startMinutes);
  if (!tpl.text) {
    console.log(`[gmail-inbound] no instruction template for ${conversation.id}: ${tpl.reason}`);
    await flag(tpl.reason ?? "No matching entry instructions are configured.");
    return;
  }

  // For events, append the building-security / closing-up note.
  const finalText = info.isEvent ? tpl.text + EVENT_SECURITY_NOTE : tpl.text;

  const draft = await storage.createAgentDraft({
    conversationId: conversation.id,
    inboundMessageId: message.id,
    proposedSubject: subject,
    proposedBodyText: finalText,
    status: "pending",
    model: "booking",
  });

  if (agentAutoSendInstructions()) {
    const sent = await deliverReply({
      conversation,
      draftId: draft.id,
      subject,
      text: finalText,
      auto: true,
    });
    console.log(
      sent.ok
        ? `[gmail-inbound] auto-sent ${info.studio} entry instructions for ${conversation.id}${sent.simulated ? " (simulation)" : ""}`
        : `[gmail-inbound] auto-send instructions failed for ${conversation.id}: ${sent.error}`
    );
  } else {
    console.log(
      `[gmail-inbound] created ${info.studio} entry-instructions draft for ${conversation.id}`
    );
  }
}

// One poll cycle: connect, find unread Peerspace mail, ingest, mark read.
async function pollOnce(): Promise<number> {
  if (!gmailInboundConfigured()) return 0;
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER!,
      pass: process.env.GMAIL_APP_PASSWORD!,
    },
    logger: false,
  });

  let processed = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock(inboxFolder());
    try {
      const uids = await client.search(
        { seen: false, from: senderMatch() },
        { uid: true }
      );
      if (!uids || uids.length === 0) return 0;
      // Process only a bounded batch (oldest first) per cycle to keep memory
      // flat; the remainder is picked up on the next poll.
      const batch = uids.slice(0, maxPerPoll());
      if (uids.length > batch.length) {
        console.log(
          `[gmail-inbound] ${uids.length} unread Peerspace email(s) found; handling ${batch.length} this cycle, rest next poll`
        );
      }
      for (const uid of batch) {
        try {
          // Cheap envelope fetch first (no body) so we can filter out automated
          // Peerspace notifications without downloading/parsing/Claude-drafting.
          const head = await client.fetchOne(
            String(uid),
            { envelope: true },
            { uid: true }
          );
          const subject = (head && head.envelope?.subject) || "";
          if (!isActionableSubject(subject)) {
            console.log(
              `[gmail-inbound] skipping non-message email (subject: "${subject.slice(0, 80)}")`
            );
            // Mark read so it leaves the queue and doesn't block real messages.
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
            continue;
          }

          const msg = await client.fetchOne(
            String(uid),
            { source: true },
            { uid: true }
          );
          if (!msg || !msg.source) continue;
          await ingestRawEmail(msg.source);
          // Mark read only after successful ingest (dedupe by Message-ID
          // protects us if a later poll re-reads the same message).
          await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
          processed++;
        } catch (e) {
          console.error(`[gmail-inbound] failed to process uid ${uid}:`, e);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return processed;
}

let started = false;
let polling = false;

// Start the recurring poller. Safe to call once at boot; no-op if the agent is
// disabled or Gmail isn't configured.
export function startGmailInboundPoller(): void {
  if (started) return;
  if (!agentEnabled()) {
    console.log("[gmail-inbound] AGENT_ENABLED is not 'true'; poller disabled");
    return;
  }
  if (!gmailInboundConfigured()) {
    console.log(
      "[gmail-inbound] GMAIL_USER/GMAIL_APP_PASSWORD not set; poller disabled"
    );
    return;
  }
  started = true;

  const tick = async () => {
    if (polling) return; // never overlap polls
    polling = true;
    try {
      const n = await pollOnce();
      if (n > 0) {
        console.log(`[gmail-inbound] processed ${n} new Peerspace email(s)`);
      }
    } catch (e) {
      console.error("[gmail-inbound] poll error:", e);
    } finally {
      polling = false;
    }
  };

  console.log(
    `[gmail-inbound] poller started (every ${pollMs() / 1000}s, folder=${inboxFolder()}, from~="${senderMatch()}")`
  );
  setTimeout(tick, 5000); // first run shortly after boot
  setInterval(tick, pollMs());
}
