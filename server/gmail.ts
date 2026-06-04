import nodemailer, { type Transporter } from "nodemailer";

// ---------------------------------------------------------------------------
// Gmail SMTP sender for the Peerspace email-reply agent.
//
// Replies must originate from the Gmail account linked to Peerspace
// (calebandgladys@gmail.com) so Peerspace attributes them to the host and
// threads them correctly — Resend can only send from our verified studioclyx.com
// domain, which Peerspace would not recognize. We send via Gmail SMTP using an
// app password (requires 2-Step Verification on that Gmail account).
//
// Env:
//   GMAIL_USER          the linked Gmail address (calebandgladys@gmail.com)
//   GMAIL_APP_PASSWORD  a 16-char Gmail app password (NOT the login password)
//
// Without both, we run in simulation mode (log + no-op), mirroring how the
// Resend/Stripe/Claude integrations degrade elsewhere in this codebase.
// ---------------------------------------------------------------------------

export function gmailConfigured(): boolean {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

export function gmailStatus() {
  return {
    name: "Gmail (agent replies)",
    mode: gmailConfigured() ? ("live" as const) : ("simulation" as const),
    userEnv: "GMAIL_USER",
    userConfigured: Boolean(process.env.GMAIL_USER),
    passEnv: "GMAIL_APP_PASSWORD",
    passConfigured: Boolean(process.env.GMAIL_APP_PASSWORD),
  };
}

let transporter: Transporter | null = null;
function getTransport(): Transporter {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  return transporter;
}

// Escape plain text -> minimal HTML, preserving line breaks.
function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #1a1a1a; white-space: pre-wrap;">${escaped}</div>`;
}

type SendResult =
  | { ok: true; mode: "simulation"; reason: string }
  | { ok: true; mode: "live"; providerId: string | null }
  | { ok: false; mode: "live"; error: string };

// Send an operator-approved agent reply back into a Peerspace thread. `to` is
// the unique Peerspace Reply-To address; the message is sent from GMAIL_USER.
export async function sendAgentReplyEmail(args: {
  to: string;
  subject: string;
  text: string;
  conversationId: string;
}): Promise<SendResult> {
  if (!gmailConfigured()) {
    const reason = !process.env.GMAIL_USER
      ? "GMAIL_USER missing"
      : "GMAIL_APP_PASSWORD missing";
    console.log(
      `[gmail] simulation (${reason}): would send agent reply for ${args.conversationId} to ${args.to}`
    );
    return { ok: true, mode: "simulation", reason };
  }
  try {
    const info = await getTransport().sendMail({
      from: process.env.GMAIL_USER!,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: plainTextToHtml(args.text),
    });
    console.log(
      `[gmail] sent agent reply for ${args.conversationId} (messageId=${info.messageId ?? "?"})`
    );
    return { ok: true, mode: "live", providerId: info.messageId ?? null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(
      `[gmail] agent reply send failed for ${args.conversationId}:`,
      error
    );
    return { ok: false, mode: "live", error };
  }
}
