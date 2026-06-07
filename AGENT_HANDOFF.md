# Studio Clyx — Peerspace email-reply agent

This document covers the Peerspace email-reply agent added on 2026-06-04. It
explains the flow, every file touched, the external accounts you need to set up
(and in what order), the env vars, the database schema, and how to verify it.

## What it does

1. A Peerspace notification email (a guest message) lands in the Gmail account
   linked to Peerspace, **calebandgladys@gmail.com**. The app **reads it
   directly from that inbox over IMAP** — a poller (`server/gmail-inbound.ts`)
   checks every ~60s for unread mail whose `From` matches Peerspace.
2. The poller parses the message, groups it into a **conversation** keyed by the
   Peerspace unique **Reply-To** address (the thread token), stores the inbound
   message, and marks it read. Dedupe is by the email `Message-ID`.
3. **Claude** (via `server/agent.ts`) drafts a reply using the markdown
   knowledge base at `docs/agent-knowledge.md` + the full thread history + any
   matched booking context. The draft is saved as `pending`.
4. The operator opens the **Inbox** tab in `/#/admin`, reviews the thread, and
   **approves / edits / rejects** the draft.
5. On approve, the server emails the reply **to** the Peerspace Reply-To address
   **from calebandgladys@gmail.com via Gmail SMTP** (`server/gmail.ts`), and
   records the outbound message in the thread. The draft flips to `sent`.

Both halves (read + send) use the **one** Gmail account and its app password;
there is no inbound email service, no extra domain, and no per-message cost.

## Booking access instructions

Confirmed-booking emails (body has "Booking details" + "View booking"/"Payout")
are handled deterministically, NOT by the LLM:

- `server/booking-instructions.ts` detects the studio (Roman numeral "STUDIO CLYX
  I/II/III" → address/unit → listing name) and the booking start time, then picks
  the exact template. Studio 1 & 2 have a 9am–3pm ("day") and after-hours variant
  (by start time, NY); Studio 3 & Lincoln have one each.
- Templates contain **door/lockbox codes**, so they're stored **only in the DB**
  (`app_settings` key `booking_instructions`), edited via the admin **Access
  Instructions** tab — never committed (the repo is public).
- The chosen template is sent verbatim through `deliverReply` (auto when
  `AGENT_AUTO_SEND_INSTRUCTIONS` — or the global `AGENT_AUTO_SEND` — is on, else a
  draft). Instructions auto-send is independent of Q&A auto-send, so you can
  auto-send instructions while keeping AI replies in draft. If the
  studio/time/template can't be resolved, it's flagged `needsHuman` + emailed —
  never a wrong/blank code.
- For events / after-hours bookings, the building-security closing-up note is
  appended (see `EVENT_SECURITY_NOTE` / `looksLikeEvent`).

## Confidence, auto-send, and learning

Claude must answer **only** from the knowledge base and returns a structured
`{confident, reply, missing}` JSON (parsed leniently; anything unparseable or
without a real reply is treated as **not** confident — the safe default).

- **Not confident / novel question** → a draft is flagged `needsHuman` (amber
  "needs you" in the Inbox), **nothing is sent**, and the operator gets an email
  alert (`sendAgentNovelQuestionAlert` → `OWNER_ALERT_EMAILS`). The operator
  writes the answer in the Inbox.
- **Confident** → a normal pending draft. If `AGENT_AUTO_SEND=true` **and** the
  reply doesn't contain an escalation phrase ("a team member will follow up",
  etc.), it's **auto-sent** via the shared `deliverReply()`; otherwise it waits
  for manual approval.
- **Learning** → approving a draft with the "Add to knowledge base" toggle
  (`teach`, default **on** for novel questions) appends the guest's question +
  the sent reply under a "## Learned answers" section of the editable knowledge
  base (`appendLearnedAnswer`), so similar questions can be answered (and
  auto-sent) next time.

So with auto-send on, the bot answers what it knows and **escalates what it
doesn't**, and your manual answers teach it for next time.

## Architecture decisions

- **One Gmail for everything.** Peerspace is linked to a Gmail, so the agent both
  reads inbound mail from it (IMAP, `server/gmail-inbound.ts`) and sends replies
  from it (SMTP, `server/gmail.ts`). Sending from the host's own Gmail is what
  makes Peerspace recognize the reply and thread it correctly — Resend can only
  send from our verified studioclyx.com domain, which Peerspace wouldn't accept.
- **Poll, don't webhook.** Reading the inbox on a timer needs no public endpoint,
  no DNS/MX changes, and no paid inbound service. It relies on the Render service
  staying awake (we're on the paid tier, so it does). Latency is one poll cycle
  (~60s), which is fine for a review-first drafting bot.
- **Sender-scoped.** The poller only touches mail whose `From` contains
  `PEERSPACE_SENDER_MATCH` (default `peerspace.com`), so it never reads the
  account's other email.
- **Direct `fetch` for Claude.** Claude is called via the global `fetch` (no SDK),
  matching the existing Resend/Google integrations. New npm deps: `nodemailer`
  (SMTP), `imapflow` (IMAP), `mailparser` (MIME parsing).
- **Knowledge base is data, not code.** The committed `docs/agent-knowledge.md`
  is the default, but the operator can edit it in the browser (admin **Knowledge**
  tab) — that version is saved in the DB (`app_settings`, key `agent_knowledge`)
  and **wins over the file**, taking effect on the next message with no redeploy.
  "Revert to default" discards the DB copy and falls back to the file. See
  `getEffectiveKnowledge()` in `server/agent.ts` and the
  `/api/admin/agent/knowledge` GET/PUT/DELETE routes.
- **Kill switch.** Both the poller and draft generation only run when
  `AGENT_ENABLED=true`.

## External setup — do this in order

1. **Anthropic Console** (https://console.anthropic.com) → add billing/credit,
   optionally set a monthly spend limit, then create an API key →
   `ANTHROPIC_API_KEY`.
2. **Gmail (calebandgladys@gmail.com)** →
   a. Turn on **2-Step Verification** (required for app passwords).
   b. Create an **App Password** (Google Account → Security → App passwords) —
      a 16-char password. This single password is used for both IMAP and SMTP.
   c. Make sure **IMAP is enabled** (Gmail → Settings → Forwarding and POP/IMAP →
      Enable IMAP).
   d. *(Recommended)* Create a Gmail **filter** that labels Peerspace mail (e.g.
      label `Peerspace`) so it's easy to see what the bot is reading. Optional —
      the sender match works on the plain INBOX too.
   Put the address in `GMAIL_USER` and the app password in `GMAIL_APP_PASSWORD`.
3. **Render** → set the env vars below, then Manual Deploy → Deploy latest commit
   (a restart alone doesn't reliably pick up new env values).

No DNS, no MX records, no Resend inbound, no second domain. (Resend stays exactly
as it is for the existing booking emails.)

## Env vars (Render)

```
AGENT_ENABLED=true                       # exact string "true" to enable
ANTHROPIC_API_KEY=sk-ant-…               # Claude; unset → simulation drafts
AGENT_MODEL=claude-sonnet-4-6            # optional, this is the default
AGENT_AUTO_SEND=false                    # "true" → auto-send confident Q&A replies (see below)
AGENT_AUTO_SEND_INSTRUCTIONS=true        # "true" → auto-send booking entry instructions (independent of Q&A)
GMAIL_USER=calebandgladys@gmail.com      # reads inbound (IMAP) + sends replies (SMTP)
GMAIL_APP_PASSWORD=…                      # 16-char Gmail app password; unset → poller off + replies simulate
# Optional poller tuning:
# PEERSPACE_SENDER_MATCH=peerspace.com   # From-header substring that flags Peerspace mail
# AGENT_INBOX_FOLDER=INBOX               # mailbox/label to read
# AGENT_POLL_SECONDS=60                  # poll interval (min 30)
# AGENT_MAX_PER_POLL=5                   # max emails per poll (bounds memory; backlog drains over polls)
# PEERSPACE_IGNORE_SUBJECTS=…            # comma-separated subjects to skip (Peerspace notifications); overrides default list
# PEERSPACE_MESSAGE_SUBJECTS=…           # stricter allowlist: only draft for subjects containing one of these
# AGENT_KNOWLEDGE_PATH=…                 # override docs/agent-knowledge.md path
```

`GET /api/integrations/status` includes:
- `agent`: `{ enabled, mode, model, credentialConfigured, knowledgeBaseFound }`
- `gmail` (send): `{ mode, userConfigured, passConfigured }`
- `gmailInbound` (read): `{ mode, agentEnabled, folder, senderMatch, pollSeconds }`

## Database schema (added)

Three tables, created idempotently on boot in `server/storage.ts`
(`CREATE TABLE IF NOT EXISTS`), safe against the live Render `data.db`:

- **`agent_conversations`** — one row per Peerspace thread. Keyed by
  `thread_token` (unique, the normalized Reply-To address). Holds `guest_name`,
  `guest_email` (often null — Peerspace masks it), matched `booking_id`,
  `subject`, `status` (open|closed).
- **`agent_messages`** — every inbound and outbound message in a thread.
  `direction`, addresses, subject, body, `provider_message_id` (the email
  Message-ID for inbound dedupe; the SMTP message id on outbound).
- **`agent_drafts`** — Claude's proposed replies. `status`
  pending|approved|rejected|sent|error, `edited_body` (operator override),
  `model`, `resend_id` (holds the SMTP message id), `sent_at`, `error`.

## Files

### New
- `server/agent.ts` — Claude draft generation, knowledge-base loader, booking
  matching, prompt assembly, orchestration (`generateDraftForConversation`).
- `server/gmail-inbound.ts` — Gmail IMAP poller (`imapflow` + `mailparser`):
  reads unread Peerspace mail, parses it, feeds `storage.recordInboundEmail` +
  the draft pipeline, marks read. `startGmailInboundPoller`, `gmailInboundStatus`.
- `server/gmail.ts` — Gmail SMTP sender (`nodemailer`): `sendAgentReplyEmail`,
  `gmailStatus`. Simulation-aware (no-op + log when GMAIL_* unset).
- `docs/agent-knowledge.md` — the customer-facing knowledge base.
- `AGENT_HANDOFF.md` — this document.

### Modified
- `shared/schema.ts` — three new tables + DTO/zod schemas + the draft-action schema.
- `server/storage.ts` — table bootstrap + CRUD (`recordInboundEmail`,
  `addAgentMessage`, `createAgentDraft`, `getAgentDraft`, `updateAgentDraft`,
  `listAgentConversations`, `getAgentConversation`, `setConversationBooking`,
  `setConversationStatus`). Inbound dedupe is by `provider_message_id`.
- `server/routes.ts` — starts the Gmail poller (`startGmailInboundPoller`),
  `GET /api/admin/agent/conversations`, `POST /api/admin/agent/drafts/:id/action`
  (approve sends via Gmail | reject | edit), and `agent`/`gmail`/`gmailInbound`
  blocks in `/api/integrations/status`.
- `package.json` — added `nodemailer`, `imapflow`, `mailparser` (+ `@types/*`).
- `client/src/lib/booking-store.tsx` — `useAgentConversations`,
  `useAgentDraftActions`, and the `AgentConversation/AgentDraft/AgentMessage` types.
- `client/src/pages/admin.tsx` — the **Inbox** tab (thread view + editable draft
  + Approve/Edit/Reject).
- `claude.md`, `ENV_SETUP.md`, `.env.example` — env vars + files.

## Verify

**Without secrets (simulation):** with `AGENT_ENABLED=true` and no
`ANTHROPIC_API_KEY` / `GMAIL_APP_PASSWORD`, `GET /api/integrations/status` shows
`agent.mode` and `gmailInbound.mode`/`gmail.mode` all `"simulation"`, and
`agent.knowledgeBaseFound: true`. The poller stays off (no Gmail creds). The
admin Inbox renders empty. (There's no inbound HTTP endpoint to curl now —
ingestion only happens through the Gmail poller.)

**Live:**
1. Set `ANTHROPIC_API_KEY` → drafts become real Claude output.
2. Set `GMAIL_USER` + `GMAIL_APP_PASSWORD` (IMAP enabled, app password valid) →
   `gmailInbound.mode` and `gmail.mode` read `"live"`; the boot log shows
   `[gmail-inbound] poller started`.
3. Send a real Peerspace message. Within a poll cycle it should appear in the
   admin **Inbox** with a pending draft. Approve it and confirm the reply shows
   up back in the Peerspace thread **attributed to the host** (the real test that
   Gmail sending was the right call).
4. Watch Render logs for `[gmail-inbound] processed N new Peerspace email(s)`.

## Known follow-ups (not blockers)

1. **Booking match precision.** Peerspace masks guest emails, so matching falls
   back to name + recency. Refine if you see mis-links (`matchBookingForConversation`).
2. **Thread grouping.** Conversations are keyed by a composite identity (guest
   name + listing + requested date/time) so all emails of one Peerspace inquiry
   group into one chatbox and the bot sees the full history; the reply address is
   stored separately (`peerspaceReplyTo`, latest wins) for sending. Falls back to
   the reply address when inquiry details aren't parseable. See
   `computeThreadKey()` in `server/gmail-inbound.ts`.
3. **Sender match.** `PEERSPACE_SENDER_MATCH` defaults to `peerspace.com`. If
   Peerspace sends from a different domain, set it accordingly (or point
   `AGENT_INBOX_FOLDER` at a dedicated Gmail label populated by a filter).
4. **Auto-close threads.** Conversations stay `open`; add an admin "close" action
   if the Inbox gets noisy (`setConversationStatus` already exists).
5. **Persistent IMAP / IDLE.** The poller connects per cycle. If you want
   near-instant pickup, switch to a long-lived IMAP connection with IDLE.
