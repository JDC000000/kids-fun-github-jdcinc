// lib/sms/config.ts — environment configuration for the SMS-primary weekly pipeline.
//
// DRAFT (SMS pivot). Mirrors lib/email/config.ts exactly, for the same reason it exists there:
// one place that knows every SMS-related env var, so no other module reaches into process.env
// directly and no secret is ever returned to a caller that would print it. Nothing here logs.
//
// Env vars (mirror these into .env.example — NAMES ONLY, never values):
//   SMS_SENDING_ENABLED      — "true" to permit REAL sends and REAL inbound state changes;
//                              anything else forces dry-run. Default FALSE, deliberately.
//   SMS_SIGNUP_ENABLED       — "true" to expose the public signup form and its API route at all.
//                              Default FALSE. Separate from SMS_SENDING_ENABLED on purpose —
//                              see smsSignupEnabled().
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
//   SMS_CRON_SECRET          — shared secret guarding POST /api/sms/weekly/run.
//   NEXT_PUBLIC_SITE_URL     — public app base URL, for the links inside a text. Shared,
//                              app-level var; see siteUrl() for why this is a second reader.

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

/**
 * Whether the public signup form and POST /api/sms/signup exist at all.
 *
 * Defaults to FALSE. PRD §2.1: "Form stays behind a feature flag until the sign-off gate is
 * recorded" — that gate being Jon confirming the privacy-policy changelog entry and the CASL
 * sender-identification footer (§1.3, §1.4). Until then this form must not be reachable by real
 * traffic, because a live form collecting a child's age under unreviewed consent copy is exactly
 * the failure the gate exists to prevent. The route 404s and the page renders a notice.
 *
 * A SEPARATE FLAG FROM smsSendingEnabled(), deliberately, because they answer different
 * questions and the useful states are not the same. Staging wants SIGNUP on and SENDING off:
 * the form renders and validates for real, a screenshot can be taken for the Toll-Free
 * Verification submission, and not one text is dispatched and not one consent row is written.
 * One combined flag could not express that, and the alternative — turning on real sending to
 * take a screenshot — is not a thing anyone should have to do.
 */
export function smsSignupEnabled(): boolean {
  return env('SMS_SIGNUP_ENABLED') === 'true';
}

/**
 * The shared secret guarding POST /api/sms/weekly/run, or null if unconfigured.
 *
 * Unconfigured means the route 503s — fail closed, never open. Mirrors
 * lib/email/config.ts's cronSecret() exactly, and is a SEPARATE secret from the email job's:
 * rotating one must not silently disarm the other, and a scheduler credential that triggers
 * real text messages is not the same blast radius as one that triggers emails.
 */
export function smsCronSecret(): string | null {
  return env('SMS_CRON_SECRET') ?? null;
}

/**
 * The public site base URL, without a trailing slash.
 *
 * A SECOND READER OF A SHARED VAR, NOT A SECOND SOURCE OF TRUTH — stated because the repo
 * otherwise argues hard against duplication. lib/email/config.ts reads the same
 * NEXT_PUBLIC_SITE_URL, and that is fine: this is an app-level environment value with a
 * three-line reader, not a RULE that two copies could drift apart on (a postal regex, a
 * threshold, a region allowlist — those are the things that must have one home). The
 * alternative was importing `appUrl` from the EMAIL lane into the SMS pipeline, which would
 * make this module's dependency graph read as though the two features were coupled.
 *   If you would rather it were shared, the right shape is a lib/config/app-url.ts both lanes
 *   import — a small refactor that touches the email lane, which this branch deliberately does
 *   not.
 */
export function siteUrl(): string {
  return (env('NEXT_PUBLIC_SITE_URL') ?? 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * The per-item short link for a weekly pick: `{site}/s/{token}` (PRD §2.3).
 *
 * The token comes from lib/sms/short-link.ts and is per (occurrence, subscriber), which is what
 * makes a click attributable to one person rather than to an activity in aggregate.
 */
export function shortLinkUrl(token: string): string {
  return `${siteUrl()}/s/${token}`;
}

/**
 * The subscriber's own no-login preferences/hub page: `{site}/u/{preferencesToken}` (PRD §2.4).
 *
 * This link is in EVERY message, and it is not decoration — it is the CASL unsubscribe path and
 * the PIPEDA access/correction mechanism at the same time. A message that renders without it is
 * a message that must not be sent.
 */
export function preferencesUrl(preferencesToken: string): string {
  return `${siteUrl()}/u/${preferencesToken}`;
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
