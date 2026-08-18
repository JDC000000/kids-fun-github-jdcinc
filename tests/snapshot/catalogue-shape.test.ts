// tests/snapshot/catalogue-shape.test.ts — DB lane, SNAPSHOT MODE ONLY.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// THIS IS THE SUITE THE WHOLE FEATURE EXISTS TO ENABLE.
//
// Every other DB suite in this repo mints its own fixtures: a source, a series, an occurrence,
// all shaped exactly the way the code under test expects, because the same person wrote both.
// That is fine for logic and useless for data shape. A fixture cannot tell you that production
// holds a municipality with a NULL centroid, an occurrence whose age range no band covers, or a
// status_state the renderer has never seen — because a fixture only contains what somebody
// thought to put in it. Round-27-era bugs of that class were all found by a human looking at
// the live site.
//
// So these assertions run over the WHOLE loaded catalogue and are deliberately universal
// ("every row satisfies X"), with failures that name the offending id. They are gated on
// KF_SNAPSHOT_MODE=1 and skip otherwise: fixture mode stays the default and stays fast, and
// nothing here can turn red on a developer who never asked for snapshot data.
//
//   npm run test:snapshot     # load a snapshot, then run with KF_SNAPSHOT_MODE=1
//
// WHEN ONE OF THESE FAILS it is usually not a bug in the test. It is the catalogue telling you
// something the fixtures could not. Read the named row first.
// ─────────────────────────────────────────────────────────────────────────────────────
import { afterAll, describe, expect, it } from 'vitest';
import { getPool, query, closePool } from '../../lib/db/client';
import { loadPostgresListings } from '../../lib/search/postgres-repository';

const hasDb = Boolean(process.env.DATABASE_URL);
const snapshotMode = process.env.KF_SNAPSHOT_MODE === '1';

/** Metro Vancouver, generously bounded. A coordinate outside this is a data error, not a suburb. */
const BBOX = { minLat: 48.5, maxLat: 50.5, minLng: -124.5, maxLng: -121.5 };

const KNOWN_STATUS_STATES = new Set([
  'confirmed', 'bookable_open', 'not_yet_bookable', 'schedule_not_published', 'inferred_recurring',
  'manual_candidate', 'seasonal_out_of_season', 'seasonal_preseason', 'seasonal_active', 'suspended',
  'stale', 'cancelled', 'postponed', 'full', 'waitlist', 'needs_review',
]);
const KNOWN_CONFIDENCE_LABELS = new Set(['official_recent', 'official', 'editorial', 'inferred', 'stale']);
const KNOWN_COST_STATUSES = new Set(['known', 'free', 'unknown', 'check_source']);

describe.skipIf(!hasDb || !snapshotMode)('catalogue shape (snapshot mode)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('has actually loaded a snapshot — otherwise every assertion below is vacuously true', async () => {
    const [{ n }] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM activity_occurrence`);
    expect(
      Number(n),
      'KF_SNAPSHOT_MODE=1 but activity_occurrence is empty. Run scripts/snapshot/load.sh first.'
    ).toBeGreaterThan(0);
  });

  describe('regions', () => {
    it('gives every non-metro region a parent that exists', async () => {
      const rows = await query<{ id: string; name: string; level: string }>(
        `SELECT r.id, r.name, r.level FROM region r
          WHERE r.level <> 'metro'
            AND (r.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM region p WHERE p.id = r.parent_id))`
      );
      expect(rows.map((r) => `${r.level} "${r.name}" (${r.id})`)).toEqual([]);
    });

    it('gives every region a centroid — distance search joins through it', async () => {
      const rows = await query<{ id: string; name: string; level: string }>(
        `SELECT id, name, level FROM region WHERE centroid IS NULL`
      );
      expect(rows.map((r) => `${r.level} "${r.name}" (${r.id})`)).toEqual([]);
    });

    it('places every region centroid inside Metro Vancouver', async () => {
      const rows = await query<{ id: string; name: string; lat: number; lng: number }>(
        `SELECT id, name, ST_Y(centroid::geometry) AS lat, ST_X(centroid::geometry) AS lng
           FROM region WHERE centroid IS NOT NULL`
      );
      const out = rows.filter(
        (r) => r.lat < BBOX.minLat || r.lat > BBOX.maxLat || r.lng < BBOX.minLng || r.lng > BBOX.maxLng
      );
      expect(out.map((r) => `${r.name} @ ${r.lat},${r.lng}`)).toEqual([]);
    });
  });

  describe('venues', () => {
    it('places every venue geo inside Metro Vancouver', async () => {
      const rows = await query<{ id: string; name: string; lat: number; lng: number }>(
        `SELECT id, name, ST_Y(geo::geometry) AS lat, ST_X(geo::geometry) AS lng FROM venue WHERE geo IS NOT NULL`
      );
      const out = rows.filter(
        (r) => r.lat < BBOX.minLat || r.lat > BBOX.maxLat || r.lng < BBOX.minLng || r.lng > BBOX.maxLng
      );
      expect(out.map((r) => `${r.name} (${r.id}) @ ${r.lat},${r.lng}`)).toEqual([]);
    });

    it('points every venue municipality_id at a region that exists', async () => {
      const rows = await query<{ id: string; name: string }>(
        `SELECT v.id, v.name FROM venue v
          WHERE v.municipality_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM region r WHERE r.id = v.municipality_id)`
      );
      expect(rows.map((r) => `${r.name} (${r.id})`)).toEqual([]);
    });
  });

  describe('occurrence times', () => {
    it('never ends before it starts', async () => {
      const rows = await query<{ id: string; start_datetime_utc: string; end_datetime_utc: string }>(
        `SELECT id, start_datetime_utc::text, end_datetime_utc::text FROM activity_occurrence
          WHERE start_datetime_utc IS NOT NULL AND end_datetime_utc IS NOT NULL
            AND end_datetime_utc < start_datetime_utc`
      );
      expect(rows.map((r) => `${r.id}: ${r.start_datetime_utc} → ${r.end_datetime_utc}`)).toEqual([]);
    });

    it('always has either a start time or an open-hours sentence', async () => {
      // Enforced by a CHECK at write time — asserted here because a snapshot loaded from a
      // database that predates the CHECK would carry rows the renderer cannot describe.
      const rows = await query<{ id: string }>(
        `SELECT id FROM activity_occurrence WHERE start_datetime_utc IS NULL AND open_hours_state IS NULL`
      );
      expect(rows.map((r) => r.id)).toEqual([]);
    });

    it('recomputed search_tsv for every occurrence during load', async () => {
      // search_tsv is `derived_drop` in the policy — the 0010 trigger rebuilds it as rows land.
      // A NULL here means the trigger chain did not fire, and every text search would be blind.
      const rows = await query<{ id: string }>(`SELECT id FROM activity_occurrence WHERE search_tsv IS NULL`);
      expect(rows.map((r) => r.id)).toEqual([]);
    });
  });

  describe('ages', () => {
    it('never has a minimum above its maximum', async () => {
      const rows = await query<{ occurrence_id: string; age_min_months: number; age_max_months: number }>(
        `SELECT occurrence_id, age_min_months, age_max_months FROM occurrence_age
          WHERE age_min_months IS NOT NULL AND age_max_months IS NOT NULL AND age_min_months > age_max_months`
      );
      expect(rows.map((r) => `${r.occurrence_id}: ${r.age_min_months}–${r.age_max_months}mo`)).toEqual([]);
    });

    it('resolves every age_band_matches entry to a real band', async () => {
      const rows = await query<{ occurrence_id: string; missing: string }>(
        `SELECT oa.occurrence_id, m::text AS missing
           FROM occurrence_age oa, unnest(oa.age_band_matches) AS m
          WHERE NOT EXISTS (SELECT 1 FROM age_band b WHERE b.id = m)`
      );
      expect(rows.map((r) => `${r.occurrence_id} → ${r.missing}`)).toEqual([]);
    });

    it('has a band for every stated age range — an unmatched range is invisible to age filters', async () => {
      const rows = await query<{ occurrence_id: string; age_min_months: number | null }>(
        `SELECT occurrence_id, age_min_months FROM occurrence_age
          WHERE (age_min_months IS NOT NULL OR age_max_months IS NOT NULL)
            AND cardinality(age_band_matches) = 0`
      );
      expect(rows.map((r) => r.occurrence_id)).toEqual([]);
    });
  });

  describe('enum values the app must be able to render', () => {
    it('uses only known status_state values', async () => {
      const rows = await query<{ status_state: string }>(`SELECT DISTINCT status_state::text FROM activity_occurrence`);
      expect(rows.map((r) => r.status_state).filter((s) => !KNOWN_STATUS_STATES.has(s))).toEqual([]);
    });

    it('uses only known cost_status values', async () => {
      const rows = await query<{ cost_status: string }>(`SELECT DISTINCT cost_status::text FROM activity_occurrence`);
      expect(rows.map((r) => r.cost_status).filter((s) => !KNOWN_COST_STATUSES.has(s))).toEqual([]);
    });
  });

  describe('the read model over real rows', () => {
    it('maps the entire catalogue without throwing, and produces no malformed listing', async () => {
      // The bug class this snapshot exists for: loadPostgresListings works perfectly on fixtures
      // and then meets a row with a null venue, an unrecognised confidence tier, or a cost that
      // arrives as a string. Running it over EVERY visible row is the cheapest way to find that.
      const listings = await loadPostgresListings(getPool());
      expect(listings.length).toBeGreaterThan(0);

      const bad: string[] = [];
      for (const l of listings) {
        if (!l.id) bad.push('listing with no id');
        if (!l.activityName || l.activityName.trim() === '') bad.push(`${l.id}: empty activityName`);
        if (!KNOWN_CONFIDENCE_LABELS.has(l.confidenceLabel)) bad.push(`${l.id}: confidenceLabel "${l.confidenceLabel}"`);
        if (!KNOWN_COST_STATUSES.has(l.costStatus)) bad.push(`${l.id}: costStatus "${l.costStatus}"`);
        if (!KNOWN_STATUS_STATES.has(l.statusState)) bad.push(`${l.id}: statusState "${l.statusState}"`);
        if (l.startDatetimeUtc === null && !l.openHours) bad.push(`${l.id}: neither a start time nor openHours`);
        if (l.startDatetimeUtc !== null && Number.isNaN(Date.parse(l.startDatetimeUtc)))
          bad.push(`${l.id}: unparseable startDatetimeUtc`);
        if (l.endDatetimeUtc !== null && Number.isNaN(Date.parse(l.endDatetimeUtc)))
          bad.push(`${l.id}: unparseable endDatetimeUtc`);
      }
      expect(bad.slice(0, 25)).toEqual([]);
    });

    it('carries a numeric cost whenever it claims a cost is known', async () => {
      const listings = await loadPostgresListings(getPool());
      const bad = listings
        .filter((l) => l.costStatus === 'known' && l.costMinCad === null && l.costMaxCad === null)
        .map((l) => l.id);
      expect(bad.slice(0, 25)).toEqual([]);
    });
  });
});
