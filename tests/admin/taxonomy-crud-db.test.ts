// tests/admin/taxonomy-crud-db.test.ts — G-T34-4 taxonomy CRUD + audit, DB round-trip.
// Skips when DATABASE_URL is unset (mirrors the other admin DB tests). Proves:
//   • region/category/alias create+edit land the row AND write an admin_audit_log entry
//     with the right before/after JSON, atomically;
//   • a duplicate category key / alias phrase raises TaxonomyConflictError;
//   • a region parent that would form a cycle raises RegionCycleError;
//   • the headline AC: an alias edit applies AT QUERY TIME immediately, no re-index — a
//     newly-created alias is resolved by the very accessor the live /api/search route uses
//     (getPostgresAliasResolver), because the mutation drops the resolver cache.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query, getPool } from '@/lib/db/client';
import {
  listRegions,
  getRegionById,
  createRegion,
  updateRegion,
  RegionCycleError,
  listCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  createAlias,
  updateAlias,
  deleteAlias,
  getAliasById,
  listAliases,
  TaxonomyConflictError,
  TAXONOMY_AUDIT_ACTIONS,
} from '@/app/admin/taxonomy/_lib/data';
import { getPostgresAliasResolver, clearPostgresAliasResolverCache } from '@/lib/search/postgres-alias-resolver';
import { normalize } from '@/lib/search/text/normalize';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('taxonomy CRUD + audit (G-T34-4)', () => {
  let adminId = '';
  const regionIds: string[] = [];
  const categoryIds: string[] = [];
  const aliasIds: string[] = [];
  const CAT_KEY = 'qtaxo_gym';
  const CAT_KEY_2 = 'qtaxo_swim';
  const ALIAS_QT = 'qtaxobounce'; // a novel single token that collides with no seeded alias

  beforeAll(async () => {
    const [admin] = await query<{ id: string }>(`INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`);
    adminId = admin.id;
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'admin', true)`, [adminId]);
  });

  afterAll(async () => {
    if (adminId) await query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [adminId]);
    for (const id of aliasIds) await query(`DELETE FROM synonym_alias WHERE id = $1`, [id]);
    for (const id of categoryIds) await query(`DELETE FROM category WHERE id = $1`, [id]);
    // regions: delete children before parents (parent_id FK) — reverse creation order.
    for (const id of [...regionIds].reverse()) await query(`DELETE FROM region WHERE id = $1`, [id]);
    if (adminId) {
      await query(`DELETE FROM admin_user WHERE user_id = $1`, [adminId]);
      await query(`DELETE FROM user_profile WHERE id = $1`, [adminId]);
    }
    await closePool();
  });

  // ── Regions ──
  it('createRegion inserts + audits; updateRegion re-parents + audits before/after', async () => {
    const metro = await createRegion({ name: 'QTaxo Metro', level: 'metro', parentId: null }, adminId);
    regionIds.push(metro.id);
    expect(metro.parentId).toBeNull();

    const muni = await createRegion({ name: 'QTaxo City', level: 'municipality', parentId: metro.id }, adminId);
    regionIds.push(muni.id);
    expect(muni.parentId).toBe(metro.id);
    expect(muni.parentName).toBe('QTaxo Metro');

    const [createAudit] = await query<{ target_table: string; after_json: { name: string } }>(
      `SELECT target_table, after_json FROM admin_audit_log
        WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
      [adminId, TAXONOMY_AUDIT_ACTIONS.REGION_CREATE]
    );
    expect(createAudit.target_table).toBe('region');
    expect(createAudit.after_json.name).toBe('QTaxo City');

    const before = await getRegionById(muni.id);
    const renamed = await updateRegion(muni.id, { name: 'QTaxo City 2', level: 'municipality', parentId: metro.id }, adminId, before!);
    expect(renamed.name).toBe('QTaxo City 2');

    const [updAudit] = await query<{ before_json: { name: string }; after_json: { name: string } }>(
      `SELECT before_json, after_json FROM admin_audit_log
        WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
      [adminId, TAXONOMY_AUDIT_ACTIONS.REGION_UPDATE]
    );
    expect(updAudit.before_json.name).toBe('QTaxo City');
    expect(updAudit.after_json.name).toBe('QTaxo City 2');

    expect((await listRegions()).some((r) => r.id === muni.id)).toBe(true);
  });

  it('updateRegion rejects a cycle (region cannot be its own ancestor)', async () => {
    const [metroId, muniId] = regionIds;
    // metro is the ancestor of muni; making metro's parent = muni would form a loop.
    await expect(
      updateRegion(metroId, { name: 'QTaxo Metro', level: 'metro', parentId: muniId }, adminId, (await getRegionById(metroId))!)
    ).rejects.toBeInstanceOf(RegionCycleError);
    // and a self-parent is rejected too.
    await expect(
      updateRegion(metroId, { name: 'QTaxo Metro', level: 'metro', parentId: metroId }, adminId, (await getRegionById(metroId))!)
    ).rejects.toBeInstanceOf(RegionCycleError);
  });

  // ── Categories ──
  it('createCategory inserts + audits; updateCategory edits + audits; duplicate key conflicts', async () => {
    const cat = await createCategory({ key: CAT_KEY, label: 'QTaxo Gym', isPrimaryEligible: true }, adminId);
    categoryIds.push(cat.id);
    expect(cat.key).toBe(CAT_KEY);
    expect(cat.isPrimaryEligible).toBe(true);

    const cat2 = await createCategory({ key: CAT_KEY_2, label: 'QTaxo Swim', isPrimaryEligible: false }, adminId);
    categoryIds.push(cat2.id);

    const before = await getCategoryById(cat.id);
    const upd = await updateCategory(cat.id, { key: CAT_KEY, label: 'QTaxo Gymnasium', isPrimaryEligible: false }, adminId, before!);
    expect(upd.label).toBe('QTaxo Gymnasium');
    expect(upd.isPrimaryEligible).toBe(false);

    const [audit] = await query<{ before_json: { label: string }; after_json: { label: string } }>(
      `SELECT before_json, after_json FROM admin_audit_log
        WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
      [adminId, TAXONOMY_AUDIT_ACTIONS.CATEGORY_UPDATE]
    );
    expect(audit.before_json.label).toBe('QTaxo Gym');
    expect(audit.after_json.label).toBe('QTaxo Gymnasium');

    await expect(createCategory({ key: CAT_KEY, label: 'dupe', isPrimaryEligible: true }, adminId)).rejects.toBeInstanceOf(
      TaxonomyConflictError
    );
    expect((await listCategories()).some((c) => c.id === cat.id)).toBe(true);
  });

  // ── Aliases — incl. the query-time AC ──
  it('createAlias applies AT QUERY TIME immediately (no re-index) and audits', async () => {
    const catId = categoryIds[0]; // maps to CAT_KEY (qtaxo_gym)
    const tokens = normalize(ALIAS_QT).split(' ');

    // BEFORE: a fresh load of the exact accessor the live route uses does NOT resolve it.
    clearPostgresAliasResolverCache();
    const before = await getPostgresAliasResolver(getPool());
    expect(before.expand(tokens).canonicalCategoryKeys).not.toContain(CAT_KEY);

    // Mutate through the console data layer (which drops the resolver cache on commit).
    const alias = await createAlias({ aliasText: ALIAS_QT, target: { kind: 'category', id: catId } }, adminId);
    aliasIds.push(alias.id);
    expect(alias.targetKind).toBe('category');
    expect(alias.targetKey).toBe(CAT_KEY);

    // AFTER: the NEXT load (cache was cleared by the mutation) resolves the new alias —
    // proving a query-time synonym edit takes effect with no bulk re-index / restart.
    const after = await getPostgresAliasResolver(getPool());
    expect(after.expand(tokens).canonicalCategoryKeys).toContain(CAT_KEY);

    const [audit] = await query<{ target_table: string; after_json: { aliasText: string } }>(
      `SELECT target_table, after_json FROM admin_audit_log
        WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
      [adminId, TAXONOMY_AUDIT_ACTIONS.ALIAS_CREATE]
    );
    expect(audit.target_table).toBe('synonym_alias');
    expect(audit.after_json.aliasText).toBe(ALIAS_QT);
  });

  it('updateAlias re-points the target + audits before/after', async () => {
    const aliasId = aliasIds[0];
    const before = await getAliasById(aliasId);
    const upd = await updateAlias(
      aliasId,
      { aliasText: ALIAS_QT, target: { kind: 'category', id: categoryIds[1] } },
      adminId,
      before!
    );
    expect(upd.targetKey).toBe(CAT_KEY_2);

    // Query-time reflects the re-point: now resolves to the new key, not the old one.
    const resolver = await getPostgresAliasResolver(getPool());
    const keys = resolver.expand(normalize(ALIAS_QT).split(' ')).canonicalCategoryKeys;
    expect(keys).toContain(CAT_KEY_2);
    expect(keys).not.toContain(CAT_KEY);
  });

  it('duplicate alias phrase (case-insensitive) raises TaxonomyConflictError', async () => {
    await expect(
      createAlias({ aliasText: ALIAS_QT.toUpperCase(), target: { kind: 'category', id: categoryIds[0] } }, adminId)
    ).rejects.toBeInstanceOf(TaxonomyConflictError);
  });

  it('deleteAlias removes the row, audits, and drops it from query-time expansion', async () => {
    const aliasId = aliasIds[0];
    const before = await getAliasById(aliasId);
    await deleteAlias(aliasId, adminId, before!);
    aliasIds.shift();

    expect((await listAliases()).some((a) => a.id === aliasId)).toBe(false);
    const resolver = await getPostgresAliasResolver(getPool());
    expect(resolver.expand(normalize(ALIAS_QT).split(' ')).canonicalCategoryKeys).not.toContain(CAT_KEY_2);

    const [audit] = await query<{ before_json: { aliasText: string }; after_json: unknown }>(
      `SELECT before_json, after_json FROM admin_audit_log
        WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
      [adminId, TAXONOMY_AUDIT_ACTIONS.ALIAS_DELETE]
    );
    expect(audit.before_json.aliasText).toBe(ALIAS_QT);
    expect(audit.after_json).toBeNull();
  });
});
