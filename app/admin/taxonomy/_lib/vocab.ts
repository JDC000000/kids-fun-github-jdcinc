// app/admin/taxonomy/_lib/vocab.ts — G-T34-4 no-code taxonomy console: the allowed
// value sets + pure form validators for the three editable entities (region, category,
// alias). PURE (no DB / no pg import) so it is safe to import from the client forms AND
// trivially unit-testable — the exact same posture as app/admin/sources/_lib/vocab.ts.
//
// The vocab mirrors the DB constraints in supabase/migrations/0005_taxonomy.sql:
//   • region.level  CHECK (level IN ('metro','municipality','sub_area'))
//   • category.key  UNIQUE, category.label NOT NULL, is_primary_eligible boolean
//   • synonym_alias exactly-one-target CHECK (canonical_category_id XOR canonical_tag_id),
//     UNIQUE (lower(alias_text))
// A DB drift test (tests/admin/taxonomy-vocab-db.test.ts) asserts every region level
// offered here is actually accepted by the column, so the console can never present a
// value the DB will reject.

const MAX_TEXT = 200;
const MAX_KEY = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Category key slug: lowercase letters/digits/underscore only — matches the seeded keys
 *  (open_gym, class_program, …) and what the live search resolver matches on. */
const CATEGORY_KEY_RE = /^[a-z0-9_]+$/;

export function isUuid(v: string | null | undefined): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

// ── Region ──────────────────────────────────────────────────────────────────
export const REGION_LEVELS = ['metro', 'municipality', 'sub_area'] as const;
export type RegionLevel = (typeof REGION_LEVELS)[number];

export interface RegionInput {
  name: string;
  level: RegionLevel;
  /** Parent region id (uuid) or null for a top-level region (e.g. the metro root). */
  parentId: string | null;
}

export type RegionFieldErrors = Partial<Record<keyof RegionInput, string>>;
export type ParseRegionResult = { ok: true; value: RegionInput } | { ok: false; errors: RegionFieldErrors };

function inSet<T extends string>(set: readonly T[], v: string | undefined): v is T {
  return typeof v === 'string' && (set as readonly string[]).includes(v);
}

/** Validate a raw region form into a typed RegionInput or field errors. Pure. */
export function parseRegionInput(raw: Record<string, string | undefined>): ParseRegionResult {
  const errors: RegionFieldErrors = {};

  const name = (raw.name ?? '').trim();
  if (name.length === 0) errors.name = 'Region name is required (e.g. "Burnaby").';
  else if (name.length > MAX_TEXT) errors.name = `Name must be ${MAX_TEXT} characters or fewer.`;

  if (!inSet(REGION_LEVELS, raw.level)) errors.level = 'Choose a level (metro / municipality / sub_area).';

  const parentRaw = (raw.parentId ?? '').trim();
  let parentId: string | null = null;
  if (parentRaw.length > 0) {
    if (!isUuid(parentRaw)) errors.parentId = 'Choose a valid parent region or leave it blank.';
    else parentId = parentRaw;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, level: raw.level as RegionLevel, parentId } };
}

// ── Category ────────────────────────────────────────────────────────────────
export interface CategoryInput {
  key: string;
  label: string;
  isPrimaryEligible: boolean;
}

export type CategoryFieldErrors = Partial<Record<keyof CategoryInput, string>>;
export type ParseCategoryResult = { ok: true; value: CategoryInput } | { ok: false; errors: CategoryFieldErrors };

/** Coerce an HTML checkbox value ('on'/'true'/'1' → true) to a boolean. */
export function parseCheckbox(v: string | undefined): boolean {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'on' || s === 'true' || s === '1' || s === 'yes';
}

/** Validate a raw category form into a typed CategoryInput or field errors. Pure. */
export function parseCategoryInput(raw: Record<string, string | undefined>): ParseCategoryResult {
  const errors: CategoryFieldErrors = {};

  const key = (raw.key ?? '').trim();
  if (key.length === 0) errors.key = 'Key is required (e.g. "open_gym").';
  else if (key.length > MAX_KEY) errors.key = `Key must be ${MAX_KEY} characters or fewer.`;
  else if (!CATEGORY_KEY_RE.test(key)) errors.key = 'Key may contain only lowercase letters, digits and underscores.';

  const label = (raw.label ?? '').trim();
  if (label.length === 0) errors.label = 'Label is required (e.g. "Open Gym").';
  else if (label.length > MAX_TEXT) errors.label = `Label must be ${MAX_TEXT} characters or fewer.`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { key, label, isPrimaryEligible: parseCheckbox(raw.isPrimaryEligible) } };
}

// ── Alias (synonym_alias) ─────────────────────────────────────────────────────
/** The canonical target of an alias — exactly one of a category or a tag (the DB
 *  synonym_alias_one_target CHECK enforces the XOR; this type makes it unrepresentable
 *  to supply both). */
export type AliasTarget = { kind: 'category'; id: string } | { kind: 'tag'; id: string };

export interface AliasInput {
  aliasText: string;
  target: AliasTarget;
}

export type AliasFieldErrors = { aliasText?: string; target?: string };
export type ParseAliasResult = { ok: true; value: AliasInput } | { ok: false; errors: AliasFieldErrors };

/** Encode a target as the form <option> value, e.g. 'category:<uuid>'. */
export function encodeAliasTarget(t: AliasTarget): string {
  return `${t.kind}:${t.id}`;
}

/** Parse a 'category:<uuid>' | 'tag:<uuid>' option value back into an AliasTarget, or null. */
export function decodeAliasTarget(raw: string | undefined): AliasTarget | null {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx < 0) return null;
  const kind = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (!isUuid(id)) return null;
  if (kind === 'category') return { kind: 'category', id };
  if (kind === 'tag') return { kind: 'tag', id };
  return null;
}

/** Validate a raw alias form into a typed AliasInput or field errors. Pure. */
export function parseAliasInput(raw: Record<string, string | undefined>): ParseAliasResult {
  const errors: AliasFieldErrors = {};

  const aliasText = (raw.aliasText ?? '').trim();
  if (aliasText.length === 0) errors.aliasText = 'Alias phrase is required (e.g. "family drop-in").';
  else if (aliasText.length > MAX_TEXT) errors.aliasText = `Alias must be ${MAX_TEXT} characters or fewer.`;

  const target = decodeAliasTarget(raw.target);
  if (!target) errors.target = 'Choose a canonical category or tag this alias maps to.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { aliasText, target: target! } };
}
