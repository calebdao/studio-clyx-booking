import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Inbound email verification + parsing for the Peerspace email-reply agent.
//
// We keep this provider-agnostic on purpose. Today the inbound provider is
// Resend Inbound, which signs webhooks with the Svix scheme (the same scheme
// Resend uses for all its webhooks). If we ever swap to Cloudflare Email
// Workers / Postmark / Mailgun, only this file needs to change — the route,
// storage, and Claude layers consume the normalized shape below.
// ---------------------------------------------------------------------------

export interface NormalizedInboundEmail {
  fromAddress: string | null;
  fromName: string | null;
  toAddress: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  replyTo: string | null; // full Reply-To header value (Peerspace thread address)
  threadToken: string | null; // normalized address used to key the conversation
  guestEmail: string | null; // best-effort un-masked guest email (often null)
  providerMessageId: string | null;
}

// ----- Signature verification (Svix / Resend) -----

type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export interface VerifyResult {
  ok: boolean;
  simulated?: boolean;
  error?: string;
}

// Verify a Svix-signed webhook (Resend Inbound). Returns { ok: true } on a
// valid signature. When AGENT_INBOUND_SIGNING_SECRET is unset we fall back to
// simulation mode (accept + warn) so local dev works without a secret, mirroring
// how the Resend/Stripe integrations degrade elsewhere in this codebase.
export function verifyInboundSignature(args: {
  rawBody: Buffer | string | undefined;
  headers: HeaderBag;
}): VerifyResult {
  const secret = process.env.AGENT_INBOUND_SIGNING_SECRET;
  if (!secret) {
    console.warn(
      "[agent] AGENT_INBOUND_SIGNING_SECRET not set — accepting inbound email UNVERIFIED (simulation mode)"
    );
    return { ok: true, simulated: true };
  }
  const { rawBody, headers } = args;
  if (!rawBody) return { ok: false, error: "missing raw body" };
  const payload =
    typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");

  // Support both the Svix-prefixed and the unprefixed webhook-standard headers.
  const id = header(headers, "svix-id") ?? header(headers, "webhook-id");
  const timestamp =
    header(headers, "svix-timestamp") ?? header(headers, "webhook-timestamp");
  const signatureHeader =
    header(headers, "svix-signature") ?? header(headers, "webhook-signature");
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, error: "missing svix signature headers" };
  }

  // Optional replay guard: reject timestamps more than 5 minutes out.
  const tsSeconds = Number(timestamp);
  if (Number.isFinite(tsSeconds)) {
    const skew = Math.abs(Date.now() / 1000 - tsSeconds);
    if (skew > 5 * 60) {
      return { ok: false, error: "timestamp outside tolerance" };
    }
  }

  // The secret is `whsec_<base64>`; the bytes after the prefix are the key.
  const secretKey = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes: Buffer;
  try {
    keyBytes = Buffer.from(secretKey, "base64");
  } catch {
    return { ok: false, error: "invalid signing secret" };
  }

  const signedContent = `${id}.${timestamp}.${payload}`;
  const expected = crypto
    .createHmac("sha256", keyBytes)
    .update(signedContent)
    .digest("base64");

  // The header is a space-delimited list of `v1,<sig>` pairs.
  const presented = signatureHeader
    .split(" ")
    .map((part) => (part.includes(",") ? part.split(",")[1] : part));
  const expectedBuf = Buffer.from(expected);
  const match = presented.some((sig) => {
    const sigBuf = Buffer.from(sig);
    return (
      sigBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(sigBuf, expectedBuf)
    );
  });
  return match ? { ok: true } : { ok: false, error: "signature mismatch" };
}

// ----- Payload parsing -----

// Pull "Name <addr@x>" / "addr@x" / { address, name } / arrays into parts.
function parseAddress(input: unknown): { address: string | null; name: string | null } {
  if (!input) return { address: null, name: null };
  if (Array.isArray(input)) return parseAddress(input[0]);
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    const address =
      (typeof o.address === "string" && o.address) ||
      (typeof o.email === "string" && o.email) ||
      null;
    const name = typeof o.name === "string" ? o.name : null;
    return { address: address ? address.trim() : null, name };
  }
  const s = String(input).trim();
  const angle = s.match(/^(.*?)<([^>]+)>\s*$/);
  if (angle) {
    const name = angle[1].replace(/^"|"$/g, "").trim();
    return { address: angle[2].trim().toLowerCase(), name: name || null };
  }
  return { address: s.toLowerCase(), name: null };
}

// Normalize a headers array ([{name,value}]) or object into a lowercase map.
function normalizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const h of raw) {
      if (h && typeof h === "object") {
        const o = h as Record<string, unknown>;
        const name = typeof o.name === "string" ? o.name.toLowerCase() : null;
        const value = typeof o.value === "string" ? o.value : null;
        if (name && value) out[name] = value;
      }
    }
  } else if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k.toLowerCase()] = v;
    }
  }
  return out;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

// Best-effort: find a non-Peerspace email address in the body. Peerspace
// usually masks the guest's real email, so this frequently returns null — the
// downstream booking match must degrade gracefully when it does.
function findGuestEmailInBody(text: string | null): string | null {
  if (!text) return null;
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  if (!matches) return null;
  const candidate = matches.find(
    (m) => !/peerspace\.com$/i.test(m) && !/studioclyx\.com$/i.test(m)
  );
  return candidate ? candidate.toLowerCase() : null;
}

export function parseInboundEmail(payload: unknown): NormalizedInboundEmail {
  const root =
    payload && typeof payload === "object" && "data" in (payload as object)
      ? ((payload as Record<string, unknown>).data as Record<string, unknown>)
      : (payload as Record<string, unknown>) ?? {};

  const headers = normalizeHeaders(root.headers);

  const from = parseAddress(root.from ?? headers["from"]);
  const to = parseAddress(root.to ?? root.recipient ?? headers["to"]);

  // Reply-To is the Peerspace unique thread address. Check the parsed field
  // first, then the raw header, then fall back to From.
  const replyToRaw = firstString(
    Array.isArray(root.reply_to) ? root.reply_to[0] : root.reply_to,
    Array.isArray((root as Record<string, unknown>).replyTo)
      ? ((root as Record<string, unknown>).replyTo as unknown[])[0]
      : (root as Record<string, unknown>).replyTo,
    headers["reply-to"]
  );
  const replyToParsed = parseAddress(replyToRaw);
  const threadToken = replyToParsed.address ?? from.address;

  const bodyText = firstString(root.text, root.plain, (root as Record<string, unknown>)["body-plain"]);
  const bodyHtml = firstString(root.html, (root as Record<string, unknown>)["body-html"]);

  const providerMessageId = firstString(
    root.message_id,
    (root as Record<string, unknown>).messageId,
    root.email_id,
    root.id,
    headers["message-id"],
    (payload as Record<string, unknown>)?.id
  );

  return {
    fromAddress: from.address,
    fromName: from.name,
    toAddress: to.address,
    subject: firstString(root.subject, headers["subject"]),
    bodyText,
    bodyHtml,
    replyTo: replyToRaw ?? null,
    threadToken: threadToken ? threadToken.toLowerCase() : null,
    guestEmail: findGuestEmailInBody(bodyText),
    providerMessageId,
  };
}
