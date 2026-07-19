// app/admin/corrections/_lib/vocab.ts — G-T34-7 correction-resolve: pure value sets +
// form validator (no DB import → client-safe + unit-testable).
//
// The set of health states an admin can move an occurrence to is the status_state ENUM
// (0002_enums.sql, 16 members) — NOT hardcoded here. The resolve form is populated from
// enum_range(status_state) at render (see _lib/data.ts getStatusStateOptions), and the
// DB enum cast is the backstop that rejects anything invalid. Confidence is the small,
// stable CHECK set on activity_occurrence.confidence_label (0004_activities.sql).
export const CONFIDENCE_LABELS = ['unscored', 'low', 'medium', 'high'] as const;
export type ConfidenceLabel = (typeof CONFIDENCE_LABELS)[number];

/** What an admin submits when resolving one correction report. */
export interface ResolveInput {
  /** The status_state to move the underlying occurrence to (validated by the DB enum). */
  statusState: string;
  /** The confidence_label to set on the occurrence. */
  confidenceLabel: ConfidenceLabel;
  /** Optional free-text note on why/how it was resolved — recorded in the audit after_json. */
  resolutionNote: string | null;
}

export type ResolveFieldErrors = Partial<Record<keyof ResolveInput, string>>;
export type ParseResolveResult = { ok: true; value: ResolveInput } | { ok: false; errors: ResolveFieldErrors };

export const MAX_RESOLUTION_NOTE = 1000;

/** Validate the raw resolve form into a typed ResolveInput or field errors. Pure. */
export function parseResolveInput(raw: Record<string, string | undefined>): ParseResolveResult {
  const errors: ResolveFieldErrors = {};

  const statusState = (raw.statusState ?? '').trim();
  if (statusState.length === 0) errors.statusState = 'Choose a health state to set on the listing.';

  const confidenceLabel = (raw.confidenceLabel ?? '').trim();
  if (!(CONFIDENCE_LABELS as readonly string[]).includes(confidenceLabel)) {
    errors.confidenceLabel = 'Choose a confidence level.';
  }

  const noteRaw = (raw.resolutionNote ?? '').trim();
  if (noteRaw.length > MAX_RESOLUTION_NOTE) {
    errors.resolutionNote = `Keep the note under ${MAX_RESOLUTION_NOTE} characters.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      statusState,
      confidenceLabel: confidenceLabel as ConfidenceLabel,
      resolutionNote: noteRaw.length > 0 ? noteRaw : null,
    },
  };
}
