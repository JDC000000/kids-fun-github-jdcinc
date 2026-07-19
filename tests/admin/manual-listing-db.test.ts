// tests/admin/manual-listing-db.test.ts — G-T34-3 manual-curation intake, DB round-trip
// + the real end-to-end proof: a hand-entered listing is loadable through the SAME
// search read model (lib/search/postgres-repository) that feeds /search and
// /preview/[id], so it renders exactly like an ingested one. Skips without a DB.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool, query } from '@/lib/db/client';
import { createManualListing } from '@/app/admin/listings/_lib/data';
import { ADMIN_AUDIT_ACTIONS } from '@/lib/admin/audit';
import { loadPostgresListingById, loadPostgresListings } from '@/lib/search/postgres-repository';
import type { ManualListingInput } from '@/app/admin/listings/_lib/vocab';

const hasDb = Boolean(process.env.DATABASE_URL);
const FUTURE = '2026-12-01T18:00:00.000Z';

function listing(overrides: Partial<ManualListingInput> = {}): ManualListingInput {
  return {
    title: 'T34P2 Manual Storytime',
    sourceId: null,
    venueName: 'T34P2 Test Library',
    venueAddress: '123 Test St',
    displayArea: 'Downtown',
    venueLat: 49.2827,
    venueLng: -123.1207,
    startDatetimeUtc: FUTURE,
    endDatetimeUtc: null,
    openHoursState: null,
    costStatus: 'free',
    costMinCad: null,
    costMaxCad: null,
    sourceUrl: 'https://example.org/manual-listing',
    bookingUrl: null,
    locationUrl: null,
    descriptionSnippet: 'A hand-entered family storytime.',
    statusState: 'manual_candidate',
    confidenceLabel: 'unscored',
    ...overrides,
  };
}

describe.skipIf(!hasDb)('manual listing intake + render-compat (G-T34-3)', () => {
  let adminId = '';
  const occIds: string[] = [];
  const seriesIds = new Set<string>();
  const venueIds = new Set<string>();
  let testSourceId = '';

  beforeAll(async () => {
    const [admin] = await query<{ id: string }>(`INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`);
    adminId = admin.id;
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1, 'admin', true)`, [adminId]);
    const [src] = await query<{ id: string }>(
      `INSERT INTO source (family, name, authority_tier, ingestion_method)
       VALUES ('test_t34p2_listsrc', 'Manual Listing Test Source', 'official', 'manual') RETURNING id`
    );
    testSourceId = src.id;
  });

  afterAll(async () => {
    if (adminId) await query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [adminId]);
    for (const id of occIds) await query(`DELETE FROM activity_occurrence WHERE id = $1`, [id]);
    for (const id of seriesIds) await query(`DELETE FROM activity_series WHERE id = $1`, [id]);
    for (const id of venueIds) await query(`DELETE FROM venue WHERE id = $1`, [id]);
    if (testSourceId) await query(`DELETE FROM source WHERE id = $1`, [testSourceId]);
    await query(`DELETE FROM source WHERE family = 'manual' AND name = 'Manual Curation'`);
    if (adminId) {
      await query(`DELETE FROM admin_user WHERE user_id = $1`, [adminId]);
      await query(`DELETE FROM user_profile WHERE id = $1`, [adminId]);
    }
    await closePool();
  });

  function track(r: { occurrenceId: string; seriesId: string; venueId: string | null }) {
    occIds.push(r.occurrenceId);
    seriesIds.add(r.seriesId);
    if (r.venueId) venueIds.add(r.venueId);
  }

  it('creates a listing (venue→series→occurrence) + a LISTING_CREATE audit row', async () => {
    const r = await createManualListing(listing(), adminId);
    track(r);
    expect(r.occurrenceId).toBeTruthy();
    expect(r.venueId).toBeTruthy();

    const [audit] = await query<{ target_table: string; target_id: string; after_json: { title: string; venueId: string } }>(
      `SELECT target_table, target_id, after_json FROM admin_audit_log
        WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
      [adminId, ADMIN_AUDIT_ACTIONS.LISTING_CREATE]
    );
    expect(audit.target_table).toBe('activity_occurrence');
    expect(audit.target_id).toBe(r.occurrenceId);
    expect(audit.after_json.title).toBe('T34P2 Manual Storytime');
  });

  it('the created listing loads through the search read model with geo + status (render-compat)', async () => {
    const r = await createManualListing(listing({ title: 'T34P2 Render Check' }), adminId);
    track(r);

    const record = await loadPostgresListingById(getPool(), r.occurrenceId);
    expect(record).not.toBeNull();
    expect(record!.activityName).toBe('T34P2 Render Check');
    expect(record!.statusState).toBe('manual_candidate');
    expect(record!.geo).not.toBeNull();
    expect(record!.geo!.lat).toBeCloseTo(49.2827, 3);
    expect(record!.geo!.lng).toBeCloseTo(-123.1207, 3);
    expect(record!.startDatetimeUtc).toBe(FUTURE);

    const all = await loadPostgresListings(getPool());
    expect(all.some((l) => l.id === r.occurrenceId)).toBe(true);
  });

  it('supports an open-hours listing with no start time and a chosen source', async () => {
    const r = await createManualListing(
      listing({
        title: 'T34P2 Open Hours Attraction',
        sourceId: testSourceId,
        venueName: null,
        venueLat: null,
        venueLng: null,
        startDatetimeUtc: null,
        openHoursState: 'Daily 9am–5pm',
        statusState: 'confirmed',
      }),
      adminId
    );
    track(r);
    expect(r.sourceId).toBe(testSourceId);

    const record = await loadPostgresListingById(getPool(), r.occurrenceId);
    expect(record).not.toBeNull();
    expect(record!.openHours).toBe(true);
    expect(record!.statusState).toBe('confirmed');
  });

  it('reuses one canonical Manual Curation source across default-source listings', async () => {
    const a = await createManualListing(listing({ title: 'T34P2 Manual One' }), adminId);
    const b = await createManualListing(listing({ title: 'T34P2 Manual Two' }), adminId);
    track(a);
    track(b);
    expect(a.sourceId).toBe(b.sourceId);
    const [src] = await query<{ family: string }>(`SELECT family FROM source WHERE id = $1`, [a.sourceId]);
    expect(src.family).toBe('manual');
  });
});
