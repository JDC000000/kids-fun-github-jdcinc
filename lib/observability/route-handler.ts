// lib/observability/route-handler.ts
//
// R29 STRUCTURAL FIX — guaranteed Sentry delivery for serverless (Vercel Node) API routes.
//
// ── The problem this solves ──────────────────────────────────────────────────────────────
// @sentry/nextjs's automatic route-handler instrumentation *captures* a thrown error but, on
// the Vercel **Node.js** runtime, does not reliably *send* it. Its flush is a fire-and-forget
// promise handed to `vercelWaitUntil`, which is a NO-OP outside the Edge runtime — see
// @sentry/core's vercelWaitUntil.ts:
//
//     export function vercelWaitUntil(task) {
//       // We only flush manually in Vercel Edge runtime
//       // In Node runtime, we use process.on('SIGTERM') instead
//       if (typeof EdgeRuntime !== 'string') { return; }   // <-- Node runtime: returns here
//       ...
//     }
//
// So on a Node lambda the SDK creates the flush promise but never awaits it and never registers
// it with the platform; the async HTTP POST to Sentry's ingest endpoint then races the lambda
// freeze/recycle and can be silently dropped. Round 29 confirmed this empirically: a plain throw
// via the automatic path never reached Sentry after ~4 minutes, while the same throw with an
// explicit `Sentry.captureException` + `await Sentry.flush()` landed within ~2 minutes.
//
// Note: @sentry/core already ships the correct primitive — `flushIfServerless()` `await`s the
// flush when `process.env.VERCEL` is set — but the App-Router route-handler auto-instrumentation
// never calls it. This module does exactly what `flushIfServerless` does, wired as a choke point.
//
// ── Why a wrapper, not per-route flush calls ─────────────────────────────────────────────────
// Scattering `Sentry.flush()` through individual route files is the exact failure mode the finding
// said to eliminate: easy to forget on the next route. `withObservedRoute` is the single place
// capture+flush lives, so every route that runs through it inherits the guarantee automatically —
// the same single-choke-point pattern as app/admin/_lib/gate.ts's resolveAdminAccess().
//
// ── Why `await flush`, not `waitUntil` ───────────────────────────────────────────────────────
// `waitUntil` is the very primitive the SDK's auto-path already tries and that no-ops on Node — it
// is the broken thing here, not the fix. Awaiting the flush *before the handler returns* is strictly
// sufficient and platform-agnostic: a lambda cannot freeze while a handler is still awaiting, so the
// send always completes. Blocking an (already-failed) 500 response by up to ~2s to guarantee the
// event is an acceptable, deterministic trade. `@vercel/functions`' `waitUntil` remains the right
// tool only for the separate "flush AFTER a successful response without blocking it" pattern; the
// error path here does not need it, so no new dependency is introduced.
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

/** Default max time (ms) to block on the Sentry flush before returning the error response. */
export const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

export interface ObservedRouteOptions {
  /** Max ms to block on the Sentry flush before responding. Default {@link DEFAULT_FLUSH_TIMEOUT_MS}. */
  flushTimeoutMs?: number;
  /** Extra Sentry tags for triage of issues raised by this route, e.g. `{ route: 'api/health' }`. */
  tags?: Record<string, string>;
}

type RouteHandler<A extends unknown[]> = (...args: A) => Response | Promise<Response>;

/**
 * Wrap an App-Router route handler so that any uncaught error it throws is captured AND flushed to
 * Sentry before the response is returned — closing the serverless-flush-timing gap centrally.
 *
 * Behaviour:
 *  - Success: returns the handler's response untouched (zero overhead — no capture, no flush).
 *  - Next.js control-flow throws (`redirect()`, `notFound()`): re-thrown untouched, never captured.
 *  - Genuine error: captured, `await`-flushed, then a consistent `500 { error }` JSON is returned.
 *    The wrapper deliberately does NOT re-throw, so it stays the single, deterministic capture point
 *    (re-throwing would let the SDK's auto-path capture the same error a second time).
 */
export function withObservedRoute<A extends unknown[]>(
  handler: RouteHandler<A>,
  options: ObservedRouteOptions = {},
): (...args: A) => Promise<Response> {
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      // Next.js throws sentinel "errors" for control flow (redirect / notFound). Those are not
      // failures: never capture them and re-throw untouched so Next still performs the redirect/404.
      if (isNextControlFlowError(err)) {
        throw err;
      }
      await captureAndFlush(err, flushTimeoutMs, options.tags);
      return NextResponse.json({ error: 'internal_server_error' }, { status: 500 });
    }
  };
}

/**
 * Optional per-capture scope data for captureAndFlush.
 *
 * `fingerprint` exists because Sentry groups by stack trace: two different messages thrown from the
 * same line land in ONE issue named after whichever arrived first. The 2026-09-24 audit found 12
 * staging `search_rate_limit_degraded:no_salt` events counted inside a production-looking
 * "db_error" issue for exactly that reason. `extra` passes through sentry.scrub.ts's deep redaction
 * like any other event data.
 */
export interface CaptureScopeOptions {
  fingerprint?: string[];
  extra?: Record<string, unknown>;
}

/**
 * Capture an exception and BLOCK until it is actually sent to Sentry (or the timeout elapses). This
 * is the guarantee the serverless auto-path lacks. Exposed for the rare handler that catches its own
 * error, degrades gracefully, and returns a non-500 — it can still `await captureAndFlush(err)` to be
 * sure the event survives lambda freeze. No-op / resolves instantly when Sentry is disabled (no DSN),
 * so it is free in local / CI / test runs.
 */
export async function captureAndFlush(
  err: unknown,
  flushTimeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS,
  tags?: Record<string, string>,
  scopeOptions?: CaptureScopeOptions,
): Promise<void> {
  Sentry.withScope((scope) => {
    if (tags) {
      scope.setTags(tags);
    }
    if (scopeOptions?.fingerprint) {
      scope.setFingerprint(scopeOptions.fingerprint);
    }
    if (scopeOptions?.extra) {
      scope.setExtras(scopeOptions.extra);
    }
    Sentry.captureException(err, {
      mechanism: { handled: false, type: 'kids_fun.observed_route' },
    });
  });
  await Sentry.flush(flushTimeoutMs);
}

/**
 * True for Next.js's internal control-flow signals — `redirect()` throws an error whose `digest`
 * begins with `NEXT_REDIRECT`; `notFound()` throws one whose `digest` is `NEXT_NOT_FOUND` (Next 14)
 * or begins with `NEXT_HTTP_ERROR_FALLBACK` (newer). These must pass through the wrapper untouched.
 */
function isNextControlFlowError(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null | undefined)?.digest;
  if (typeof digest !== 'string') {
    return false;
  }
  return (
    digest.startsWith('NEXT_REDIRECT') ||
    digest === 'NEXT_NOT_FOUND' ||
    digest.startsWith('NEXT_HTTP_ERROR_FALLBACK')
  );
}
