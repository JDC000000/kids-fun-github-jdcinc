// worker/core/taxonomy.ts — deterministic category scaffolding for structured ingest.
// Full T13 normalisation later handles ambiguous free-text. This file only maps
// clear structured hints/title words into the launch primary category keys so
// approved official-source records can be surfaced without remaining hidden as
// needs_review, while keeping generic fallback categories at medium confidence.
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

type CategoryCertainty = 'specific' | 'generic';

export interface PrimaryCategoryClassification {
  key: string;
  certainty: CategoryCertainty;
}

export function classifyPrimaryCategory(record: Pick<StructuredRecord, 'title' | 'categoryHint'>): PrimaryCategoryClassification {
  const hinted = record.categoryHint?.trim().toLowerCase();
  const title = record.title.toLowerCase();

  if (hinted && VALID_PRIMARY_CATEGORY_KEYS.has(hinted)) {
    return { key: hinted, certainty: hinted === 'class_program' && !isSpecificClassProgram(title) ? 'generic' : 'specific' };
  }

  if (/story\s*time|babytime|toddler\s*time/.test(title)) return { key: 'storytime', certainty: 'specific' };
  if (/duplo|lego|free\s+play|play\s+time|indoor\s+play/.test(title)) return { key: 'indoor_play', certainty: 'specific' };
  if (/swim|pool/.test(title)) return { key: 'public_swim', certainty: 'specific' };
  if (/skate|skating/.test(title)) return { key: 'skate', certainty: 'specific' };
  if (/open\s+gym|gymnasium/.test(title)) return { key: 'open_gym', certainty: 'specific' };
  if (/park|nature|farm|trail/.test(title)) return { key: 'outdoor_park', certainty: 'specific' };
  if (/festival|special\s+event/.test(title)) return { key: 'festival_event', certainty: 'specific' };
  if (/museum|gallery|exhibit/.test(title)) return { key: 'museum_venue', certainty: 'specific' };
  if (isSpecificClassProgram(title)) return { key: 'class_program', certainty: 'specific' };
  return { key: 'class_program', certainty: 'generic' };
}

export function primaryCategoryKeyForRecord(record: Pick<StructuredRecord, 'title' | 'categoryHint'>): string {
  return classifyPrimaryCategory(record).key;
}

export function confidenceLabelForCategory(record: Pick<StructuredRecord, 'title' | 'categoryHint'>): 'high' | 'medium' {
  return classifyPrimaryCategory(record).certainty === 'specific' ? 'high' : 'medium';
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
