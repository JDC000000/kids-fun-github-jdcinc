// worker/core/taxonomy.ts — deterministic category scaffolding for structured ingest.
// Full T13 normalisation later handles ambiguous free-text. This file only maps
// clear structured hints/title words into the launch primary category keys so
// approved official-source records can be surfaced without remaining hidden as
// needs_review.
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

export function primaryCategoryKeyForRecord(record: Pick<StructuredRecord, 'title' | 'categoryHint'>): string {
  const hinted = record.categoryHint?.trim().toLowerCase();
  if (hinted && VALID_PRIMARY_CATEGORY_KEYS.has(hinted)) return hinted;

  const title = record.title.toLowerCase();
  if (/story\s*time|babytime|toddler\s*time/.test(title)) return 'storytime';
  if (/duplo|lego|free\s+play|play\s+time|indoor\s+play/.test(title)) return 'indoor_play';
  if (/swim|pool/.test(title)) return 'public_swim';
  if (/skate|skating/.test(title)) return 'skate';
  if (/open\s+gym|gymnasium/.test(title)) return 'open_gym';
  if (/park|nature|farm|trail/.test(title)) return 'outdoor_park';
  if (/festival|special\s+event/.test(title)) return 'festival_event';
  if (/museum|gallery|exhibit/.test(title)) return 'museum_venue';
  return 'class_program';
}

export async function resolvePrimaryCategoryId(pool: Pool, record: StructuredRecord): Promise<string | null> {
  const key = primaryCategoryKeyForRecord(record);
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM category WHERE key = $1 AND is_primary_eligible = true LIMIT 1`,
    [key]
  );
  return rows[0]?.id ?? null;
}
