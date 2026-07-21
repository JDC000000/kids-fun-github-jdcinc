import * as Sentry from '@sentry/node';
import type { Breadcrumb, Event } from '@sentry/node';

// Worker-local Sentry setup. The web app uses @sentry/nextjs; the Fly ingestion
// runtime is plain Node, so it needs its own SDK init + explicit flush on errors.

const DEFAULT_FLUSH_TIMEOUT_MS = 2000;
const SENSITIVE_KEY_RE =
  /(?:password|passwd|pwd|secret|token|access_token|refresh_token|id_token|api[_-]?key|authorization|auth|cookie|session|dsn|database_url|connection[_-]?string)/i;
const EMAIL_RE = /[a-z0-9._%+-]+(?:@|%40)[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_CREDENTIAL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^:\s/@]+):([^@\s]+)@/gi;

let initialized = false;

function environment(): string {
  return (
    process.env.SENTRY_ENVIRONMENT ||
    process.env.KIDS_FUN_INGEST_ENV ||
    process.env.APP_ENV ||
    process.env.NODE_ENV ||
    'development'
  );
}

function redactedString(value: string): string {
  return value
    .replace(URL_CREDENTIAL_RE, '$1[redacted]:[redacted]@')
    .replace(EMAIL_RE, '[redacted-email]');
}

function safeValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactedString(value);
  if (depth >= 6) return value;
  if (Array.isArray(value)) return value.map((item) => safeValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(key)) continue;
      out[key] = safeValue(child, depth + 1);
    }
    return out;
  }
  return value;
}

function scrubEvent<T extends Event>(event: T): T {
  if (typeof event.message === 'string') event.message = redactedString(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === 'string') exception.value = redactedString(exception.value);
  }
  if (event.extra) event.extra = safeValue(event.extra) as Event['extra'];
  if (event.contexts) event.contexts = safeValue(event.contexts) as Event['contexts'];
  if (event.tags) event.tags = safeValue(event.tags) as Event['tags'];
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((breadcrumb): Breadcrumb => {
      const next = { ...breadcrumb };
      if (typeof next.message === 'string') next.message = redactedString(next.message);
      if (next.data) next.data = safeValue(next.data) as Breadcrumb['data'];
      return next;
    });
  }
  return event;
}

function normalizeTags(tags: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (SENSITIVE_KEY_RE.test(key) || value === undefined || value === null) continue;
    out[key] = redactedString(String(value)).slice(0, 200);
  }
  return out;
}

export interface WorkerSentryContext {
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export function initWorkerSentry(): void {
  if (initialized) return;
  initialized = true;

  const dsn = process.env.SENTRY_DSN || process.env.KIDS_FUN_SENTRY_DSN;
  Sentry.init({
    dsn,
    enabled: Boolean(dsn),
    environment: environment(),
    release: process.env.SENTRY_RELEASE || process.env.FLY_MACHINE_VERSION,
    initialScope: {
      tags: {
        owner_team: 'kids-fun',
        app_runtime: 'worker',
        fly_app: process.env.FLY_APP_NAME || 'local',
      },
    },
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: (event) => scrubEvent(event),
  });
}

export async function captureWorkerException(
  err: unknown,
  context: WorkerSentryContext = {},
  flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS
): Promise<boolean> {
  initWorkerSentry();
  Sentry.withScope((scope) => {
    scope.setTags(normalizeTags(context.tags));
    if (context.extra) scope.setExtras(safeValue(context.extra) as Record<string, unknown>);
    Sentry.captureException(err, {
      mechanism: { handled: false, type: 'kids_fun.worker' },
    });
  });
  return Sentry.flush(flushTimeoutMs);
}

export async function closeWorkerSentry(flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<boolean> {
  initWorkerSentry();
  return Sentry.close(flushTimeoutMs);
}
