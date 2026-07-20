// worker/adapters/seasonal/manual.ts — G-T12-3: manual seasonal records intake
// (TSD §5 row 6, §7.1). Some seasonal facts have no machine-readable status page —
// e.g. a resort's winter operating window plus age/height rules for its kids
// programs (the Cypress winter / age-height notes in T-09). This module is the
// operator intake: a typed manual seasonal record + validation + a bridge to the
// map.ts override hook, so an operator's declared season_state wins over (or fills
// in for) the watcher.
//
// PURE: no DB, no network — trivially unit-testable and safe to import anywhere.
// Persisting a record is the caller's job (operator console / seed); this module
// only defines and validates the shape and derives the season override.
import { SEASON_STATES, type SeasonState, type SeasonOverride } from './map';

export interface ManualSeasonalRecord {
  /** The seasonal source this record annotates (config key or a free label). */
  sourceKey: string;
  /** Human title of the seasonal offering (e.g. "Cypress Mountain — winter operations"). */
  title: string;
  /** Operator-declared season_state — the authoritative state for this record. */
  seasonState: SeasonState;
  /** Optional operating window (free-text ISO-ish or human dates + a note). */
  operatingWindow?: {
    opensIso?: string;
    closesIso?: string;
    note?: string;
  };
  /** Weather / conditions caveat (e.g. "downhill & tube operations are snow dependent"). */
  weatherNotes?: string;
  /** Minimum age in months for the offering's kids program, if any. */
  ageMinMonths?: number;
  /** Minimum height in cm (e.g. a tube-park height rule), if any. */
  heightMinCm?: number;
  /** Free-text age / height guidance shown to families. */
  ageHeightNotes?: string;
  /** Who recorded this (operator id / label) — carried into the override reason. */
  recordedBy: string;
  /** Why this override was set (audit). */
  overrideReason?: string;
}

export type ManualSeasonalErrors = Partial<Record<keyof ManualSeasonalRecord, string>>;
export type ParseManualResult =
  | { ok: true; value: ManualSeasonalRecord }
  | { ok: false; errors: ManualSeasonalErrors };

const MAX_TEXT = 500;
const MAX_AGE_MONTHS = 216; // 18y — matches the age-band ceiling used elsewhere (TSD §6.2)
const MAX_HEIGHT_CM = 250;

function isState(v: unknown): v is SeasonState {
  return typeof v === 'string' && (SEASON_STATES as readonly string[]).includes(v);
}

/**
 * Validate a raw manual seasonal record. Pure: no DB, no side effects. Ensures the
 * declared season_state is a legal enum value and numeric fields are plausible, so
 * a bad operator entry never reaches applySeasonState / the DB.
 */
export function validateManualSeasonalRecord(input: Partial<ManualSeasonalRecord>): ParseManualResult {
  const errors: ManualSeasonalErrors = {};

  const sourceKey = (input.sourceKey ?? '').trim();
  const title = (input.title ?? '').trim();
  const recordedBy = (input.recordedBy ?? '').trim();

  if (!sourceKey) errors.sourceKey = 'A source key is required.';
  if (!title) errors.title = 'A title is required.';
  else if (title.length > MAX_TEXT) errors.title = `Title must be ${MAX_TEXT} characters or fewer.`;
  if (!recordedBy) errors.recordedBy = 'recordedBy (operator id) is required.';
  if (!isState(input.seasonState)) errors.seasonState = 'Choose a valid season state.';

  if (input.ageMinMonths != null) {
    if (!Number.isFinite(input.ageMinMonths) || input.ageMinMonths < 0 || input.ageMinMonths > MAX_AGE_MONTHS) {
      errors.ageMinMonths = `ageMinMonths must be between 0 and ${MAX_AGE_MONTHS}.`;
    }
  }
  if (input.heightMinCm != null) {
    if (!Number.isFinite(input.heightMinCm) || input.heightMinCm <= 0 || input.heightMinCm > MAX_HEIGHT_CM) {
      errors.heightMinCm = `heightMinCm must be between 1 and ${MAX_HEIGHT_CM}.`;
    }
  }
  for (const k of ['weatherNotes', 'ageHeightNotes', 'overrideReason'] as const) {
    const v = input[k];
    if (typeof v === 'string' && v.length > MAX_TEXT) {
      errors[k] = `${k} must be ${MAX_TEXT} characters or fewer.`;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      sourceKey,
      title,
      seasonState: input.seasonState as SeasonState,
      operatingWindow: input.operatingWindow,
      weatherNotes: input.weatherNotes?.trim() || undefined,
      ageMinMonths: input.ageMinMonths,
      heightMinCm: input.heightMinCm,
      ageHeightNotes: input.ageHeightNotes?.trim() || undefined,
      recordedBy,
      overrideReason: input.overrideReason?.trim() || undefined,
    },
  };
}

/**
 * Build a map.ts SeasonOverride from a manual record. The override always wins over
 * the watched signal (resolveSeasonState), so an operator can pin a seasonal offering's
 * state (e.g. Cypress winter) regardless of what any status page says.
 */
export function toSeasonOverride(record: ManualSeasonalRecord): SeasonOverride {
  const bits = [record.overrideReason, record.weatherNotes, record.ageHeightNotes].filter(Boolean);
  const detail = bits.length > 0 ? ` — ${bits.join('; ')}` : '';
  return {
    seasonState: record.seasonState,
    reason: `manual seasonal record "${record.title}"${detail}`,
    setBy: record.recordedBy,
  };
}
