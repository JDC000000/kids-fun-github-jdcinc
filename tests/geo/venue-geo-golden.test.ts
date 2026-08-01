// tests/geo/venue-geo-golden.test.ts — G-VGEO-0: the golden venue-geo resolution harness.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS, IN ONE PARAGRAPH.
//
// Every venue coordinate in this product — every distance number, every radius filter,
// every map pin, on every parent-facing search, in every launch municipality — is the
// output of ONE function: worker/core/venue.ts::resolveVenue. Eight independent producers
// feed it. Its merge rule is about to change. A regression here does not look like an
// error: a venue that silently drops out of a 5 km radius looks like *fewer results*, to
// the parent and to us. So the coordinate every producer resolves to is captured here,
// byte-for-byte, BEFORE the change, and any movement fails CI with the venue NAMED.
// (No percentage-based assertion, deliberately — same reasoning as `venuesWithoutGeo`
// naming facilities rather than reporting "67% coverage"; docs/source-register.md §6.6.)
//
// ─────────────────────────────────────────────────────────────────────────────────────
// WHAT "BYTE-IDENTICAL" MEANS HERE, LITERALLY.
//
// The assertion is on `venue.geo::text` — PostGIS's EWKB hex rendering of the stored
// geography. That is the bytes on disk, not a rounded projection of them. `ST_Y`/`ST_X`
// are captured alongside it for human review of the fixture, but they are NOT what the
// equality assertion runs on: a float projected to text can compare equal across a real
// coordinate change in the last ulp, and this file's whole job is to not be fooled.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// THE TWO ASSERTIONS, AND WHY ONLY ONE OF THEM WAS GREEN WHEN IT WAS WRITTEN.
//
//   (1) EQUALITY-TO-BASELINE, under a declared ingest order.
//       Green on unmodified `main` (5fb9d01) and green after G-VGEO-A1/A2/A3. The
//       declared order is ASCENDING COORDINATE AUTHORITY, which under `main`'s
//       last-writer-wins semantics yields exactly the outcome the authority-ranked write
//       yields — i.e. the baseline is today's BEST-CASE stored value, and the fix's job
//       is to reach it from EVERY order rather than from one lucky one. That is why the
//       same fixture can gate both sides of the change.
//
//   (2) ORDER-INDEPENDENCE, over permutations of the producer order.
//       RED on unmodified `main`, BY DESIGN, and that is the point of the file. On `main`
//       the four venues activenet and citycalendar both carry (Killarney, Kitsilano,
//       Renfrew Park, Trout Lake — up to ~802 m apart) resolve to whichever adapter's
//       cron fired last. Measured on `main` at the time of writing: 4 venues changed
//       coordinate between the ascending-authority order and its reverse. A harness that
//       only asserted equality-to-baseline would have blessed that system as stable, so
//       this assertion is not optional decoration — it is the load-bearing proof.
//
// A NOTE FOR ANYONE WHO EDITS THE BASELINE. Regenerate it with
// `KIDS_FUN_REGENERATE_VENUE_GEO_BASELINE=1 npx vitest run tests/geo/venue-geo-golden.test.ts`
// ONLY when a coordinate change is intended and reviewed. The regenerated diff names
// every venue that moved; that diff is the review artefact. Regenerating to make a red
// test green is the exact failure this file exists to prevent.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// SCOPE — what this harness can and cannot enumerate, stated so nobody misreads it.
//
// ENUMERABLE (covered here): the four producers that ship a COMMITTED coordinate table —
// activenet's `VANCOUVER_VENUE_GEO`, citycalendar's `venueGeo`, venue/config's `geo`
// literals, and library's `branchLocations`. Their emissions are a closed set, so a
// golden fixture over them is complete.
//
// NOT ENUMERABLE (deliberately absent): the four LIVE producers — library's
// `bc:latitude` from the BiblioCommons RSS, perfectmind's inline `Address` block,
// eventbrite's API, and the admin manual-listing form. They take coordinates from a
// third-party payload (or a human) at run time; there is no committed value to pin. They
// are covered instead by G-VGEO-A3's authority declaration and its compliance scan. This
// boundary is asserted below (`the enumerable producer set is pinned`) so a fifth
// committed table cannot join the system without joining this fixture.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { getPool, query, closePool } from '../../lib/db/client';
import { resolveVenue } from '../../worker/core/venue';
import type { VenueGeoAuthority } from '../../worker/core/venue-geo-authority';
import { VANCOUVER_VENUE_GEO } from '../../worker/adapters/activenet/venue-geo';
import { CITY_CALENDARS } from '../../worker/adapters/citycalendar/config';
import { LAUNCH_VENUES } from '../../worker/adapters/venue/config';
import { LIBRARY_SYSTEMS } from '../../worker/adapters/library/config';

const hasDb = Boolean(process.env.DATABASE_URL);
const REGENERATE = process.env.KIDS_FUN_REGENERATE_VENUE_GEO_BASELINE === '1';
const BASELINE_PATH = resolve(process.cwd(), 'tests/geo/__fixtures__/venue-geo-baseline.json');

// ── the producer model ───────────────────────────────────────────────────────────────
//
// An EMISSION is one (venue name, coordinate) pair a producer can put into the pipeline.
// Authority lives on the emission rather than the producer because activenet's table is
// genuinely mixed: an entry sourced verbatim from the City's licensed dataset and an
// entry a human hand-placed against OSM are not the same claim, and `venue-geo.ts`
// already distinguishes them per entry (`source: 'opendata-vancouver' | 'curated'`).
// Flattening that to one per-file number would have thrown away the only real provenance
// in the system.

interface GeoEmission {
  /** Venue name exactly as the producer emits it — casing and spacing included. */
  venueName: string;
  lat: number;
  lng: number;
  /** Coordinate-authority ordinal. See worker/core/venue-geo-authority.ts. */
  authority: number;
}

interface GeoProducer {
  id: string;
  emissions: GeoEmission[];
}

// The tiers are RE-DECLARED here rather than imported from the producers, on purpose and
// for the same reason tests/compliance/no-bypass.test.ts declares its own allow-list: a
// tripwire that reads its expectations out of the code it polices can be defeated by
// editing that code alone. G-VGEO-A3's compliance test asserts these match what the
// producers actually declare, so a divergence fails there, loudly, naming the producer.
const TIER_CURATED_PROVENANCED = 40;
const TIER_COMMITTED_OPEN_DATA = 30;
const TIER_ADAPTER_CONFIG_LITERAL = 20;

function activenetVancouverProducer(): GeoProducer {
  return {
    id: 'activenet:vancouver',
    emissions: Object.entries(VANCOUVER_VENUE_GEO).map(([venueName, geo]) => ({
      venueName,
      lat: geo.lat,
      lng: geo.lng,
      authority:
        geo.source === 'opendata-vancouver' ? TIER_COMMITTED_OPEN_DATA : TIER_CURATED_PROVENANCED,
    })),
  };
}

function cityCalendarProducers(): GeoProducer[] {
  return CITY_CALENDARS.filter((c) => c.venueGeo).map((c) => ({
    id: `citycalendar:${c.calendarKey}`,
    emissions: Object.entries(c.venueGeo!).map(([venueName, geo]) => ({
      venueName,
      lat: geo.lat,
      lng: geo.lng,
      authority: TIER_ADAPTER_CONFIG_LITERAL,
    })),
  }));
}

function venueConfigProducer(): GeoProducer {
  return {
    id: 'venue:launch',
    emissions: LAUNCH_VENUES.filter((v) => v.geo?.lat !== undefined && v.geo?.lng !== undefined).map(
      (v) => ({
        venueName: v.venueName,
        lat: v.geo!.lat!,
        lng: v.geo!.lng!,
        authority: TIER_ADAPTER_CONFIG_LITERAL,
      })
    ),
  };
}

function libraryProducers(): GeoProducer[] {
  return LIBRARY_SYSTEMS.filter((s) => s.branchLocations).map((s) => ({
    id: `library:${s.systemKey}`,
    emissions: Object.entries(s.branchLocations!)
      .filter(([, b]) => b.lat !== undefined && b.lng !== undefined)
      .map(([venueName, b]) => ({
        venueName,
        lat: b.lat!,
        lng: b.lng!,
        authority: TIER_ADAPTER_CONFIG_LITERAL,
      })),
  }));
}

/**
 * THE DECLARED INGEST ORDER — ascending coordinate authority.
 *
 * This is what makes the fixture reproducible AND makes it survive the change: under
 * `main`'s last-writer-wins the highest-authority producer running LAST wins, which is
 * the same venue the authority-ranked write picks regardless of order. The order is
 * asserted below to actually realise that property (`the declared ingest order is the
 * authority-ranked order`) rather than being assumed to.
 */
function declaredProducerOrder(): GeoProducer[] {
  return [
    ...libraryProducers(),
    ...cityCalendarProducers(),
    venueConfigProducer(),
    activenetVancouverProducer(),
  ];
}

/** The DB's own identity predicate, verbatim: `lower(name)` after `.trim()`. */
function dbKey(venueName: string): string {
  return venueName.trim().toLowerCase();
}

interface ResolvedVenue {
  lat: number;
  lng: number;
  /** PostGIS EWKB hex — the stored bytes. This is what equality is asserted on. */
  geoHex: string;
}

/**
 * Run a full ingest of every producer, in the given order, into REAL Postgres via the
 * REAL resolveVenue, and read back what was stored.
 *
 * Venue names are prefixed with a per-run token so the harness cannot collide with the
 * shared DB lane's other fixtures (or with production names, should anyone ever point
 * this at a database that has them). The prefix is IDENTICAL for every producer, so the
 * collision structure — which names two producers both claim — is preserved exactly.
 */
async function ingestAll(
  pool: Pool,
  order: GeoProducer[],
  token: string
): Promise<Map<string, ResolvedVenue>> {
  for (const producer of order) {
    for (const e of producer.emissions) {
      await resolveVenue(pool, {
        name: `${token} ${e.venueName}`,
        lat: e.lat,
        lng: e.lng,
        // Declared from the TEST's own tier table (above), never from the producer's — see
        // the comment on TIER_*: a tripwire that reads its expectations out of the code it
        // polices can be defeated by editing that code alone.
        geoAuthority: e.authority as VenueGeoAuthority,
        geoSource: producer.id,
      });
    }
  }

  const rows = await query<{ name: string; lat: string; lng: string; geo_hex: string }>(
    `SELECT name,
            ST_Y(geo::geometry)::text AS lat,
            ST_X(geo::geometry)::text AS lng,
            geo::text                 AS geo_hex
     FROM venue
     WHERE name LIKE $1 || ' %'`,
    [token]
  );

  const out = new Map<string, ResolvedVenue>();
  for (const r of rows) {
    out.set(dbKey(r.name.slice(token.length + 1)), {
      lat: Number(r.lat),
      lng: Number(r.lng),
      geoHex: r.geo_hex,
    });
  }
  return out;
}

function toFixture(resolved: Map<string, ResolvedVenue>): Record<string, ResolvedVenue> {
  return Object.fromEntries([...resolved.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

const tokens: string[] = [];
function newToken(): string {
  const t = `GVGEO0-${crypto.randomUUID().slice(0, 8)}`;
  tokens.push(t);
  return t;
}

describe.skipIf(!hasDb)('G-VGEO-0 — golden venue-geo resolution harness', () => {
  let pool: Pool;
  let baselineRun: Map<string, ResolvedVenue>;

  beforeAll(async () => {
    pool = getPool();
    baselineRun = await ingestAll(pool, declaredProducerOrder(), newToken());
  });

  afterAll(async () => {
    // ~43 venues per ingest run and one run per permutation, so this suite is the one that
    // would actually silt up a shared database. Detach rather than cascade — see the same
    // note in tests/core/venue-authority.test.ts.
    for (const t of tokens) {
      await query(
        `UPDATE activity_series SET venue_id = NULL
         WHERE venue_id IN (SELECT id FROM venue WHERE name LIKE $1 || ' %')`,
        [t]
      );
      await query(`DELETE FROM venue WHERE name LIKE $1 || ' %'`, [t]);
    }
    await closePool();
  });

  // ── the enumeration, pinned ────────────────────────────────────────────────────────

  it('the enumerable producer set is pinned — a fifth committed geo table cannot appear silently', () => {
    // Two deliberate scoping sweeps of this exact question, a day apart, each undercounted
    // the producers (3 → 6 → 8) because three of them attach coordinates inline in a parse
    // step with no geo file to grep for. The count is therefore pinned mechanically rather
    // than trusted to the next audit.
    expect(declaredProducerOrder().map((p) => p.id).sort()).toEqual([
      'activenet:vancouver',
      'citycalendar:vancouver',
      'library:nvdpl',
      'library:rpl',
      'venue:launch',
    ]);
  });

  it('every venue any enumerable producer can emit is in the baseline, by name', () => {
    const emitted = new Set(
      declaredProducerOrder().flatMap((p) => p.emissions.map((e) => dbKey(e.venueName)))
    );
    const missing = [...emitted].filter((n) => !baselineRun.has(n)).sort();
    expect(missing, 'a producer emitted a coordinate that did not reach the venue row').toEqual([]);
    // and nothing the producers do NOT emit crept into the run
    expect([...baselineRun.keys()].filter((n) => !emitted.has(n)).sort()).toEqual([]);
  });

  it('the declared ingest order IS the authority-ranked order (so the baseline is the best case)', () => {
    // The baseline is only meaningful if the declared order already yields the outcome the
    // authority-ranked write will yield. That holds iff, for every contested venue, the LAST
    // producer to emit it is the one with the highest authority for it. Asserted, not assumed
    // — if a future producer straddles another's tier, no single order can realise the
    // ranking and this fails HERE rather than silently poisoning the fixture.
    const order = declaredProducerOrder();
    const lastWriterAuthority = new Map<string, number>();
    const bestAuthority = new Map<string, number>();
    for (const p of order) {
      for (const e of p.emissions) {
        const k = dbKey(e.venueName);
        lastWriterAuthority.set(k, e.authority);
        bestAuthority.set(k, Math.max(bestAuthority.get(k) ?? -1, e.authority));
      }
    }
    const wrong = [...lastWriterAuthority.entries()]
      .filter(([k, a]) => a !== bestAuthority.get(k))
      .map(([k]) => k)
      .sort();
    expect(wrong, 'declared order does not let the highest-authority source write last').toEqual([]);
  });

  it('no two EQUAL-authority producers disagree about a venue — the invariant "incumbent wins" rests on', () => {
    // "Higher authority wins; EQUAL authority leaves the incumbent" is only order-independent
    // while no two equal-authority producers claim the same venue with different coordinates.
    // If two ever do, the stored value goes back to depending on which cron fired first and
    // the authority rule will NOT save it. That is a real hole in the mechanism, so it is
    // asserted here explicitly rather than left as an implicit assumption of the design.
    const byName = new Map<string, { producer: string; lat: number; lng: number; authority: number }[]>();
    for (const p of declaredProducerOrder()) {
      for (const e of p.emissions) {
        const k = dbKey(e.venueName);
        byName.set(k, [...(byName.get(k) ?? []), { producer: p.id, ...e }]);
      }
    }
    const conflicts = [...byName.entries()]
      .filter(([, claims]) =>
        claims.some((a) =>
          claims.some(
            (b) => a.authority === b.authority && (a.lat !== b.lat || a.lng !== b.lng)
          )
        )
      )
      .map(([name, claims]) => `${name}: ${claims.map((c) => `${c.producer}@${c.authority}`).join(' vs ')}`)
      .sort();
    expect(conflicts).toEqual([]);
  });

  // ── (1) equality to the committed baseline ────────────────────────────────────────

  it('every venue resolves byte-identically to the committed baseline', () => {
    const actual = toFixture(baselineRun);
    if (REGENERATE) {
      writeFileSync(BASELINE_PATH, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    const expected = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, ResolvedVenue>;

    // Compared venue-by-venue rather than as one object, so a failure names the venue that
    // moved and prints its two coordinates — a whole-object diff over 50 venues is unreadable
    // and, worse, does not say WHICH pin moved.
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, exp] of Object.entries(expected)) {
      expect(actual[name]?.geoHex, `${name} moved: ${JSON.stringify(actual[name])} != ${JSON.stringify(exp)}`).toBe(
        exp.geoHex
      );
    }
  });

  it('the four known collision venues are pinned individually, by name', () => {
    // These four are the entire reason this stream exists: activenet and citycalendar both
    // carry them, byte-identically named, with coordinates up to ~802 m apart, and today the
    // stored value is whichever ran last. They are asserted BY NAME — not swept up in the
    // whole-fixture comparison above — so that a change to any one of them is legible in the
    // failure output without cross-referencing a 50-entry JSON file.
    //
    // Britannia is pinned alongside them as the CONVERGED control: the two tables agree on it
    // (venue-geo.ts adopted citycalendar's measurably better point), so it must NOT move under
    // any order, before or after the fix. If Britannia ever starts moving, the convergence has
    // been undone and the other four are the least of the problem.
    const collisions: Record<string, { lat: number; lng: number }> = {
      'killarney community centre': { lat: 49.2274, lng: -123.0444 },
      'kitsilano community centre': { lat: 49.2621, lng: -123.1601 },
      'renfrew park community centre': { lat: 49.2524, lng: -123.043 },
      'trout lake community centre': { lat: 49.2553, lng: -123.0655 },
      'britannia community centre': { lat: 49.2757, lng: -123.0714 },
    };
    for (const [name, expected] of Object.entries(collisions)) {
      const got = baselineRun.get(name);
      expect(got, `${name} must resolve to a coordinate`).toBeDefined();
      expect(got!.lat, `${name} latitude`).toBeCloseTo(expected.lat, 6);
      expect(got!.lng, `${name} longitude`).toBeCloseTo(expected.lng, 6);
    }
    // The four that are NOT britannia must equal venue-geo.ts's value, sourced from the table
    // itself — a hardcoded literal would only guard one side of the disagreement.
    for (const name of [
      'killarney community centre',
      'kitsilano community centre',
      'renfrew park community centre',
      'trout lake community centre',
    ]) {
      const ours = VANCOUVER_VENUE_GEO[name];
      expect(baselineRun.get(name)!.lat, `${name} must win from venue-geo.ts`).toBeCloseTo(ours.lat, 6);
      expect(baselineRun.get(name)!.lng, `${name} must win from venue-geo.ts`).toBeCloseTo(ours.lng, 6);
    }
  });

  // ── (2) order independence ────────────────────────────────────────────────────────

  it('resolution is byte-identical under EVERY permutation of the contested producers', async () => {
    // Exhaustive, not sampled, over the producers that actually contest a venue — because a
    // producer that shares no venue name with any other cannot affect another's outcome, so
    // permuting it proves nothing and permuting all N! of them is not affordable. The
    // contested set is COMPUTED from the emissions, so a future third contestant is permuted
    // automatically instead of needing someone to remember to add it.
    const byName = new Map<string, Set<string>>();
    for (const p of declaredProducerOrder()) {
      for (const e of p.emissions) {
        const k = dbKey(e.venueName);
        byName.set(k, (byName.get(k) ?? new Set()).add(p.id));
      }
    }
    const contested = new Set<string>();
    for (const producers of byName.values()) {
      if (producers.size > 1) for (const id of producers) contested.add(id);
    }
    expect(
      contested.size,
      'too many contested producers to permute exhaustively — narrow the set deliberately, do not sample silently'
    ).toBeLessThanOrEqual(5);

    const order = declaredProducerOrder();
    const contestedProducers = order.filter((p) => contested.has(p.id));
    const rest = order.filter((p) => !contested.has(p.id));

    for (const perm of permutations(contestedProducers)) {
      const token = newToken();
      const got = await ingestAll(pool, [...rest, ...perm], token);
      for (const [name, exp] of baselineRun) {
        expect(
          got.get(name)?.geoHex,
          `${name} changed coordinate under producer order [${perm.map((p) => p.id).join(', ')}]`
        ).toBe(exp.geoHex);
      }
    }
  });

  it('resolution is byte-identical under a full REVERSE of the declared order', async () => {
    // The cheap adversarial case, kept separate from the exhaustive one above because it also
    // permutes the UNcontested producers — proving the "uncontested cannot matter" reasoning
    // the exhaustive test relies on, rather than assuming it.
    const got = await ingestAll(pool, [...declaredProducerOrder()].reverse(), newToken());
    for (const [name, exp] of baselineRun) {
      expect(got.get(name)?.geoHex, `${name} changed coordinate under the reversed order`).toBe(exp.geoHex);
    }
  });

  it('re-running the same order twice changes nothing (idempotent)', async () => {
    const token = newToken();
    await ingestAll(pool, declaredProducerOrder(), token);
    const second = await ingestAll(pool, declaredProducerOrder(), token);
    for (const [name, exp] of baselineRun) {
      expect(second.get(name)?.geoHex, `${name} moved on a repeat ingest`).toBe(exp.geoHex);
    }
  });

  // ── (3) the measurement Phase C is gated on ───────────────────────────────────────

  it('MEASUREMENT — same-place-different-name splits reachable by normalisation', () => {
    // A by-product, reported rather than acted on (scoping doc §7.3). The known collisions are
    // BYTE-IDENTICAL names two producers both carry. The inverse — two DIFFERENT names for one
    // physical place — splits a venue across two rows, two pins and two result sets, and is
    // invisible by construction because there is no collision to trip a test.
    //
    // What this measures is the reachable half only: names that differ ONLY by case,
    // punctuation or whitespace, i.e. exactly the class `resolveVenue`'s `lower(name)`
    // predicate misses and a shared normalisation helper would catch. It deliberately does NOT
    // measure the unreachable half (venue-geo.ts's three hand-resolved aliases:
    // Kitsilano ⟷ Kitsilano War Memorial, RayCam ⟷ Ray-Cam, - Aberthau ⟷ West Point Grey),
    // because no automatic rule reaches those and a number that pretended otherwise would be
    // the false-merge risk the scope explicitly refuses to build toward.
    const aggressive = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const byAggressive = new Map<string, Set<string>>();
    for (const p of declaredProducerOrder()) {
      for (const e of p.emissions) {
        const k = aggressive(e.venueName);
        byAggressive.set(k, (byAggressive.get(k) ?? new Set()).add(dbKey(e.venueName)));
      }
    }
    const splits = [...byAggressive.entries()]
      .filter(([, dbKeys]) => dbKeys.size > 1)
      .map(([k, dbKeys]) => `${k}: ${[...dbKeys].sort().join(' | ')}`)
      .sort();

    // Pinned at the MEASURED value, not asserted to be zero: the number is the input to the
    // Phase C go/no-go, so it must fail loudly if it moves in either direction.
    expect(splits, 'normalisation-reachable venue-identity splits across the committed tables').toEqual([]);
  });
});

/** All orderings of `items`. Guarded to a contested set of ≤5 by the caller (120 max). */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
  );
}
