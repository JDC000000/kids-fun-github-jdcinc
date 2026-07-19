// app/admin/taxonomy/_lib/data.ts — G-T34-4 no-code taxonomy console: the DB read +
// write model for regions, categories and aliases. SERVER-ONLY (imports the pg service
// pool) — never import this from a client component; the client forms import pure values
// from ./vocab instead.
//
// Every write goes through withAdminTransaction + writeAdminAudit (the Round-19 helpers,
// reused verbatim) so the taxonomy-row change and its admin_audit_log entry commit
// atomically — no un-audited admin change.
//
// ── QUERY-TIME PROPAGATION (the alias AC) ──────────────────────────────────────
// The live search route (app/api/search/route.ts, database backend) reads the alias
// dictionary and region hierarchy through short in-process TTL caches
// (lib/search/postgres-alias-resolver.ts, lib/search/postgres-region-hierarchy.ts;
// default 60s). Alias text is NEVER baked into listing vectors — expansion is applied
// at QUERY TIME (lib/search/expand.ts), so an operator edit needs no bulk re-index.
// To make an edit apply IMMEDIATELY (not up to one TTL later), each alias/region
// mutation clears the matching resolver cache after the transaction commits; the very
// next search reloads the changed row from the DB. In a single Node process (local dev
// and single-node/PM2 production, where the action and the /api/search route share the
// module instance) this is instant; in a multi-instance serverless deploy the TTL
// (≤60s) bounds propagation on the other instances. Either way: no re-index, no restart.
//
// ── AUDIT ACTION VERBS ─────────────────────────────────────────────────────────
// admin_audit_log.action is a free-text column. To keep this stream strictly within its
// scope boundary (taxonomy/qa-queue + tests only) and avoid editing the shared
// lib/admin/audit.ts constant set that sibling streams also touch, the taxonomy verbs
// are declared LOCALLY here and passed to the shared writeAdminAudit(action: string).
import type { PoolClient } from 'pg';
import { query } from '@/lib/db/client';
import { writeAdminAudit, withAdminTransaction } from '@/lib/admin/audit';
import { clearPostgresAliasResolverCache } from '@/lib/search/postgres-alias-resolver';
import { clearPostgresRegionHierarchyCache } from '@/lib/search/postgres-region-hierarchy';
import type { CategoryInput, RegionInput, AliasInput } from './vocab';

/** Taxonomy audit verbs (local to this stream — see file header). */
export const TAXONOMY_AUDIT_ACTIONS = {
  REGION_CREATE: 'region.create',
  REGION_UPDATE: 'region.update',
  CATEGORY_CREATE: 'category.create',
  CATEGORY_UPDATE: 'category.update',
  ALIAS_CREATE: 'alias.create',
  ALIAS_UPDATE: 'alias.update',
  ALIAS_DELETE: 'alias.delete',
} as const;

// ── shared helpers ────────────────────────────────────────────────────────────
function iso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Raised when a create/edit would violate a UNIQUE constraint (Postgres 23505). */
export class TaxonomyConflictError extends Error {
  constructor(public readonly entity: 'category' | 'alias', public readonly value: string) {
    super(`a ${entity} with value "${value}" already exists`);
    this.name = 'TaxonomyConflictError';
  }
}
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// ══════════════════════════════ REGIONS ═══════════════════════════════════════
export interface RegionRow {
  id: string;
  name: string;
  level: string;
  parentId: string | null;
  parentName: string | null;
  createdAt: string;
}
interface RegionDbRow {
  id: string;
  name: string;
  level: string;
  parent_id: string | null;
  parent_name: string | null;
  created_at: Date | string;
}
function toRegion(r: RegionDbRow): RegionRow {
  return {
    id: r.id,
    name: r.name,
    level: r.level,
    parentId: r.parent_id,
    parentName: r.parent_name,
    createdAt: iso(r.created_at)!,
  };
}
const REGION_SELECT = `
  SELECT r.id::text AS id, r.name, r.level, r.parent_id::text AS parent_id,
         p.name AS parent_name, r.created_at
    FROM region r
    LEFT JOIN region p ON p.id = r.parent_id`;

/** All regions, grouped by level then name — the console list + the parent picker source. */
export async function listRegions(): Promise<RegionRow[]> {
  const rows = await query<RegionDbRow>(
    `${REGION_SELECT} ORDER BY CASE r.level WHEN 'metro' THEN 0 WHEN 'municipality' THEN 1 ELSE 2 END, r.name ASC`
  );
  return rows.map(toRegion);
}

export async function getRegionById(id: string): Promise<RegionRow | null> {
  const rows = await query<RegionDbRow>(`${REGION_SELECT} WHERE r.id = $1`, [id]);
  return rows[0] ? toRegion(rows[0]) : null;
}

/** Raised when a region edit would create a parent→child cycle. */
export class RegionCycleError extends Error {
  constructor() {
    super('a region cannot be its own ancestor');
    this.name = 'RegionCycleError';
  }
}

export async function createRegion(input: RegionInput, adminUserId: string): Promise<RegionRow> {
  const created = await withAdminTransaction(async (client) => {
    const res = await client.query<RegionDbRow>(
      `INSERT INTO region (name, level, parent_id)
       VALUES ($1, $2, $3::uuid)
       RETURNING id::text AS id, name, level, parent_id::text AS parent_id,
                 (SELECT name FROM region WHERE id = $3::uuid) AS parent_name, created_at`,
      [input.name, input.level, input.parentId]
    );
    const row = toRegion(res.rows[0]);
    await auditRegion(client, TAXONOMY_AUDIT_ACTIONS.REGION_CREATE, row.id, null, row, adminUserId);
    return row;
  });
  clearPostgresRegionHierarchyCache();
  return created;
}

export async function updateRegion(
  id: string,
  input: RegionInput,
  adminUserId: string,
  before: RegionRow
): Promise<RegionRow> {
  const updated = await withAdminTransaction(async (client) => {
    if (input.parentId) {
      if (input.parentId === id) throw new RegionCycleError();
      // Walk the ancestor chain of the proposed parent; if this region appears, the
      // edit would create a cycle (region → … → region).
      const cyc = await client.query<{ hit: number }>(
        `WITH RECURSIVE anc AS (
           SELECT id, parent_id FROM region WHERE id = $1::uuid
           UNION ALL
           SELECT r.id, r.parent_id FROM region r JOIN anc ON r.id = anc.parent_id
         )
         SELECT 1 AS hit FROM anc WHERE id = $2::uuid LIMIT 1`,
        [input.parentId, id]
      );
      if (cyc.rows.length > 0) throw new RegionCycleError();
    }
    const res = await client.query<RegionDbRow>(
      `UPDATE region SET name = $2, level = $3, parent_id = $4::uuid
        WHERE id = $1
        RETURNING id::text AS id, name, level, parent_id::text AS parent_id,
                  (SELECT name FROM region WHERE id = $4::uuid) AS parent_name, created_at`,
      [id, input.name, input.level, input.parentId]
    );
    if (!res.rows[0]) throw new Error('region not found');
    const row = toRegion(res.rows[0]);
    await auditRegion(client, TAXONOMY_AUDIT_ACTIONS.REGION_UPDATE, id, before, row, adminUserId);
    return row;
  });
  clearPostgresRegionHierarchyCache();
  return updated;
}

function auditRegion(
  client: PoolClient,
  action: string,
  targetId: string,
  before: RegionRow | null,
  after: RegionRow | null,
  adminUserId: string
): Promise<string> {
  return writeAdminAudit({ adminUserId, action, targetTable: 'region', targetId, before, after }, client);
}

// ══════════════════════════════ CATEGORIES ════════════════════════════════════
export interface CategoryRow {
  id: string;
  key: string;
  label: string;
  isPrimaryEligible: boolean;
  createdAt: string;
}
interface CategoryDbRow {
  id: string;
  key: string;
  label: string;
  is_primary_eligible: boolean;
  created_at: Date | string;
}
function toCategory(r: CategoryDbRow): CategoryRow {
  return { id: r.id, key: r.key, label: r.label, isPrimaryEligible: r.is_primary_eligible, createdAt: iso(r.created_at)! };
}

export async function listCategories(): Promise<CategoryRow[]> {
  const rows = await query<CategoryDbRow>(
    `SELECT id::text AS id, key, label, is_primary_eligible, created_at FROM category ORDER BY label ASC`
  );
  return rows.map(toCategory);
}

export async function getCategoryById(id: string): Promise<CategoryRow | null> {
  const rows = await query<CategoryDbRow>(
    `SELECT id::text AS id, key, label, is_primary_eligible, created_at FROM category WHERE id = $1`,
    [id]
  );
  return rows[0] ? toCategory(rows[0]) : null;
}

export async function createCategory(input: CategoryInput, adminUserId: string): Promise<CategoryRow> {
  try {
    return await withAdminTransaction(async (client) => {
      const res = await client.query<CategoryDbRow>(
        `INSERT INTO category (key, label, is_primary_eligible) VALUES ($1, $2, $3)
         RETURNING id::text AS id, key, label, is_primary_eligible, created_at`,
        [input.key, input.label, input.isPrimaryEligible]
      );
      const row = toCategory(res.rows[0]);
      await writeAdminAudit(
        { adminUserId, action: TAXONOMY_AUDIT_ACTIONS.CATEGORY_CREATE, targetTable: 'category', targetId: row.id, before: null, after: row },
        client
      );
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new TaxonomyConflictError('category', input.key);
    throw err;
  }
}

export async function updateCategory(
  id: string,
  input: CategoryInput,
  adminUserId: string,
  before: CategoryRow
): Promise<CategoryRow> {
  let updated: CategoryRow;
  try {
    updated = await withAdminTransaction(async (client) => {
      const res = await client.query<CategoryDbRow>(
        `UPDATE category SET key = $2, label = $3, is_primary_eligible = $4 WHERE id = $1
         RETURNING id::text AS id, key, label, is_primary_eligible, created_at`,
        [id, input.key, input.label, input.isPrimaryEligible]
      );
      if (!res.rows[0]) throw new Error('category not found');
      const row = toCategory(res.rows[0]);
      await writeAdminAudit(
        { adminUserId, action: TAXONOMY_AUDIT_ACTIONS.CATEGORY_UPDATE, targetTable: 'category', targetId: id, before, after: row },
        client
      );
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new TaxonomyConflictError('category', input.key);
    throw err;
  }
  // The alias resolver caches each alias joined to its canonical category KEY; a key
  // rename must reach live search too, so drop that cache after a category edit.
  clearPostgresAliasResolverCache();
  return updated;
}

// ══════════════════════════════ TAGS (read-only picker source) ════════════════
export interface TagRow {
  id: string;
  key: string;
  label: string;
  tagType: string;
}
export async function listTags(): Promise<TagRow[]> {
  const rows = await query<{ id: string; key: string; label: string; tag_type: string }>(
    `SELECT id::text AS id, key, label, tag_type::text AS tag_type FROM tag ORDER BY label ASC`
  );
  return rows.map((r) => ({ id: r.id, key: r.key, label: r.label, tagType: r.tag_type }));
}

// ══════════════════════════════ ALIASES (synonym_alias) ═══════════════════════
export interface AliasRow {
  id: string;
  aliasText: string;
  /** 'category' | 'tag' — which canonical target this alias points at. */
  targetKind: 'category' | 'tag';
  targetId: string;
  /** The canonical key the live resolver expands this alias to (category.key / tag.key). */
  targetKey: string;
  targetLabel: string;
  createdAt: string;
}
interface AliasDbRow {
  id: string;
  alias_text: string;
  canonical_category_id: string | null;
  canonical_tag_id: string | null;
  category_key: string | null;
  category_label: string | null;
  tag_key: string | null;
  tag_label: string | null;
  created_at: Date | string;
}
function toAlias(r: AliasDbRow): AliasRow {
  const isCat = r.canonical_category_id != null;
  return {
    id: r.id,
    aliasText: r.alias_text,
    targetKind: isCat ? 'category' : 'tag',
    targetId: (isCat ? r.canonical_category_id : r.canonical_tag_id)!,
    targetKey: (isCat ? r.category_key : r.tag_key) ?? '(deleted)',
    targetLabel: (isCat ? r.category_label : r.tag_label) ?? '(deleted target)',
    createdAt: iso(r.created_at)!,
  };
}
const ALIAS_SELECT = `
  SELECT sa.id::text AS id, sa.alias_text,
         sa.canonical_category_id::text AS canonical_category_id,
         sa.canonical_tag_id::text AS canonical_tag_id,
         c.key AS category_key, c.label AS category_label,
         t.key AS tag_key, t.label AS tag_label,
         sa.created_at
    FROM synonym_alias sa
    LEFT JOIN category c ON c.id = sa.canonical_category_id
    LEFT JOIN tag t ON t.id = sa.canonical_tag_id`;

export async function listAliases(): Promise<AliasRow[]> {
  const rows = await query<AliasDbRow>(`${ALIAS_SELECT} ORDER BY sa.alias_text ASC`);
  return rows.map(toAlias);
}

export async function getAliasById(id: string): Promise<AliasRow | null> {
  const rows = await query<AliasDbRow>(`${ALIAS_SELECT} WHERE sa.id = $1`, [id]);
  return rows[0] ? toAlias(rows[0]) : null;
}

function aliasTargetColumns(input: AliasInput): { categoryId: string | null; tagId: string | null } {
  return input.target.kind === 'category'
    ? { categoryId: input.target.id, tagId: null }
    : { categoryId: null, tagId: input.target.id };
}

export async function createAlias(input: AliasInput, adminUserId: string): Promise<AliasRow> {
  const { categoryId, tagId } = aliasTargetColumns(input);
  let created: AliasRow;
  try {
    created = await withAdminTransaction(async (client) => {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO synonym_alias (alias_text, canonical_category_id, canonical_tag_id)
         VALUES ($1, $2::uuid, $3::uuid) RETURNING id::text AS id`,
        [input.aliasText, categoryId, tagId]
      );
      const row = await selectAliasForUpdate(client, ins.rows[0].id);
      await writeAdminAudit(
        { adminUserId, action: TAXONOMY_AUDIT_ACTIONS.ALIAS_CREATE, targetTable: 'synonym_alias', targetId: row.id, before: null, after: row },
        client
      );
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new TaxonomyConflictError('alias', input.aliasText);
    throw err;
  }
  clearPostgresAliasResolverCache(); // ← alias applies at query time immediately (no re-index)
  return created;
}

export async function updateAlias(
  id: string,
  input: AliasInput,
  adminUserId: string,
  before: AliasRow
): Promise<AliasRow> {
  const { categoryId, tagId } = aliasTargetColumns(input);
  let updated: AliasRow;
  try {
    updated = await withAdminTransaction(async (client) => {
      const res = await client.query<{ id: string }>(
        `UPDATE synonym_alias
            SET alias_text = $2, canonical_category_id = $3::uuid, canonical_tag_id = $4::uuid
          WHERE id = $1 RETURNING id::text AS id`,
        [id, input.aliasText, categoryId, tagId]
      );
      if (!res.rows[0]) throw new Error('alias not found');
      const row = await selectAliasForUpdate(client, id);
      await writeAdminAudit(
        { adminUserId, action: TAXONOMY_AUDIT_ACTIONS.ALIAS_UPDATE, targetTable: 'synonym_alias', targetId: id, before, after: row },
        client
      );
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new TaxonomyConflictError('alias', input.aliasText);
    throw err;
  }
  clearPostgresAliasResolverCache();
  return updated;
}

/** Delete an alias (a bad synonym pollutes every live search — removal is a real op). */
export async function deleteAlias(id: string, adminUserId: string, before: AliasRow): Promise<void> {
  await withAdminTransaction(async (client) => {
    const res = await client.query<{ id: string }>(`DELETE FROM synonym_alias WHERE id = $1 RETURNING id`, [id]);
    if (!res.rows[0]) throw new Error('alias not found');
    await writeAdminAudit(
      { adminUserId, action: TAXONOMY_AUDIT_ACTIONS.ALIAS_DELETE, targetTable: 'synonym_alias', targetId: id, before, after: null },
      client
    );
  });
  clearPostgresAliasResolverCache();
}

/** Re-read an alias row (joined to its target) inside the open transaction, for the audit snapshot. */
async function selectAliasForUpdate(client: PoolClient, id: string): Promise<AliasRow> {
  const res = await client.query<AliasDbRow>(`${ALIAS_SELECT} WHERE sa.id = $1`, [id]);
  return toAlias(res.rows[0]);
}
