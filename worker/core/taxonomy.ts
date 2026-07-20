// worker/core/taxonomy.ts — deterministic category scaffolding for structured ingest.
// Full T13 normalisation later handles ambiguous free-text. This file only maps
// clear structured hints/title words into the launch category keys so approved
// official-source records can be surfaced with a real primary category AND the
// secondary categories + suitability tags that make them findable.
//
// Two write-side responsibilities:
//   1. classifyPrimaryCategory → ONE primary_category_id on activity_occurrence
//      (resolvePrimaryCategoryId; written by the upsert). It also exposes the
//      certainty/source of that decision, which feeds the BR-13 confidence
//      formula's parse-quality signal (see worker/core/confidence.ts).
//   2. G-T13-3: classifySecondaryCategories + classifySuitabilityTags →
//      additional rows in occurrence_category_tag (migration 0005). The join
//      table, its FTS re-index trigger (0010) and the read side
//      (lib/search/postgres-repository.ts) already exist/consume it; until now
//      NOTHING in the ingest path ever populated it, so secondary categories and
//      suitability tags were only derivable ad hoc from the primary key at query
//      time. applyOccurrenceCategoryTags() closes that write-side gap.
//
// The primary classifier and the multi-match secondary detector share ONE rule
// table (CATEGORY_SIGNAL_RULES) so they can never drift apart. Patterns are
// leading-\b anchored so a category word only matches at a word start ("swim",
// "swimming", "pools") and not embedded in an unrelated word ("Liverpool",
// "Sparks", "signature").
import type { Pool } from 'pg';
import type { StructuredRecord } from './adapter';

const VALID_PRIMARY_CATEGORY_KEYS = new Set([
  'open_gym',
  'public_swim',
  'skate',
  'storytime',
  'indoor_play',
  'museum_venue',
  'attraction',
  'festival_event',
  'outdoor_park',
  'class_program',
]);

interface SignalRule {
  key: string;
  test: RegExp;
}

// Ordered category-signal rules — the single source of truth for both the primary
// classifier (first primary-eligible match wins) and the secondary detector
// (every match). Order == priority. The last two keys (miniature_train,
// tobogganing) are is_primary_eligible=false in the seed: never a primary, but a
// legitimate secondary facet when the title mentions them.
const CATEGORY_SIGNAL_RULES: SignalRule[] = [
  { key: 'storytime', test: /story\s*time|babytime|toddler\s*time/ },
  { key: 'indoor_play', test: /duplo|lego|free\s+play|play\s+time|indoor\s+play/ },
  { key: 'public_swim', test: /\bswim|\bpool/ },
  { key: 'skate', test: /\bskat(e|ing)/ },
  { key: 'open_gym', test: /open\s+gym|gymnasium/ },
  { key: 'outdoor_park', test: /\bpark|\bnature|\bfarm|\btrail/ },
  { key: 'festival_event', test: /festival|special\s+event/ },
  { key: 'museum_venue', test: /museum|gallery|exhibit/ },
  { key: 'miniature_train', test: /miniature\s*train|mini\s*train/ },
  { key: 'tobogganing', test: /toboggan|tubing|sledding|sled\s+hill/ },
];

const SUITABILITY_TAG_RULES: SignalRule[] = [
  { key: 'drop_in', test: /drop[\s-]?in|no\s+registration|no\s+booking|just\s+show\s+up/ },
  { key: 'stroller_friendly', test: /stroller|babytime|\bbaby\b|infant/ },
  { key: 'accessible', test: /accessible|wheelchair|adaptive/ },
  { key: 'outdoor', test: /outdoor|\bpark|\btrail|\bnature|playground/ },
  { key: 'indoor', test: /indoor|gymnasium/ },
];

type CategoryCertainty = 'specific' | 'generic';

/** Where the primary-category decision came from — the strength of the signal.
 *  Consumed by confidence.ts parse-quality: an explicit structured `hint` is the
 *  strongest signal, a matched `title_rule` is medium, the generic `fallback` is
 *  the weakest (we had to guess). */
export type CategorySource = 'hint' | 'title_rule' | 'fallback';

export interface PrimaryCategoryClassification {
  key: string;
  certainty: CategoryCertainty;
  source: CategorySource;
}

/** Every category key whose rule matches `text`, in priority order, deduped. */
function matchCategoryRules(text: string): string[] {
  const keys: string[] = [];
  for (const rule of CATEGORY_SIGNAL_RULES) {
    if (rule.test.test(text) && !keys.includes(rule.key)) keys.push(rule.key);
  }
  return keys;
}

export function classifyPrimaryCategory(record: Pick<StructuredRecord, 'title' | 'categoryHint'>): PrimaryCategoryClassification {
  const hinted = record.categoryHint?.trim().toLowerCase();
  const title = record.title.toLowerCase();

  if (hinted && VALID_PRIMARY_CATEGORY_KEYS.has(hinted)) {
    const certainty: CategoryCertainty =
      hinted === 'class_program' && !isSpecificClassProgram(title) ? 'generic' : 'specific';
    return { key: hinted, certainty, source: 'hint' };
  }

  // Primary uses the title only (a free-text hint that wasn't a valid category key
  // is not authoritative enough to set the primary) — first primary-eligible match.
  const primary = matchCategoryRules(title).find((k) => VALID_PRIMARY_CATEGORY_KEYS.has(k));
  if (primary) return { key: primary, certainty: 'specific', source: 'title_rule' };

  if (isSpecificClassProgram(title)) return { key: 'class_program', certainty: 'specific', source: 'title_rule' };
  return { key: 'class_program', certainty: 'generic', source: 'fallback' };
}

export function primaryCategoryKeyForRecord(record: Pick<StructuredRecord, 'title' | 'categoryHint'>): string {
  return classifyPrimaryCategory(record).key;
}

export async function resolvePrimaryCategoryId(pool: Pool, record: StructuredRecord): Promise<string | null> {
  const key = primaryCategoryKeyForRecord(record);
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM category WHERE key = $1 AND is_primary_eligible = true LIMIT 1`,
    [key]
  );
  return rows[0]?.id ?? null;
}

function isSpecificClassProgram(title: string): boolean {
  return /workshop|club|class|robot|robotics|steam|craft|lesson|program/.test(title);
}

// ── G-T13-3: secondary categories + suitability tags ──────────────────────────
// The primary classifier is first-match-wins (one winner). Real occurrences often
// carry MORE than one genuine category signal — a "Family Swim & Open Gym Drop-in"
// is primarily a swim but is ALSO an open-gym session. detectCategorySignals is
// the multi-match version over the SAME rule table, considering title + hint.
function signalText(record: Pick<StructuredRecord, 'title' | 'categoryHint'>): string {
  return `${record.title} ${record.categoryHint ?? ''}`.toLowerCase();
}

/** Every category the record genuinely signals, priority order, deduped. An
 *  explicit valid hint always counts even if no regex fired. */
export function detectCategorySignals(record: Pick<StructuredRecord, 'title' | 'categoryHint'>): string[] {
  const keys: string[] = [];
  const hint = record.categoryHint?.trim().toLowerCase();
  if (hint && VALID_PRIMARY_CATEGORY_KEYS.has(hint)) keys.push(hint);
  for (const key of matchCategoryRules(signalText(record))) {
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Secondary categories = every genuine category signal EXCEPT the primary. */
export function classifySecondaryCategories(record: Pick<StructuredRecord, 'title' | 'categoryHint'>): string[] {
  const primary = primaryCategoryKeyForRecord(record);
  return detectCategorySignals(record).filter((k) => k !== primary);
}

/** Suitability tags (tag_type='suitability') the record genuinely signals. `free`
 *  is a structured-cost signal (not a title word); category-implied indoor mirrors
 *  the read-side heuristic in lib/search/postgres-repository.ts so the write side
 *  now records what that heuristic used to derive ad hoc at query time. */
export function classifySuitabilityTags(
  record: Pick<StructuredRecord, 'title' | 'categoryHint' | 'costStatus'>
): string[] {
  const text = signalText(record);
  const tags: string[] = [];
  for (const rule of SUITABILITY_TAG_RULES) {
    if (rule.test.test(text) && !tags.includes(rule.key)) tags.push(rule.key);
  }
  if (record.costStatus === 'free' && !tags.includes('free')) tags.push('free');
  const primary = primaryCategoryKeyForRecord(record);
  if ((primary === 'storytime' || primary === 'indoor_play') && !tags.includes('indoor')) tags.push('indoor');
  return tags;
}

export interface CategoryTagWriteResult {
  secondaryCategories: number;
  suitabilityTags: number;
}

/**
 * G-T13-3: persist an occurrence's secondary categories + suitability tags into
 * occurrence_category_tag. The primary category stays on
 * activity_occurrence.primary_category_id (written by upsertOccurrence); THIS
 * writes the *additional* facets alongside it.
 *
 * Idempotent: ON CONFLICT DO NOTHING against the partial unique indexes
 * (idx_occurrence_category_tag_cat_unique / _tag_unique), so re-ingesting the
 * same record never duplicates or accumulates rows. Classification is
 * deterministic from the title/hint, so the recorded set is stable across runs —
 * append-with-dedup mirrors how primary_category_id is COALESCE-updated rather
 * than churned. The 0010 FTS trigger re-indexes the occurrence on each inserted
 * suitability tag automatically.
 */
export async function applyOccurrenceCategoryTags(
  pool: Pool,
  occurrenceId: string,
  record: Pick<StructuredRecord, 'title' | 'categoryHint' | 'costStatus'>
): Promise<CategoryTagWriteResult> {
  const secondaryKeys = classifySecondaryCategories(record);
  const suitabilityKeys = classifySuitabilityTags(record);

  let secondaryCategories = 0;
  if (secondaryKeys.length > 0) {
    const { rowCount } = await pool.query(
      `INSERT INTO occurrence_category_tag (occurrence_id, category_id, tag_type)
       SELECT $1, c.id, 'category'
       FROM category c
       WHERE c.key = ANY($2::text[])
       ON CONFLICT (occurrence_id, category_id) WHERE category_id IS NOT NULL DO NOTHING`,
      [occurrenceId, secondaryKeys]
    );
    secondaryCategories = rowCount ?? 0;
  }

  let suitabilityTags = 0;
  if (suitabilityKeys.length > 0) {
    const { rowCount } = await pool.query(
      `INSERT INTO occurrence_category_tag (occurrence_id, tag_id, tag_type)
       SELECT $1, t.id, t.tag_type
       FROM tag t
       WHERE t.key = ANY($2::text[]) AND t.tag_type = 'suitability'
       ON CONFLICT (occurrence_id, tag_id) WHERE tag_id IS NOT NULL DO NOTHING`,
      [occurrenceId, suitabilityKeys]
    );
    suitabilityTags = rowCount ?? 0;
  }

  return { secondaryCategories, suitabilityTags };
}
