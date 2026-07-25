// lib/observability/config.ts — environment configuration for the Sentry READ path.
//
// Mirrors lib/analytics/config.ts and lib/email/config.ts: one place that knows every
// env var a subsystem needs, with validation at the edge instead of `process.env`
// reads scattered through feature code.
//
// ── WHY A SEPARATE TOKEN FROM SENTRY_AUTH_TOKEN ────────────────────────────────
// `SENTRY_AUTH_TOKEN` already exists in .env.example, but it is documented there as
// CI-ONLY (source-map upload) and is therefore not present in the runtime
// environment — and a source-map *write* token is the wrong credential to hand to a
// long-lived web process anyway. The operating dashboard's issue trend is a strictly
// read-only call, so it takes its own `SENTRY_ISSUES_API_TOKEN`, which should be
// minted with read scopes only (`project:read`, `event:read`). Least privilege, and
// the two secrets can be rotated independently.
//
// Nothing here ever returns the token to a caller that would render or log it — the
// only accessor returns it for use as an Authorization header value, and every
// error path in lib/observability/sentry-issues.ts is written to surface a status
// code or an error NAME, never a message that could contain the credential.

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/** Sentry org slug (e.g. 'jdc000000'). Shared with the CI source-map upload. */
export function sentryOrg(): string | undefined {
  return env('SENTRY_ORG');
}

/** Sentry project slug. Shared with the CI source-map upload. */
export function sentryProject(): string | undefined {
  return env('SENTRY_PROJECT');
}

/** Sentry API base URL — overridable for self-hosted/regional installs. */
export function sentryApiBaseUrl(): string {
  return env('SENTRY_API_BASE_URL') ?? 'https://sentry.io';
}

/**
 * The read-only API token for the issue trend, or `undefined` when unset.
 *
 * Shape-validated before it is ever used: a real Sentry token is a long opaque
 * string, so anything under 20 chars or containing whitespace is treated as
 * unconfigured rather than sent to Sentry (a malformed value would only produce a
 * 401 whose handling risks echoing the value back through an error path).
 */
export function sentryIssuesApiToken(): string | undefined {
  const raw = env('SENTRY_ISSUES_API_TOKEN');
  if (!raw) return undefined;
  if (raw.length < 20 || /\s/.test(raw)) return undefined;
  return raw;
}

/** True when every piece needed for a live issue-trend read is present and well-formed. */
export function isSentryIssuesConfigured(): boolean {
  return Boolean(sentryOrg() && sentryProject() && sentryIssuesApiToken());
}

/**
 * When this Sentry project actually started being watched, as epoch-ms — or `null`
 * when unset, which is the default and means "suppress nothing" (H1 item 3).
 *
 * ── WHY THIS IS CONFIG AND NOT DERIVED ─────────────────────────────────────────
 * The issue-trend reader asks Sentry for a trailing window and zero-fills every day in
 * it, so a day before the project existed is indistinguishable from a genuinely quiet
 * day. On an error dashboard those two readings mean opposite things.
 *
 * There is no honest way to DERIVE the answer from the issues payload. The tempting
 * one — anchor on the earliest `firstSeen` in the response — is actively wrong: a day
 * before the first issue is a day with no errors, which is good news, and suppressing
 * it would hide the best signal the panel can carry. The project's real start date is
 * only knowable from outside the issue list, so it is supplied from outside.
 *
 * Unset is the safe default and the current production state: with no anchor the trend
 * is byte-for-byte what it was before H1. Set it (ISO-8601, e.g. `2026-07-14`) and days
 * that closed before it read as an em-dash instead of a zero. An unparseable value is
 * treated as unset rather than as epoch 0 — a bad env var must not silently suppress
 * the entire window.
 */
export function sentryObservedSinceMs(): number | null {
  const raw = env('SENTRY_OBSERVED_SINCE');
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}
