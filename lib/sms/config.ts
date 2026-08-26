// lib/sms/config.ts — environment configuration for the SMS-primary weekly pipeline.
//
// DRAFT (SMS pivot). Mirrors lib/email/config.ts exactly, for the same reason it exists there:
// one place that knows every SMS-related env var, so no other module reaches into process.env
// directly and no secret is ever returned to a caller that would print it. Nothing here logs.
//
// Env vars (mirror these into .env.example — NAMES ONLY, never values):
//   SMS_SENDING_ENABLED      — "true" to permit REAL sends and REAL inbound state changes;
//                              anything else forces dry-run. Default FALSE, deliberately.
//   TWILIO_ACCOUNT_SID       — Twilio account SID (not secret, but paired with the token).
//   TWILIO_AUTH_TOKEN        — Twilio auth token. SECRET. Used ONLY to verify the
//                              X-Twilio-Signature on inbound webhooks and to authenticate
//                              outbound API calls. Never returned to a render path.
//   TWILIO_MESSAGING_SERVICE_SID — the Messaging Service that owns the sending number(s).
//   SMS_SHORT_LINK_SECRET    — HMAC secret for weekly short-link tokens (lib/sms/short-link.ts).
//   SMS_PREFERENCES_SECRET   — HMAC secret for the no-login preferences token on sms_consent.
//   SMS_PHONE_HASH_SALT      — secret salt for sms_send_log.phone_hash. SEPARATE from the two
//                              secrets above on purpose: those mint links, this one anonymises
//                              an audit trail, and rotating a link secret must not silently
//                              orphan years of CASL records by changing every stored hash.
//   SMS_WEBHOOK_PUBLIC_URL   — the exact public URL Twilio was configured to call, used for
//                              signature verification. See the comment on webhookPublicUrl().

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * Whether REAL sending and REAL inbound state changes are permitted. Defaults to FALSE:
 * unless SMS_SENDING_ENABLED === 'true' the whole pipeline runs dry — payloads built and
 * inbound messages parsed, nothing dispatched and no consent row mutated. An SMS mistake is
 * worse than an email one (it costs the recipient's attention immediately, it cannot be
 * filtered into a folder, and under CASL an unwanted commercial text is the violation), so
 * going live is a deliberate one-line env flip in exactly one place.
 */
export function smsSendingEnabled(): boolean {
  return env('SMS_SENDING_ENABLED') === 'true';
}

/** Twilio account SID, or null if unconfigured. */
export function twilioAccountSid(): string | null {
  return env('TWILIO_ACCOUNT_SID') ?? null;
}

/**
 * Twilio auth token, or null if unconfigured. SECRET — the only legitimate callers are the
 * inbound-webhook signature verifier and the outbound REST client. Never render it, never log
 * it, never put it in an error message.
 */
export function twilioAuthToken(): string | null {
  return env('TWILIO_AUTH_TOKEN') ?? null;
}

/** Messaging Service SID that owns the sending number(s), or null if unconfigured. */
export function twilioMessagingServiceSid(): string | null {
  return env('TWILIO_MESSAGING_SERVICE_SID') ?? null;
}

/** HMAC secret for short-link tokens, or null if unconfigured. */
export function shortLinkSecret(): string | null {
  return env('SMS_SHORT_LINK_SECRET') ?? null;
}

/** HMAC secret for the no-login preferences token, or null if unconfigured. */
export function preferencesSecret(): string | null {
  return env('SMS_PREFERENCES_SECRET') ?? null;
}

/** Secret salt for sms_send_log.phone_hash, or null if unconfigured. */
export function phoneHashSalt(): string | null {
  return env('SMS_PHONE_HASH_SALT') ?? null;
}

/**
 * The exact absolute URL Twilio was configured to POST to.
 *
 * Twilio's signature is computed over the FULL URL of the request as Twilio sent it. Behind a
 * proxy or a platform edge (Vercel), the URL the handler observes can differ from that in ways
 * that silently break verification — http vs https after TLS termination, an internal host
 * header, an added or dropped trailing slash. Reconstructing it from request headers means
 * trusting attacker-influenced headers to build the very string an authentication check runs
 * over, which is backwards. So the expected URL is CONFIGURED, not inferred, and it must match
 * the Twilio console value character for character.
 *
 * Returns null if unset — the webhook then refuses to verify rather than guessing.
 */
export function webhookPublicUrl(): string | null {
  return env('SMS_WEBHOOK_PUBLIC_URL') ?? null;
}
