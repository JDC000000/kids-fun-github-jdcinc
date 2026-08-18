// lib/snapshot/policy.ts — THE snapshot allowlist. Single source of truth for what may
// leave a production database, and what happens to it on the way out.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// WHY AN ALLOWLIST AND NOT A SCRUBBER
// This product holds real personal data about children: `user_profile.saved_child_ages`
// (ages in months, per child) and `user_profile.google_identity` — the two columns
// scripts/pipeda-cleanup/ exists to clear. The catalogue, by contrast, is public
// information scraped from public municipal/library/rec-centre websites.
//
// The naive design is "dump everything, then scrub the PII". That design fails open: a
// migration adds a column, nobody updates the scrubber, and the column ships. The design
// here fails CLOSED — a table is not exported unless it appears in SNAPSHOT_TABLES below,
// and a COLUMN of an allowlisted table is not exported unless it has an explicit policy
// entry. A table that was never read cannot leak. That is the whole argument.
//
// The realistic remaining failure mode is therefore NOT "we forgot a table" (a forgotten
// table is simply absent) but "a migration added a PII column to a table that IS
// allowlisted". lib/snapshot/schema-guard.ts closes that: it diffs the live schema against
// this file and HARD FAILS on any unclassified column, any dropped column, and any column
// whose type changed. tests/snapshot/policy-schema-guard.test.ts runs that diff on every
// CI run against the migrated CI database, so the alarm fires at PR time — before anyone
// has a chance to point the export tool at production.
//
// WHAT IS DELIBERATELY *NOT* ANONYMISED
// Date/time columns, age columns and region identifiers are preserved BYTE-FAITHFULLY.
// They are the entire point: the bugs this snapshot exists to catch are data-shape bugs in
// exactly those fields (a timestamp with an unexpected offset, an age range the band
// mapper does not cover, a region id with no parent). An anonymiser that buckets dates or
// jitters ages would destroy the signal and leave a snapshot that is merely a slower
// fixture. See SCRUB ACTIONS below — `preserve` is a positive assertion, not a default.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What the export does to a column's value.
 *
 * `preserve`          — emitted verbatim. Asserted (by the verifier) to contain no email,
 *                       no URL credentials and no formatted phone number.
 * `redact_prose`      — scraped long-form text. Aggressive pass: emails, phone numbers,
 *                       Canadian postal codes, URL credentials, and the
 *                       "Contact/Instructor/Ask for <Name>" heuristic.
 * `redact_title`      — scraped titles and short labels. redact_contact plus a NARROW
 *                       person heuristic ("register with <Name>", "ask for <Name>"). Role
 *                       words like "Coach"/"Host" survive because they carry FTS weight-A
 *                       search meaning; see lib/snapshot/scrub.ts for the full argument.
 * `redact_contact`    — addresses and URLs. Conservative pass: emails, phone numbers, URL
 *                       credentials only. Postal codes and proper nouns are KEPT here on
 *                       purpose — a public venue's street address is public catalogue data
 *                       and geo/region tests depend on its exact shape.
 * `placeholder_phone` — replaced with a fixed fictitious number that preserves the
 *                       original's punctuation and digit count. Nullness and formatting
 *                       variety survive (both are rendered); the actual number does not.
 * `placeholder_token` — non-null becomes the constant '[redacted]', null stays null. Keeps
 *                       the is-it-set shape, keeps nothing else.
 * `derived_drop`      — not exported at all; the target database recomputes it on load.
 *
 * None of these are reversible. There is no keyed pseudonymisation anywhere in this
 * pipeline, deliberately: a key that can be reproduced is a key that can be stolen, and
 * a 10-digit phone space falls to brute force the moment the salt is known.
 */
export type ScrubAction =
  | 'preserve'
  | 'redact_prose'
  | 'redact_title'
  | 'redact_contact'
  | 'placeholder_phone'
  | 'placeholder_token'
  | 'derived_drop';

export interface ColumnPolicy {
  readonly action: ScrubAction;
  /** Why this column is treated this way. Quoted into the runbook; not decoration. */
  readonly why: string;
}

export interface TablePolicy {
  readonly table: string;
  /** Why this table is safe to export at all. */
  readonly why: string;
  /** Single-column primary key. Drives keyset pagination, so the export is deterministic. */
  readonly key: string;
  /**
   * Columns that reference this same table. Loaded in a second pass (insert with the column
   * NULL, then UPDATE), because a self-referencing FK cannot be satisfied by any single row
   * ordering and none of the schema's FKs are DEFERRABLE.
   */
  readonly selfRefColumns?: readonly string[];
  readonly columns: Readonly<Record<string, ColumnPolicy>>;
}

const P = (why: string): ColumnPolicy => ({ action: 'preserve', why });
const ID = (ref: string): ColumnPolicy => ({
  action: 'preserve',
  why: `Catalogue identifier (${ref}). Preserved so referential integrity, unique keys and cross-snapshot diffs survive the round trip. Not a user identifier.`,
});
const TIME = (what: string): ColumnPolicy => ({
  action: 'preserve',
  why: `PRESERVED FAITHFULLY — ${what}. Timestamp drift is a target of this snapshot, not noise to be smoothed.`,
});

/**
 * The allowlist, in FK-safe load order. Everything not in this list is excluded — see
 * EXCLUDED_TABLES for the ones we have actually reasoned about.
 */
export const SNAPSHOT_TABLES: readonly TablePolicy[] = [
  {
    table: 'region',
    why: 'Metro Vancouver region hierarchy (metro → municipality → sub_area). Public geography. Region ids are the join key half the search filters turn on, so drift here is exactly what we are hunting.',
    key: 'id',
    selfRefColumns: ['parent_id'],
    columns: {
      id: ID('region.id'),
      name: P('PRESERVED FAITHFULLY — public place name; the region label users filter by.'),
      level: P('PRESERVED FAITHFULLY — metro/municipality/sub_area; drives RegionHierarchy.'),
      parent_id: P('PRESERVED FAITHFULLY — hierarchy edge. A null parent on a non-metro region is a real drift bug.'),
      created_at: TIME('reference-data provenance'),
      centroid: P('PRESERVED FAITHFULLY — PostGIS centroid; distance/radius search reads it. Public place coordinate.'),
    },
  },
  {
    table: 'category',
    why: 'Taxonomy. Ships in supabase/seeds/categories_tags.sql — public by construction.',
    key: 'id',
    columns: {
      id: ID('category.id'),
      key: P('Taxonomy key; the search read model maps on it.'),
      label: P('Taxonomy label; feeds the FTS weight-B vector.'),
      is_primary_eligible: P('Taxonomy flag.'),
      created_at: TIME('reference-data provenance'),
    },
  },
  {
    table: 'tag',
    why: 'Taxonomy. Ships in supabase/seeds/categories_tags.sql — public by construction.',
    key: 'id',
    columns: {
      id: ID('tag.id'),
      key: P('Taxonomy key.'),
      label: P('Taxonomy label; feeds the FTS weight-B vector.'),
      tag_type: P('Taxonomy enum.'),
      created_at: TIME('reference-data provenance'),
    },
  },
  {
    table: 'age_band',
    why: 'The five non-overlapping age bands. Reference data, no personal content — these are the PRODUCT\'s bands, not any child\'s age.',
    key: 'id',
    columns: {
      id: ID('age_band.id'),
      key: P('PRESERVED FAITHFULLY — under2/2-4/5-9/10-14/15+.'),
      lower_months_inclusive: P('PRESERVED FAITHFULLY — band bound in months. Age-mapping drift is a target of this snapshot.'),
      upper_months_exclusive: P('PRESERVED FAITHFULLY — band bound in months; null = open-ended (15+).'),
      created_at: TIME('reference-data provenance'),
    },
  },
  {
    table: 'synonym_alias',
    why: 'Query-expansion vocabulary. Ships in supabase/seeds/synonym_alias.sql.',
    key: 'id',
    columns: {
      id: ID('synonym_alias.id'),
      alias_text: P('Search vocabulary term. Operator/seed authored, not user authored.'),
      canonical_category_id: ID('category.id'),
      canonical_tag_id: ID('tag.id'),
      created_at: TIME('reference-data provenance'),
    },
  },
  {
    table: 'source',
    why: 'The scraped-source registry (which public website each listing came from) plus its health/cadence state. Public sites, operator-run schedule.',
    key: 'id',
    columns: {
      id: ID('source.id'),
      family: P('Adapter family key.'),
      name: P('Public source name (e.g. a library system or municipality).'),
      authority_tier: P('Registry enum; feeds confidence labelling.'),
      terms_status: P('Registry enum. Load-bearing: migration 0021 refuses a confirmed occurrence against a non-approved source, so this must survive to reproduce that invariant.'),
      robots_status: P('Registry enum.'),
      platform: P('Platform name (ActiveNet, BiblioCommons, …).'),
      publication_horizon: P('Interval; feeds season/staleness logic.'),
      baseline_cadence: P('Interval; scheduler cadence.'),
      near_date_cadence: P('Interval; scheduler cadence.'),
      season_state: P('Registry enum.'),
      health_state: P('Registry enum.'),
      ingestion_method: P('Registry enum.'),
      last_check_at: TIME('scheduler freshness; staleness SLAs are computed from it'),
      next_check_at: TIME('scheduler freshness'),
      created_at: TIME('registry provenance'),
      updated_at: TIME('registry provenance'),
      robots_override_decision: P('Short controlled token (0023 constrains its shape). Nullness is load-bearing for the 0022 constraints.'),
      robots_override_note: {
        action: 'placeholder_token',
        why: 'Operator-authored free text — the realistic place a human writes "spoke to <person> at <organisation>". Nothing reads its content; the 0022 CHECK only cares whether it is set, so a constant placeholder keeps every constraint reproducible and keeps the prose out.',
      },
    },
  },
  {
    table: 'venue',
    why: 'Public places: libraries, community centres, pools, parks. Addresses and coordinates are published by the venues themselves.',
    key: 'id',
    columns: {
      id: ID('venue.id'),
      name: { action: 'redact_title', why: 'Public building name, and an FTS weight-C term. Title-strength redaction: a home-based provider can appear here as "Ask for Priya" with a phone appended, but "Community Centre" must survive intact.' },
      address: { action: 'redact_contact', why: 'Public street address. Postal codes and proper nouns are deliberately KEPT — geo/region tests read the exact shape. Only emails/phones/URL credentials embedded in the string are removed.' },
      municipality_id: P('PRESERVED FAITHFULLY — region FK. Region identity is a target of this snapshot.'),
      neighbourhood: P('PRESERVED FAITHFULLY — public sub-area label used by area filters.'),
      display_area: P('PRESERVED FAITHFULLY — public area label rendered in results.'),
      accessibility_notes: { action: 'redact_prose', why: 'Scraped prose. Most likely catalogue field to carry an incidental "call Jane at …".' },
      official_url: { action: 'redact_contact', why: 'Public URL. Redactor strips any embedded credentials or mailto address.' },
      created_at: TIME('catalogue provenance'),
      updated_at: TIME('catalogue provenance'),
      geo: P('PRESERVED FAITHFULLY — PostGIS point of a public building. Distance/radius search reads it.'),
      phone: {
        action: 'placeholder_phone',
        why: 'Usually a public front-desk line, but a home-based provider\'s personal mobile is indistinguishable from one. Replaced with a fictitious number that keeps the original punctuation and digit count, so null-vs-set and formatting variety (both rendered on the detail page) still drift-test.',
      },
      geo_authority: P('Geo provenance tier (smallint).'),
      geo_source: P('Geo provenance source key.'),
      geo_attribution: P('Geo provenance attribution string (licence text).'),
      geo_set_at: TIME('geo provenance'),
    },
  },
  {
    table: 'activity_series',
    why: 'The recurring-program identity behind occurrences. Scraped from public program listings.',
    key: 'id',
    columns: {
      id: ID('activity_series.id'),
      canonical_title: { action: 'redact_title', why: 'Scraped program title; feeds search. Title-strength redaction — the broad prose heuristic would eat legitimate title words like "Coach" or "Host", which carry FTS weight-A meaning.' },
      recurrence_rule: P('RRULE string. PRESERVED FAITHFULLY — recurrence expansion is time-shape logic.'),
      source_id: ID('source.id'),
      venue_id: ID('venue.id'),
      season_state: P('Enum; season logic.'),
      default_primary_category: ID('category.id'),
      default_tags: P('uuid[] of tag ids.'),
      created_at: TIME('catalogue provenance'),
      updated_at: TIME('catalogue provenance'),
    },
  },
  {
    table: 'activity_occurrence',
    why: 'THE table this whole exercise is for — one row per dated activity. Every search result is one of these. Scraped from public listings.',
    key: 'id',
    columns: {
      id: ID('activity_occurrence.id'),
      series_id: ID('activity_series.id'),
      activity_name: { action: 'redact_title', why: 'Scraped listing title; FTS weight A. Title-strength redaction — the broad prose heuristic would eat legitimate title words.' },
      description_snippet: { action: 'redact_prose', why: 'Scraped free text; FTS weight D. THE most likely carrier of incidental personal data in the catalogue — registration contacts, instructor names, phone numbers.' },
      primary_category_id: ID('category.id'),
      start_datetime_utc: TIME('the occurrence start. Tonight\'s bug class lives here'),
      end_datetime_utc: TIME('the occurrence end'),
      open_hours_state: { action: 'redact_title', why: 'Scraped standing-hours sentence ("Daily 10:00 AM–5:00 PM"). Rendered verbatim for dateless rows, so its exact shape matters; title-strength redaction.' },
      cost_min_cad: P('PRESERVED FAITHFULLY — numeric(10,2); cost banding and the free/unknown honesty rules read it.'),
      cost_max_cad: P('PRESERVED FAITHFULLY — numeric(10,2).'),
      cost_status: P('Enum; BR-11 honesty rules.'),
      source_url: { action: 'redact_contact', why: 'Public listing URL. Redactor strips embedded credentials.' },
      booking_url: { action: 'redact_contact', why: 'Public booking URL. Redactor strips embedded credentials.' },
      location_url: { action: 'redact_contact', why: 'Public map/location URL. Redactor strips embedded credentials.' },
      status_state: P('Enum — all 16 launch states. Drift here (a state the app does not render) is a target.'),
      confidence_label: P('Enum; confidence rendering.'),
      last_checked_at: TIME('freshness; the staleness SLA and confidence decay read it'),
      next_check_at: TIME('scheduler freshness'),
      archived_at: TIME('soft-delete marker; visibility predicates read it'),
      created_at: TIME('catalogue provenance'),
      updated_at: TIME('catalogue provenance'),
      search_tsv: {
        action: 'derived_drop',
        why: 'Derived. Not exported for two reasons: it is a lexeme index of the PRE-scrub description (so exporting it would leak exactly what the scrub removed), and the 0010 triggers recompute it on insert. Recomputation on load also proves the trigger chain still works.',
      },
      source_record_id: P('Upstream public record id; the dedup/upsert key half.'),
      dedup_key: P('Deterministic dedup key. Preserved so the 0015 unique index is exercised for real.'),
      registration_required: P('Tri-state boolean (null = unstated). Null-vs-false is a live rendering distinction and a real drift risk.'),
    },
  },
  {
    table: 'occurrence_age',
    why: 'The AGE SUITABILITY OF AN ACTIVITY — i.e. "this program is for 5–9 year olds". This is a property of a public listing. It is NOT and must not be confused with user_profile.saved_child_ages, which is a real child\'s age and is never exported.',
    key: 'occurrence_id',
    columns: {
      occurrence_id: ID('activity_occurrence.id'),
      age_min_months: P('PRESERVED FAITHFULLY — the published lower age bound of a public program. Age-band mapping drift is a primary target of this snapshot.'),
      age_max_months: P('PRESERVED FAITHFULLY — the published upper age bound of a public program.'),
      age_band_matches: P('PRESERVED FAITHFULLY — uuid[] of age_band ids the row maps to. The exact array whose drift we are trying to catch.'),
      age_notes: { action: 'redact_prose', why: 'Scraped free text next to the age range ("ages 5-9, ask for Jane"). Aggressive pass; the numeric bounds above are untouched.' },
    },
  },
  {
    table: 'occurrence_category_tag',
    why: 'Pure join table (occurrence ↔ category/tag). No free text at all.',
    key: 'id',
    columns: {
      id: ID('occurrence_category_tag.id'),
      occurrence_id: ID('activity_occurrence.id'),
      category_id: ID('category.id'),
      tag_id: ID('tag.id'),
      tag_type: P('Enum discriminator.'),
    },
  },
  {
    table: 'provenance',
    why: 'Which public URL each catalogue fact came from. Read by lib/llm/dedup-merge.ts and the activity detail page, so a snapshot without it under-exercises both.',
    key: 'id',
    columns: {
      id: ID('provenance.id'),
      occurrence_id: ID('activity_occurrence.id'),
      field: P('Name of the occurrence field this row vouches for.'),
      source_url: { action: 'redact_contact', why: 'Public page URL. Redactor strips embedded credentials.' },
      source_family: P('Adapter family key.'),
      fetched_at: TIME('when the fact was observed; freshness logic reads it'),
      fact_origin: P('Enum: source / llm_normalised / manual_override.'),
    },
  },
];

/**
 * Tables we have looked at and deliberately do NOT export, with the reason. Deny-by-default
 * means a table missing from BOTH lists is still excluded — this map exists so a reviewer can
 * see the reasoning, and so schema-guard can tell "new and unreviewed" from "reviewed and out".
 */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  // ── Direct personal data. Never exported under any circumstances. ──────────────────
  user_profile:
    'PII — CHILDREN. saved_child_ages holds real children\'s ages in months and google_identity holds a real Google account email; home_postal/home_geo locate a household. This is the table scripts/pipeda-cleanup/ exists to clear. Never exported.',
  saved_search:
    'PII — query_json is a real person\'s saved search: their neighbourhood, their children\'s ages, their schedule. user_id ties every row to an identity. Never exported.',
  admin_user: 'PII — maps real people to privileged roles. Never exported.',
  admin_audit_log:
    'PII — before_json/after_json snapshot arbitrary row content (including user rows) alongside the acting admin\'s id. Never exported.',
  weekly_email_send: 'PII — per-user send log (user_id + resend_id). Never exported.',
  correction_report:
    'PII — user-submitted. `reporter` is a user id or anon session id and `note` is free text a member of the public typed. Never exported.',
  analytics_event:
    'PII — `user_or_session` is a per-person identifier and `search_context_json` records what real people typed into the search box. Never exported.',

  // ── No PII of consequence, but excluded by deny-by-default: nothing needs them. ────
  organisation:
    'Has a literal `contact` free-text column, and grep shows ZERO readers or writers anywhere in app/, lib/ or worker/. A table nothing uses is a table with no reason to accept the risk.',
  source_check_run:
    'Ops telemetry. `errors` (jsonb) and `health_alert_detail` capture raw upstream failure payloads — arbitrary scraped bytes, response bodies, sometimes URLs with tokens. Not catalogue data; the search suites do not read it.',
  dedup_pair_adjudication:
    'Operational adjudication log. `decided_by` is an admin user id and `note` is operator prose.',
  job_queue: 'Transient scheduler state (locked_by, last_error). Not catalogue data; the suites mint their own.',
  global_job_schedule: 'Operator-run schedule state, not catalogue data.',
  global_job_run: 'Operator-run job history (enqueued_by/claimed_by/error). Not catalogue data.',
  llm_batch_run: 'LLM job watermarks. Operational.',
  llm_batch_decision: 'LLM decision log; `detail` (jsonb) carries raw model payloads. Operational.',
  app_meta: 'Operational key/value config. Carries no data shape worth testing and may hold environment-specific values.',
  schema_migrations:
    'Not exported AS DATA — but its (version, checksum) list IS captured in the snapshot manifest as the schema fingerprint, which is what lets the loader refuse a snapshot taken against a different schema.',
  spatial_ref_sys: 'PostGIS internal, created by the extension on both ends.',
};

/** Column names exported for a table, in policy order (i.e. excluding `derived_drop`). */
export function exportedColumns(t: TablePolicy): string[] {
  return Object.entries(t.columns)
    .filter(([, p]) => p.action !== 'derived_drop')
    .map(([name]) => name);
}

/** Every column with a policy, including dropped ones — this is what schema-guard diffs against. */
export function classifiedColumns(t: TablePolicy): string[] {
  return Object.keys(t.columns);
}

export function tablePolicy(table: string): TablePolicy | undefined {
  return SNAPSHOT_TABLES.find((t) => t.table === table);
}

export const ALLOWLISTED_TABLES: readonly string[] = SNAPSHOT_TABLES.map((t) => t.table);

/**
 * A stable digest of the policy itself, stamped into every snapshot manifest. If the policy
 * changes, snapshots taken under the old one are visibly older — you can tell whether a file
 * on disk predates a scrub-rule tightening without re-reading it.
 */
export function policyFingerprint(): string {
  return JSON.stringify(
    SNAPSHOT_TABLES.map((t) => [t.table, Object.entries(t.columns).map(([c, p]) => [c, p.action])])
  );
}
