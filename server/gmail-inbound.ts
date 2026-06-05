import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { storage } from "./storage";
import { agentEnabled, generateDraftForConversation } from "./agent";

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
];

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

async function ingestRawEmail(source: Buffer): Promise<void> {
  const parsed = await simpleParser(source);
  const from = firstAddress(parsed.from);
  const to = firstAddress(parsed.to);
  const replyTo = firstAddress(parsed.replyTo);

  // Thread on the Peerspace Reply-To address; fall back to From.
  const threadToken = replyTo.address || from.address;
  if (!threadToken) {
    console.warn("[gmail-inbound] message had no resolvable thread token; skipping");
    return;
  }

  // Cap the stored body and DO NOT persist the HTML body. Peerspace HTML emails
  // can embed large base64 inline images (several MB); storing that and later
  // loading it via SQLite `.all()` is what OOM'd the process. We draft from the
  // plain-text body, which is small.
  const rawText = parsed.text || null;
  const bodyText =
    rawText && rawText.length > MAX_BODY_CHARS
      ? rawText.slice(0, MAX_BODY_CHARS) + "\n…[truncated]"
      : rawText;

  const { conversation, message, duplicate } = await storage.recordInboundEmail({
    threadToken,
    peerspaceReplyTo: replyTo.text || replyTo.address,
    guestName: from.name,
    guestEmail: findGuestEmailInBody(bodyText),
    subject: parsed.subject || null,
    fromAddress: from.text || from.address,
    toAddress: to.address,
    bodyText,
    bodyHtml: null, // never store HTML — see note above
    providerMessageId: parsed.messageId || null,
    rawJson: null,
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
