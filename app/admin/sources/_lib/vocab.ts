// app/admin/sources/_lib/vocab.ts — G-T34-3 no-code source registry: the allowed
// value sets + a pure form validator. PURE (no DB / no pg import) so it is safe to
// import from the client form AND trivially unit-testable.
//
// The vocab mirrors the DB column constraints in supabase/migrations/0003_core_places.sql
// (source: authority_tier / terms_status / robots_status / health_state CHECK sets)
// and the enums in 0002_enums.sql (ingestion_method, season_state). A DB drift test
// (tests/admin/source-vocab-db.test.ts) asserts every option offered here is actually
// accepted by the column — so the console can never present a value the DB will reject.

export const AUTHORITY_TIERS = ['official', 'editorial', 'partner', 'manual'] as const;
export type AuthorityTier = (typeof AUTHORITY_TIERS)[number];

export const TERMS_STATUSES = ['pending', 'allowed', 'summarise_only', 'disallowed', 'blocked'] as const;
export type TermsStatus = (typeof TERMS_STATUSES)[number];

export const ROBOTS_STATUSES = ['pending', 'allowed', 'disallowed', 'unknown'] as const;
export type RobotsStatus = (typeof ROBOTS_STATUSES)[number];

export const HEALTH_STATES = ['healthy', 'degraded', 'stale', 'failing', 'unknown'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const INGESTION_METHODS = ['auto', 'semi', 'manual', 'partner'] as const;
export type IngestionMethod = (typeof INGESTION_METHODS)[number];

export const SEASON_STATES = ['active', 'pre_season', 'in_season', 'post_season', 'suspended', 'unknown'] as const;
export type SeasonState = (typeof SEASON_STATES)[number];

// Cadence "tier" — the source.baseline_cadence / near_date_cadence interval columns are
// offered as a curated tier list (no free-text interval parsing). Each value is a legal
// Postgres interval literal cast with `$n::interval` on write. The set covers every
// interval the registry seed already uses (supabase/seeds/sources.sql) so editing a
// seeded row pre-selects its current cadence rather than dropping to a fallback.
export const CADENCE_OPTIONS = [
  '1 hour',
  '2 hours',
  '6 hours',
  '12 hours',
  '1 day',
  '2 days',
  '3 days',
  '7 days',
  '14 days',
  '30 days',
] as const;
export type Cadence = (typeof CADENCE_OPTIONS)[number];

/** Whole-seconds length of each cadence tier — used to map a stored interval (read as
 *  EXTRACT(EPOCH …)) back to its tier label so the edit form pre-selects correctly. */
export const CADENCE_SECONDS: Record<Cadence, number> = {
  '1 hour': 3_600,
  '2 hours': 7_200,
  '6 hours': 21_600,
  '12 hours': 43_200,
  '1 day': 86_400,
  '2 days': 172_800,
  '3 days': 259_200,
  '7 days': 604_800,
  '14 days': 1_209_600,
  '30 days': 2_592_000,
};

/** Map a stored interval's total seconds to its tier label, or null if it matches no tier. */
export function cadenceFromSeconds(seconds: number | null | undefined): Cadence | null {
  if (seconds == null) return null;
  for (const opt of CADENCE_OPTIONS) {
    if (CADENCE_SECONDS[opt] === seconds) return opt;
  }
  return null;
}

/** The editable shape of a source row (everything the no-code console can set). */
export interface SourceInput {
  family: string;
  name: string;
  platform: string | null;
  authorityTier: AuthorityTier;
  termsStatus: TermsStatus;
  robotsStatus: RobotsStatus;
  ingestionMethod: IngestionMethod;
  seasonState: SeasonState;
  healthState: HealthState;
  baselineCadence: Cadence;
  nearDateCadence: Cadence | null;
}

export type SourceFieldErrors = Partial<Record<keyof SourceInput, string>>;
export type ParseSourceResult = { ok: true; value: SourceInput } | { ok: false; errors: SourceFieldErrors };

const MAX_TEXT = 200;

function inSet<T extends string>(set: readonly T[], v: string | undefined): v is T {
  return typeof v === 'string' && (set as readonly string[]).includes(v);
}

/**
 * Validate a raw form record (all values strings) into a typed SourceInput, or a
 * map of field→message errors. Pure: no DB, no side effects. Both the create and the
 * edit server actions run everything through here before touching the database, so the
 * DB CHECK/enum constraints are a backstop, never the first line of validation.
 */
export function parseSourceInput(raw: Record<string, string | undefined>): ParseSourceResult {
  const errors: SourceFieldErrors = {};

  const family = (raw.family ?? '').trim();
  const name = (raw.name ?? '').trim();
  const platformRaw = (raw.platform ?? '').trim();

  if (family.length === 0) errors.family = 'Family is required (e.g. "activenet", "manual").';
  else if (family.length > MAX_TEXT) errors.family = `Family must be ${MAX_TEXT} characters or fewer.`;

  if (name.length === 0) errors.name = 'Name is required.';
  else if (name.length > MAX_TEXT) errors.name = `Name must be ${MAX_TEXT} characters or fewer.`;

  if (platformRaw.length > MAX_TEXT) errors.platform = `Platform must be ${MAX_TEXT} characters or fewer.`;

  if (!inSet(AUTHORITY_TIERS, raw.authorityTier)) errors.authorityTier = 'Choose an authority tier.';
  if (!inSet(TERMS_STATUSES, raw.termsStatus)) errors.termsStatus = 'Choose a terms status.';
  if (!inSet(ROBOTS_STATUSES, raw.robotsStatus)) errors.robotsStatus = 'Choose a robots status.';
  if (!inSet(INGESTION_METHODS, raw.ingestionMethod)) errors.ingestionMethod = 'Choose an ingestion method.';
  if (!inSet(SEASON_STATES, raw.seasonState)) errors.seasonState = 'Choose a season state.';
  if (!inSet(HEALTH_STATES, raw.healthState)) errors.healthState = 'Choose a health state.';
  if (!inSet(CADENCE_OPTIONS, raw.baselineCadence)) errors.baselineCadence = 'Choose a baseline cadence.';

  const nearRaw = (raw.nearDateCadence ?? '').trim();
  let nearDateCadence: Cadence | null = null;
  if (nearRaw.length > 0) {
    if (!inSet(CADENCE_OPTIONS, nearRaw)) errors.nearDateCadence = 'Choose a valid near-date cadence or leave it blank.';
    else nearDateCadence = nearRaw;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      family,
      name,
      platform: platformRaw.length > 0 ? platformRaw : null,
      authorityTier: raw.authorityTier as AuthorityTier,
      termsStatus: raw.termsStatus as TermsStatus,
      robotsStatus: raw.robotsStatus as RobotsStatus,
      ingestionMethod: raw.ingestionMethod as IngestionMethod,
      seasonState: raw.seasonState as SeasonState,
      healthState: raw.healthState as HealthState,
      baselineCadence: raw.baselineCadence as Cadence,
      nearDateCadence,
    },
  };
}
