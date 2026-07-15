// lib/corrections/validate.ts — manual request validation for POST /api/corrections.
//
// Mirrors the by-hand validation convention in lib/analytics/validate.ts (zod is not
// a dependency): a pure, side-effect-free parser that turns an unknown JSON body into
// a typed CorrectionReportWrite or a human-readable error. Both camelCase and
// snake_case keys are accepted, and `reason` is taken as an alias for `note`.
import {
  type CorrectionIssueType,
  type CorrectionReportWrite,
  DEFAULT_ISSUE_TYPE,
  KNOWN_ISSUE_TYPES,
  MAX_NOTE_LENGTH,
  UUID_RE,
} from './types';

export type CorrectionParseResult =
  | { ok: true; value: CorrectionReportWrite }
  | { ok: false; error: string };

/** Parse + validate an untrusted request body. Never throws. */
export function parseCorrectionReportBody(raw: unknown): CorrectionParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const body = raw as Record<string, unknown>;

  // occurrence_id is REQUIRED and must be a UUID — it's a NOT NULL foreign key.
  const occurrenceId = firstString(body.occurrenceId, body.occurrence_id);
  if (occurrenceId == null || !UUID_RE.test(occurrenceId)) {
    return { ok: false, error: 'occurrenceId must be a UUID' };
  }

  // issueType is optional — the "Report wrong info" button sends none, so default it.
  const rawIssue = firstString(body.issueType, body.issue_type);
  const issueType = (rawIssue ?? DEFAULT_ISSUE_TYPE) as CorrectionIssueType;
  if (!(KNOWN_ISSUE_TYPES as readonly string[]).includes(issueType)) {
    return { ok: false, error: 'unknown issueType' };
  }

  // note (aka reason) is optional free text; trim and cap its length.
  const rawNote = firstString(body.note, body.reason);
  let note: string | null = null;
  if (rawNote != null) {
    const trimmed = rawNote.trim();
    if (trimmed.length > MAX_NOTE_LENGTH) {
      return { ok: false, error: `note exceeds ${MAX_NOTE_LENGTH} characters` };
    }
    note = trimmed.length > 0 ? trimmed : null;
  }

  return { ok: true, value: { occurrenceId, issueType, note } };
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}
