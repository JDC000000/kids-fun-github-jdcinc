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
//   SMS_STATUS_CALLBACK_URL  — the exact public URL sent to Twilio as `StatusCallback` on every
//                              outbound message, AND verified against on the delivery-status
//                              webhook. ONE value for both ends by construction — see
//                              `statusCallbackUrl`. Unset means no delivery receipts are
//                              requested; sends still work.
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
 * STAGING ONLY: may the inbound webhook return its TwiML reply BODY while sending is disabled?
 *
 * ═══ WHAT THIS DOES AND, MORE IMPORTANTLY, WHAT IT DOES NOT ═══
 * It changes exactly one thing: whether `app/api/sms/inbound/route.ts` emits the `<Message>` body
 * it has ALREADY BUILT, or emits an empty `<Response>`. It does not dispatch anything, does not
 * touch `smsSendingEnabled`, does not alter a single consent transition, and cannot cause a Twilio
 * API call. Every send path on this branch still gates on `smsSendingEnabled()` alone.
 *
 * ═══ WHY IT EXISTS ═══
 * The inbound reply is dropped on a dry run (round 13) because until Toll-Free Verification is
 * granted, outbound traffic from an unverified number should not flow. Correct for production, and
 * it made the reply text invisible to the local testing harness — the same flag suppressing the
 * send was suppressing the evidence. A TwiML reply needs no credential and makes no API call, so
 * the two are separable, and this separates them.
 *
 * ═══ 🔴 THE RISK, STATED PLAINLY, BECAUSE IT IS THE WHOLE REASON FOR THE CONDITIONS ═══
 * In the HARNESS, the TwiML response goes back to the test agent that posted it, and nothing is
 * sent to anyone. IN PRODUCTION, the thing posting to that webhook is TWILIO — and Twilio WILL
 * DELIVER a `<Message>` body it receives. So this flag set in a production environment would send
 * real texts while `SMS_SENDING_ENABLED` was false and an operator believed sending was off.
 *
 * That is precisely why, per the Operator's conditions:
 *   • it is a SEPARATE flag rather than a loosening of `SMS_SENDING_ENABLED`;
 *   • it defaults to OFF everywhere, including the staging harness, until switched on for a run;
 *   • it is DELIBERATELY ABSENT from `.env.example` and from every tracked config file, so it
 *     cannot be copied into a real environment by someone filling in the blanks. It lives only in
 *     the harness's own local, gitignored env.
 *
 * `=== 'true'`, THE SAME COMPARISON `smsSendingEnabled` MAKES, through the same `env()` reader —
 * so 'TRUE', '1' and 'yes' are all off, and ' true ' is on because `env()` trims. Deliberately
 * neither stricter nor more lenient than the flag it sits beside: a new flag that parsed its input
 * differently from the established one would be its own trap. tests/sms/inbound_route.test.ts
 * asserts that parity directly rather than describing it.
 */
export function stagingReplyBodyAllowed(): boolean {
  return env('SMS_STAGING_ALLOW_REPLY_BODY') === 'true';
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
export const SITE_URL_DEV_FALLBACK = 'http://localhost:3000';

export function siteUrl(): string {
  const configured = env('NEXT_PUBLIC_SITE_URL');
  if (configured) return configured.replace(/\/+$/, '');

  /*
   * ═══ FAIL LOUDLY RATHER THAN SEND LINKS TO LOCALHOST ═══
   * Every user-facing URL this product puts in a text comes from here — `shortLinkUrl`,
   * `signupUrl` and `preferencesUrl` are all `${siteUrl()}/...`. So an unset or BLANK
   * NEXT_PUBLIC_SITE_URL does not degrade the message, it hollows it out: the texts send
   * perfectly, Twilio reports success, nothing throws, and every link inside them points at a
   * machine the recipient does not have.
   *
   * `preferencesUrl`'s own comment already states the standard this enforces — that link "is the
   * CASL unsubscribe path and the PIPEDA access/correction mechanism at the same time. A message
   * that renders without it is a message that must not be sent." A localhost link satisfies the
   * type and fails the promise, which is the harder version of the same failure. The regulator's
   * question is not "was a URL present" but "could they unsubscribe".
   *
   * ── WHY THIS IS GATED ON `smsSendingEnabled()` AND NOT ON NODE_ENV ──────────────────────
   * NODE_ENV === 'production' is true for `next build`, for a local production build, and for
   * every preview deploy — none of which is the thing that causes harm. The condition that
   * actually matters is "are we about to put these links in front of a real person", and this
   * module already has that concept and gates real dispatch on it. Reusing it means the guard
   * cannot misfire in local dev or in the test lanes, where sending is off by default and the
   * localhost fallback is correct and wanted.
   *
   * ⚠ THROWS rather than warns, deliberately. A warning in a serverless log is a thing nobody
   * reads until a subscriber complains they cannot unsubscribe. Refusing to build the URL fails
   * the weekly run instead — loud, immediate, and before anything reaches a phone. The blast
   * radius is bounded by the same flag: with sending off, nothing here can throw at all.
   *
   * A BLANK VALUE IS TREATED AS MISSING, because `env()` maps an empty string to undefined —
   * and an empty variable is the easier mistake to make in a hosting dashboard than a deleted
   * one.
   */
  if (smsSendingEnabled()) {
    throw new Error(
      'NEXT_PUBLIC_SITE_URL is unset or blank while SMS_SENDING_ENABLED is true. Refusing to ' +
        `build links against ${SITE_URL_DEV_FALLBACK}: every short link, signup link and ` +
        'preferences link in a real text would point at localhost — including the CASL ' +
        'unsubscribe path, which would leave subscribers no working way to opt out.'
    );
  }
  return SITE_URL_DEV_FALLBACK;
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
 * The public signup form: `{site}/sms/signup` (PRD §2.1).
 *
 * Written down once here rather than at each call site, for the same reason `SUPPORT_PHONE_E164`
 * is: a path typed in two places is a path that will eventually be two different paths. Used by
 * the inbound webhook's unknown-keyword reply, which is the one message that has to give somebody
 * with no subscription somewhere to go.
 */
export function signupUrl(): string {
  return `${siteUrl()}/sms/signup`;
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

/**
 * The absolute URL Twilio should POST delivery receipts to, or null if unconfigured.
 *
 * ONE VALUE FOR BOTH SIDES, and that is the point rather than a convenience: `dispatchSms` sends
 * this string to Twilio as the `StatusCallback` parameter, and app/api/sms/status/route.ts
 * verifies the resulting POST's signature against the same string. Twilio computes that signature
 * over the full URL it was given, so the two MUST be character-identical — deriving one from the
 * other, or rebuilding it from request headers, is how a signature check silently starts failing
 * in production. Same reasoning as `webhookPublicUrl` below, one step further: here we control
 * both ends, so a single config value makes them consistent by construction.
 *
 * SEPARATE FROM `webhookPublicUrl` because they are different routes with different Twilio console
 * configuration; sharing one would mean delivery receipts arriving at the inbound message handler.
 *
 * Null means no callback is requested at all — the send still happens, and
 * `sms_send_log.delivery_status` simply never gets its later truth.
 */
export function statusCallbackUrl(): string | null {
  return env('SMS_STATUS_CALLBACK_URL') ?? null;
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
