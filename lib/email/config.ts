// lib/email/config.ts — environment + link configuration for the weekly digest.
//
// One place that knows every email-related env var, so no other module reaches
// into process.env directly and secrets are never logged. Nothing here EVER
// returns a secret to a caller that would print it — getResendApiKey() is used
// only to build an Authorization header inside lib/email/resend.ts.
//
// Env vars (all added to .env.example):
//   RESEND_API_KEY                    — Resend API key (secret; vaulted as
//                                       credential slug `kids-fun-resend`).
//   EMAIL_FROM                        — verified From address, e.g.
//                                       "KIDS FUN <hello@mail.kidsfun.example>".
//   NEXT_PUBLIC_SITE_URL              — public app base URL for links back in.
//   WEEKLY_EMAIL_UNSUBSCRIBE_SECRET   — HMAC secret for one-click unsubscribe tokens.
//   WEEKLY_EMAIL_CRON_SECRET          — shared secret guarding the bulk trigger route.
//   WEEKLY_EMAIL_ENABLED              — "true" to permit REAL sends; anything else
//                                       forces dry-run (payload built, never dispatched).

/** Default From used when EMAIL_FROM is unset (dev/preview only; real sends require a verified domain). */
import { PRODUCTION_ORIGIN } from '@/lib/sms/config';

const DEFAULT_FROM = 'KIDS FUN <onboarding@resend.dev>';

/**
 * Fallback app URL when NEXT_PUBLIC_SITE_URL is unset.
 *
 * This comment used to end "links still render, just point local", which described the mechanism
 * accurately and the consequence not at all. See `siteUrl()` — that benign-sounding fallback is
 * only benign while nothing is being sent.
 */
export const DEFAULT_SITE_URL = 'http://localhost:3000';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * The public site base URL, without a trailing slash.
 *
 * ═══ FAILS LOUDLY RATHER THAN SEND LINKS TO LOCALHOST ═══
 * The email twin of the SMS lane's guard (lib/sms/config.ts, commit 05a5b56), added after the SMS
 * one was found: the two lanes read the SAME `NEXT_PUBLIC_SITE_URL`, so a single missing variable
 * would have hollowed out both at once — which is the part worth noticing.
 *
 * EVERY URL IN A DIGEST COMES FROM HERE. `appUrl` feeds the per-listing links, the saved-search
 * links, the account link, and — through lib/email/unsubscribe.ts — the ONE-CLICK UNSUBSCRIBE URL
 * that goes in both the email body and the RFC 8058 `List-Unsubscribe` header. So an unset or
 * blank variable does not break a send, it empties it: Resend accepts the message, the digest
 * arrives looking correct, and every link inside points at a machine the recipient does not own.
 *   The unsubscribe link is the one that turns that from embarrassing into a compliance problem.
 *   CASL's question is not "was an unsubscribe mechanism present" but "could they use it", and a
 *   localhost URL satisfies the first while failing the second. `List-Unsubscribe` additionally
 *   feeds the bulk-sender expectations Gmail and Yahoo enforce.
 *
 * GATED ON `sendingEnabled()`, NOT ON NODE_ENV — same reasoning as the SMS lane. NODE_ENV is
 * 'production' during `next build`, in a local production build, and on every preview deploy, none
 * of which puts a link in front of a person. The condition that matters is "are we about to send",
 * and this module already owns that concept. So the guard cannot fire in dev or in the test lanes,
 * where the localhost fallback is correct and wanted — asserted, so it stays that way.
 *
 * A BLANK VALUE COUNTS AS MISSING, because `env()` maps '' to undefined. A variable emptied in a
 * hosting dashboard is an easier mistake than one deleted.
 */
export function siteUrl(): string {
  const configured = env('NEXT_PUBLIC_SITE_URL');
  if (configured) {
    const normalised = configured.replace(/\/+$/, '');
    /*
     * ═══ THE SAME HOLE THE SMS LANE HAD, IN THE SAME VARIABLE ═══
     * This guard used to ask only "is NEXT_PUBLIC_SITE_URL set". A wrong-but-set value passed
     * silently — and that is not hypothetical: it shipped, with production pointed at the
     * vercel.app mirror, so every outbound link rendered against the wrong host. It was fixed by
     * correcting the VALUE, which left this check exactly as permissive as before.
     *
     * BOTH LANES READ THE SAME VARIABLE, so a repointed origin breaks emails and texts together.
     * Hardening only lib/sms/config.ts would have closed the audit item and left the identical
     * bug here, in the file that builds the email unsubscribe link.
     *
     * PRODUCTION_ORIGIN is imported rather than restated: two hand-maintained copies of the live
     * domain is how the two lanes eventually disagree about what production is.
     */
    if (sendingEnabled() && normalised !== PRODUCTION_ORIGIN) {
      throw new Error(
        `NEXT_PUBLIC_SITE_URL is "${normalised}" while email sending is enabled. Refusing to ` +
          `build links against anything but ${PRODUCTION_ORIGIN}: every link in a real digest ` +
          'would point at the wrong host — including the unsubscribe link, which would resolve, ' +
          'look correct, and not be the live site.'
      );
    }
    return normalised;
  }
  if (sendingEnabled()) {
    throw new Error(
      'NEXT_PUBLIC_SITE_URL is unset or blank while WEEKLY_EMAIL_ENABLED is true. Refusing to ' +
        `build digest links against ${DEFAULT_SITE_URL}: every listing link and the one-click ` +
        'unsubscribe URL — in the body and the List-Unsubscribe header — would point at ' +
        'localhost, leaving recipients no working way to opt out.'
    );
  }
  return DEFAULT_SITE_URL;
}

/** Build an absolute app URL from a path (path may start with or without a leading slash). */
export function appUrl(path = '/'): string {
  const base = siteUrl();
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

/** From address for the digest. */
export function fromAddress(): string {
  return env('EMAIL_FROM') ?? DEFAULT_FROM;
}

/** The Resend API key, or null if not configured (dry-run only in that case). */
export function getResendApiKey(): string | null {
  return env('RESEND_API_KEY') ?? null;
}

/** The unsubscribe HMAC secret, or null if unconfigured. */
export function unsubscribeSecret(): string | null {
  return env('WEEKLY_EMAIL_UNSUBSCRIBE_SECRET') ?? null;
}

/** The cron/bulk-trigger shared secret, or null if unconfigured. */
export function cronSecret(): string | null {
  return env('WEEKLY_EMAIL_CRON_SECRET') ?? null;
}

/**
 * Whether REAL sending is permitted. Defaults to FALSE: unless
 * WEEKLY_EMAIL_ENABLED === 'true', the whole pipeline runs in dry-run (build the
 * Resend payload, never dispatch), so a misconfigured or accidental run can never
 * email real parents. Going live is a deliberate, one-line env flip.
 */
export function sendingEnabled(): boolean {
  return env('WEEKLY_EMAIL_ENABLED') === 'true';
}
