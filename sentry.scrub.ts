// Sentry — explicit PII deny-list / redaction (Round 15, Task Q).
//
// Defense-in-depth on top of `sendDefaultPii: false`. Even with default-PII
// suppression turned on, user-supplied strings can still reach Sentry inside an
// error *message*, a breadcrumb, `extra` data, a request body / query string,
// etc. This module applies a small, explicit deny-list that:
//   1. redacts obviously-PII-shaped values (email addresses, IP addresses,
//      phone-shaped numbers) wherever they appear as free-form strings, and
//   2. strips the known PII-carrying containers on an event outright (user
//      identity beyond a pseudonymous id, cookies, auth headers, client IP).
//
// It is wired as `beforeSend` (and `beforeSendTransaction`) across all three
// runtimes (client / server / edge). The logic is pure string / plain-object
// work with no Node built-ins, so it is safe in the Edge runtime and in the
// browser bundle. Only *types* are imported from the SDK, so this module pulls
// in no runtime Sentry code of its own.
//
// Design bias: we prefer over-redaction (a build string that happens to look
// like an IP may get masked) over ever leaking real PII. For a product whose
// users are parents / guardians, the privacy trade-off is intentional. We
// REDACT rather than DROP events so an error stays useful for debugging.

import type { Breadcrumb, Event } from '@sentry/nextjs';

// --- Placeholders ------------------------------------------------------------
export const EMAIL_MASK = '[redacted-email]';
export const IP_MASK = '[redacted-ip]';
export const PHONE_MASK = '[redacted-phone]';

// --- Patterns ----------------------------------------------------------------
// Email: local@domain.tld, case-insensitive, global. The `@` alternation also
// matches its percent-encoded form (`%40`) so emails embedded in request URLs /
// query strings are caught too.
const EMAIL_RE = /[a-z0-9._%+-]+(?:@|%40)[a-z0-9.-]+\.[a-z]{2,}/gi;

// IPv4: four 0-255 octets, word-bounded so we don't clip inside a longer digit
// run. Validating each octet (rather than a naive \d{1,3}) keeps false
// positives on dotted build/version strings lower.
const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

// IPv6: full (8 group) form or any `::`-compressed form. Comprehensive,
// well-known pattern. Every branch requires either 8 groups or a `::`, so it
// does not fire on ordinary `HH:MM:SS` timestamps or `key::value` text.
// Branch order matters: JS alternation takes the FIRST branch that matches at a
// position (not the longest), so the "groups :: trailing-groups" branches must
// precede the bare `::`-compression branches or a `1:2:3::4:5:6` address would
// only get its head masked. Longest-reach branches first.
const IPV6_RE = new RegExp(
  [
    '(?:[a-f0-9]{1,4}:){7}[a-f0-9]{1,4}', // full 1:2:3:4:5:6:7:8
    '(?:[a-f0-9]{1,4}:){1,2}(?::[a-f0-9]{1,4}){1,5}',
    '(?:[a-f0-9]{1,4}:){1,3}(?::[a-f0-9]{1,4}){1,4}',
    '(?:[a-f0-9]{1,4}:){1,4}(?::[a-f0-9]{1,4}){1,3}',
    '(?:[a-f0-9]{1,4}:){1,5}(?::[a-f0-9]{1,4}){1,2}',
    '(?:[a-f0-9]{1,4}:){1,6}:[a-f0-9]{1,4}', // 1:2:3:4:5:6::8
    '[a-f0-9]{1,4}:(?::[a-f0-9]{1,4}){1,6}', // 1::3:4:5:6:7:8
    '(?:[a-f0-9]{1,4}:){1,7}:', // trailing 1:: … 1:2:3:4:5:6:7::
    ':(?:(?::[a-f0-9]{1,4}){1,7}|:)', // leading ::8  or  ::
  ].join('|'),
  'gi',
);

// Phone (best-effort, secondary to email/IP). Two conservative shapes:
//   • international: a leading '+' then 7-14 more digits with optional
//     space / dash / dot / paren separators, and
//   • grouped domestic: NNN<sep>NNN<sep>NNNN, optionally parenthesised area
//     code, e.g. (555) 123-4567 or 555-123-4567.
// Kept narrow on purpose so short numeric IDs / counters are not masked.
const PHONE_INTL_RE = /\+\d(?:[\d\s().-]{5,13})\d/g;
const PHONE_GROUPED_RE =
  /(?<![\d.])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\d.])/g;

/**
 * Redact PII-shaped substrings from a single string. Order matters: email is
 * masked first (its local part may contain digits that would otherwise be seen
 * as a phone), then IPv6 before IPv4, then phone shapes.
 */
export function redactString(input: string): string {
  return input
    .replace(EMAIL_RE, EMAIL_MASK)
    .replace(IPV6_RE, IP_MASK)
    .replace(IPV4_RE, IP_MASK)
    .replace(PHONE_INTL_RE, PHONE_MASK)
    .replace(PHONE_GROUPED_RE, PHONE_MASK);
}

// Object keys whose *value* is dropped wholesale (rather than pattern-redacted)
// because the key itself signals sensitive content. Compared case-insensitively.
const DENY_KEYS = new Set<string>([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'cookie',
  'cookies',
  'session',
  'sessionid',
  'ssn',
  'credit_card',
  'card_number',
  'cvv',
  'email',
  'email_address',
  'phone',
  'phone_number',
  'ip',
  'ip_address',
  'x-forwarded-for',
]);

// Request headers stripped entirely — they routinely carry credentials or the
// caller's IP even when `sendDefaultPii` is false.
const DENY_HEADERS = new Set<string>([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-forwarded-for',
  'x-real-ip',
  'x-client-ip',
  'forwarded',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-supabase-auth',
]);

const MAX_DEPTH = 8;

/**
 * Recursively redact a free-form value (breadcrumb data, `extra`, request body,
 * …). Strings are pattern-redacted; deny-listed object keys are dropped;
 * everything else is walked up to a depth cap (events are serializable by
 * contract, so the cap is a runaway guard rather than a cycle guard).
 */
export function deepRedact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item) => deepRedact(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (DENY_KEYS.has(key.toLowerCase())) continue;
      out[key] = deepRedact(val, depth + 1);
    }
    return out;
  }
  return value;
}

/** Keep only a pseudonymous `id`; drop email / username / ip / geo and the rest. */
function sanitizeUser(user: NonNullable<Event['user']>): NonNullable<Event['user']> {
  const cleaned: Record<string, unknown> = {};
  if (user.id !== undefined && user.id !== null) cleaned.id = user.id;
  return cleaned as NonNullable<Event['user']>;
}

/** Strip credential / IP headers and redact the remaining request surface. */
function sanitizeRequest(request: NonNullable<Event['request']>): void {
  const { headers } = request;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const h = headers as Record<string, unknown>;
    for (const key of Object.keys(h)) {
      if (DENY_HEADERS.has(key.toLowerCase())) {
        delete h[key];
      } else if (typeof h[key] === 'string') {
        h[key] = redactString(h[key] as string);
      }
    }
  }

  // Cookies + env can carry session tokens / the caller's REMOTE_ADDR.
  delete request.cookies;
  if (request.env && typeof request.env === 'object') {
    delete (request.env as Record<string, unknown>).REMOTE_ADDR;
  }

  if (typeof request.url === 'string') request.url = redactString(request.url);
  if (request.query_string !== undefined) {
    request.query_string =
      typeof request.query_string === 'string'
        ? redactString(request.query_string)
        : (deepRedact(request.query_string) as typeof request.query_string);
  }
  if (request.data !== undefined) request.data = deepRedact(request.data);
}

function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  const next: Breadcrumb = { ...crumb };
  if (typeof next.message === 'string') next.message = redactString(next.message);
  if (next.data) next.data = deepRedact(next.data) as Breadcrumb['data'];
  return next;
}

// Minimal structural view of the span shape carried on transaction events, so
// beforeSendTransaction can redact span descriptions / data without importing
// the transaction-only types.
interface RedactableSpan {
  description?: unknown;
  data?: unknown;
}

/**
 * Redact PII from a Sentry event in place and return it. Generic over the event
 * shape so it satisfies both `beforeSend` (ErrorEvent) and
 * `beforeSendTransaction` (TransactionEvent). Never drops the event — always
 * returns it so the error/transaction is still reported (minus the PII).
 */
export function scrubEvent<T extends Event>(event: T): T {
  if (event.user) event.user = sanitizeUser(event.user);
  if (event.request) sanitizeRequest(event.request);

  if (typeof event.message === 'string') event.message = redactString(event.message);
  if (event.logentry && typeof event.logentry.message === 'string') {
    event.logentry.message = redactString(event.logentry.message);
  }

  if (event.exception?.values) {
    for (const value of event.exception.values) {
      if (typeof value.value === 'string') value.value = redactString(value.value);
      // Local-variable snapshots (LocalVariables integration) can carry runtime
      // PII. We deliberately leave frame `context_line`/`pre_context`/
      // `post_context` alone — those are application *source*, not user data,
      // and masking them would gut stack-trace readability.
      const frames = value.stacktrace?.frames;
      if (frames) {
        for (const frame of frames) {
          if (frame.vars) frame.vars = deepRedact(frame.vars) as typeof frame.vars;
        }
      }
    }
  }

  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);

  if (event.extra) event.extra = deepRedact(event.extra) as Event['extra'];
  if (event.contexts) event.contexts = deepRedact(event.contexts) as Event['contexts'];
  if (event.tags) event.tags = deepRedact(event.tags) as Event['tags'];

  // Transaction events only: span descriptions / data can echo query params.
  const spans = (event as { spans?: RedactableSpan[] }).spans;
  if (Array.isArray(spans)) {
    for (const span of spans) {
      if (typeof span.description === 'string') span.description = redactString(span.description);
      if (span.data) span.data = deepRedact(span.data);
    }
  }

  return event;
}
