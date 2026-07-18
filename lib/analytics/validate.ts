// lib/analytics/validate.ts — manual request validation for POST /api/analytics/event.
//
// The repo validates untrusted input by hand (see app/api/search/route.ts:
// buildSearchRequest / clampInt), not with a schema library — zod is not a
// dependency. This module matches that convention: a pure, side-effect-free
// parser that turns an unknown JSON body into a typed AnalyticsEventWrite or a
// human-readable error. Both camelCase and snake_case keys are accepted so
// browser callers and internal callers can share the contract.
import {
  type AnalyticsEventType,
  type AnalyticsEventWrite,
  CLIENT_EVENT_TYPES,
  MAX_JSON_FIELD_BYTES,
  UUID_RE,
} from './types';

export type AnalyticsEventParseResult =
  | { ok: true; value: AnalyticsEventWrite }
  | { ok: false; error: string };

/** Parse + validate an untrusted request body. Never throws. */
export function parseAnalyticsEventBody(raw: unknown): AnalyticsEventParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const body = raw as Record<string, unknown>;

  // Only client-fireable events are accepted on the public route. Server-only
  // events (sign-in, opt-in, corrections, status changes) are emitted by trusted
  // server code and must never be injectable by an untrusted browser caller.
  const eventType = firstString(body.eventType, body.event_type);
  if (eventType == null || !(CLIENT_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return { ok: false, error: 'missing or unknown eventType' };
  }

  const occurrenceId = firstString(body.occurrenceId, body.occurrence_id);
  if (occurrenceId != null && !UUID_RE.test(occurrenceId)) {
    return { ok: false, error: 'occurrenceId must be a UUID' };
  }

  const sourceId = firstString(body.sourceId, body.source_id);
  if (sourceId != null && !UUID_RE.test(sourceId)) {
    return { ok: false, error: 'sourceId must be a UUID' };
  }

  const userOrSession = firstString(body.userOrSession, body.user_or_session);
  if (userOrSession != null && userOrSession.length > 200) {
    return { ok: false, error: 'userOrSession is too long' };
  }

  const searchContext = optJsonObject(firstDefined(body.searchContext, body.search_context_json), 'searchContext');
  if (!searchContext.ok) return searchContext;

  const resultSummary = optJsonObject(firstDefined(body.resultSummary, body.result_summary_json), 'resultSummary');
  if (!resultSummary.ok) return resultSummary;

  return {
    ok: true,
    value: {
      eventType: eventType as AnalyticsEventType,
      occurrenceId: occurrenceId ?? null,
      sourceId: sourceId ?? null,
      userOrSession: userOrSession ?? null,
      searchContext: searchContext.value,
      resultSummary: resultSummary.value,
    },
  };
}

function firstDefined(...values: unknown[]): unknown {
  for (const v of values) if (v !== undefined) return v;
  return undefined;
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** Validate an optional plain-object jsonb field and enforce the per-field size cap. */
function optJsonObject(
  value: unknown,
  field: string
): { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: `${field} must be a JSON object` };
  }
  const serialised = JSON.stringify(value);
  if (Buffer.byteLength(serialised, 'utf8') > MAX_JSON_FIELD_BYTES) {
    return { ok: false, error: `${field} exceeds ${MAX_JSON_FIELD_BYTES} bytes` };
  }
  return { ok: true, value: value as Record<string, unknown> };
}
