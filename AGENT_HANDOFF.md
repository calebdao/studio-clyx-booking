# Studio Clyx — Peerspace email-reply agent

This document covers the Peerspace email-reply agent added on 2026-06-04. It
explains the flow, every file touched, the external accounts/DNS you need to set
up (and in what order), the new env vars, the database schema, and how to verify
it — first without secrets (simulation), then live.

## What it does

1. A Peerspace notification email (a guest message) arrives at the Gmail account
   linked to Peerspace, **calebandgladys@gmail.com**. A Gmail **auto-forward
   filter** forwards it to the **Resend Inbound** address on `studioclyx.com`,
   which POSTs the parsed message to `POST /api/agent/inbound-email`. (Gmail
   auto-forwarding preserves the original `From` and `Reply-To` headers, so the
   Peerspace thread token survives the hop. Use a filter-based auto-forward — not
   manual "Forward" clicks, which wrap the original and break the headers.)
2. The server verifies the webhook signature, groups the message into a
   **conversation** keyed by the Peerspace unique **Reply-To** address (the
   thread token), and stores the inbound message.
3. **Claude** (via `server/agent.ts`) drafts a reply using the markdown
   knowledge base at `docs/agent-knowledge.md` + the full thread history + any
   matched booking context. The draft is saved as `pending`.
4. The operator opens the **Inbox** tab in `/#/admin`, reviews the thread, and
   **approves / edits / rejects** the draft.
5. On approve, the server emails the reply **to** the Peerspace Reply-To address
   **from calebandgladys@gmail.com via Gmail SMTP** (`server/gmail.ts`,
   nodemailer), and records the outbound message in the thread. The draft flips
   to `sent`. We send from the Gmail (not Resend/info@studioclyx.com) so
   Peerspace recognizes the host and threads the reply correctly.

Nothing is ever sent automatically — a human approves every reply.

## Architecture decisions

- **Direct `fetch` for Claude + Resend.** Both are called via the global `fetch`,
  matching the existing Resend/Google integrations. The only new npm dependency
  is `nodemailer` (for Gmail SMTP) — it was already in the `script/build.ts`
  allowlist, so no build change was needed.
- **Replies sent via Gmail, not Resend.** Peerspace links to a Gmail account, so
  replies must originate from it. Resend can only send from our verified
  studioclyx.com domain, which Peerspace wouldn't recognize — so outbound goes
  through Gmail SMTP (`server/gmail.ts`). Inbound still uses Resend Inbound.
- **Provider-agnostic inbound.** All inbound parsing + signature verification is
  isolated in `server/agent-inbound.ts`. Swapping Resend Inbound for Cloudflare
  Email Workers / Postmark / Mailgun later only touches that file.
- **Knowledge base is data, not code.** Edit `docs/agent-knowledge.md` to change
  how the agent answers — no redeploy of logic needed (the file is re-read when
  its mtime changes). It must be deployed alongside the server (it is committed
  in the repo and read from `process.cwd()/docs/agent-knowledge.md`).
- **Kill switch.** Draft generation only runs when `AGENT_ENABLED=true`.

## External setup — do this in order

1. **Anthropic Console** → create an API key → `ANTHROPIC_API_KEY`.
2. **Resend Inbound** → confirm Inbound is available on your Resend plan. Create
   an inbound endpoint pointing at
   `https://studio-clyx-booking.onrender.com/api/agent/inbound-email`, and copy
   the webhook **signing secret** (`whsec_…`) into `AGENT_INBOUND_SIGNING_SECRET`.
   - If Inbound is **not** on your plan, fall back to Cloudflare Email Workers
     (only `server/agent-inbound.ts` changes; the rest is unchanged).
3. **DNS (studioclyx.com)** → add the MX record(s) Resend Inbound requires for
   the receiving address. studioclyx.com DNS stays where it is (Squarespace); you
   just add records.
4. **Gmail (calebandgladys@gmail.com) — inbound** → create a filter that
   **auto-forwards** Peerspace notification emails to the Resend Inbound address.
   Gmail makes you verify the forwarding address first (it sends a confirmation
   code there). Use a filter/auto-forward, not manual forwards.
5. **Gmail (calebandgladys@gmail.com) — outbound** → turn on 2-Step Verification,
   then create an **App Password** (Google Account → Security → App passwords).
   Put the Gmail address in `GMAIL_USER` and the 16-char app password in
   `GMAIL_APP_PASSWORD`. This is what lets the app send replies as the host.
6. **Render** → set the env vars below, then Manual Deploy → Deploy latest commit
   (a restart alone doesn't reliably pick up new env values).

## Env vars (Render)

```
AGENT_ENABLED=true                                  # exact string "true" to enable
ANTHROPIC_API_KEY=sk-ant-…                          # Claude; unset → simulation drafts
AGENT_MODEL=claude-sonnet-4-6                        # optional, this is the default
AGENT_INBOUND_SIGNING_SECRET=whsec_…                # Resend Inbound (Svix); unset → unverified
GMAIL_USER=calebandgladys@gmail.com                 # Peerspace-linked Gmail; replies are sent from here
GMAIL_APP_PASSWORD=…                                # 16-char Gmail app password; unset → replies simulate
# AGENT_KNOWLEDGE_PATH=…                             # optional override of docs/agent-knowledge.md
```

`GET /api/integrations/status` now includes an `agent` block
`{ enabled, mode, model, credentialConfigured, knowledgeBaseFound }` and a
`gmail` block `{ mode: "live"|"simulation", userConfigured, passConfigured }`.

## Database schema (added)

Three tables, created idempotently on boot in `server/storage.ts`
(`CREATE TABLE IF NOT EXISTS`), safe against the live Render `data.db`:

- **`agent_conversations`** — one row per Peerspace thread. Keyed by
  `thread_token` (unique, the normalized Reply-To address). Holds `guest_name`,
  `guest_email` (often null — Peerspace masks it), matched `booking_id`,
  `subject`, `status` (open|closed).
- **`agent_messages`** — every inbound and outbound message in a thread.
  `direction`, addresses, subject, body, `provider_message_id` (for inbound
  dedupe / the Resend id on outbound).
- **`agent_drafts`** — Claude's proposed replies. `status`
  pending|approved|rejected|sent|error, `edited_body` (operator override),
  `model`, `resend_id`, `sent_at`, `error`.

## Files

### New
- `server/agent.ts` — Claude draft generation, knowledge-base loader, booking
  matching, prompt assembly, orchestration (`generateDraftForConversation`).
- `server/agent-inbound.ts` — Svix signature verification + provider-agnostic
  payload normalization (`verifyInboundSignature`, `parseInboundEmail`).
- `server/gmail.ts` — Gmail SMTP sender (nodemailer): `sendAgentReplyEmail`,
  `gmailStatus`. Simulation-aware (no-op + log when GMAIL_* unset).
- `docs/agent-knowledge.md` — the customer-facing knowledge base.
- `AGENT_HANDOFF.md` — this document.

### Modified
- `shared/schema.ts` — three new tables + DTO/zod schemas + the draft-action schema.
- `server/storage.ts` — table bootstrap + CRUD (`recordInboundEmail`,
  `addAgentMessage`, `createAgentDraft`, `getAgentDraft`, `updateAgentDraft`,
  `listAgentConversations`, `getAgentConversation`, `setConversationBooking`,
  `setConversationStatus`). Inbound dedupe is by `provider_message_id`.
- `server/routes.ts` — `POST /api/agent/inbound-email` (verify → parse → persist
  → background draft), `GET /api/admin/agent/conversations`,
  `POST /api/admin/agent/drafts/:id/action` (approve sends via Gmail | reject |
  edit), a small in-memory rate limiter for the inbound webhook, and `agent` +
  `gmail` blocks in `/api/integrations/status`.
- `package.json` — added `nodemailer` + `@types/nodemailer` (Gmail SMTP).
- `client/src/lib/booking-store.tsx` — `useAgentConversations`,
  `useAgentDraftActions`, and the `AgentConversation/AgentDraft/AgentMessage` types.
- `client/src/pages/admin.tsx` — the **Inbox** tab (thread view + editable draft
  + Approve/Edit/Reject).
- `claude.md`, `ENV_SETUP.md` — documented the new env vars and files.

## Verify without secrets (simulation QA)

With `AGENT_ENABLED=true` and **no** `ANTHROPIC_API_KEY` /
`AGENT_INBOUND_SIGNING_SECRET` / `GMAIL_APP_PASSWORD`:

1. `curl /api/integrations/status` → `agent.mode` is `"simulation"`,
   `agent.knowledgeBaseFound` is `true`, `gmail.mode` is `"simulation"`.
2. POST a fake inbound payload to `/api/agent/inbound-email` (it's accepted
   unverified in simulation), e.g.:
   ```bash
   curl -X POST localhost:5000/api/agent/inbound-email \
     -H 'content-type: application/json' \
     -d '{"data":{"from":"Jane Guest <reply+abc123@peerspace.com>",
          "to":"info@studioclyx.com","subject":"Is Studio 2 available Saturday?",
          "text":"Hi! What does Studio 2 cost for a 4-hour shoot?","message_id":"m1"}}'
   ```
3. Open `/#/admin` → **Inbox**: a conversation appears with a **simulated**
   pending draft. Edit it, then **Approve & send** → toast says "Reply sent
   (simulation)" (Gmail is also simulation, so it's logged, not emailed). The
   draft flips to `sent` and an outbound message is appended to the thread.
4. Re-POST the same payload (same `message_id`) → it's deduped (no second
   inbound message).

## Go live

1. Set `ANTHROPIC_API_KEY` → drafts become real Claude output.
2. Set `AGENT_INBOUND_SIGNING_SECRET` → unsigned/forged inbound posts get 401.
3. Set `GMAIL_USER` + `GMAIL_APP_PASSWORD` → approved replies actually email out
   from calebandgladys@gmail.com (`gmail.mode` reads `"live"`).
4. Send yourself a real Peerspace message; confirm it auto-forwards in, lands in
   the Inbox, the draft reads well, and an approved reply shows up back in the
   Peerspace thread **attributed to the host** (this is the real test that Gmail
   sending — vs. Resend — was the right call).

## Known follow-ups (not blockers)

1. **Booking match precision.** Peerspace masks guest emails, so matching falls
   back to name + recency. Refine if you see mis-links (`matchBookingForConversation`).
2. **Reply-To extraction.** `parseInboundEmail` keys on the Reply-To/From
   address. Once you see real Peerspace headers, tighten the token extraction if
   their format differs from the assumed `local+token@…` shape.
3. **Auto-close threads.** Conversations stay `open`; add an admin "close" action
   if the Inbox gets noisy (`setConversationStatus` already exists).
4. **Per-IP rate limiting.** The inbound limiter is a single global window; swap
   for `express-rate-limit` keyed by IP if volume grows.
