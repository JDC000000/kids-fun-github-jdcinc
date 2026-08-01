// tests/compliance/venue-geo-authority-declared.test.ts — G-VGEO-A3.
//
// THE GUARANTEE: every path in this repo that can put a coordinate into `venue.geo`
// declares where that coordinate RANKS. Not "every path we currently know about" —
// every path, discovered from the directory tree, so a ninth producer cannot appear
// without either declaring itself or failing this file by name.
//
// WHY THIS IS THE DURABLE HALF OF THE FIX. The authority-ranked write (G-VGEO-A2) fixes
// the eight producers that exist today. This test is what stops the ninth, and the ninth
// is not hypothetical: the producer count moved 3 → 6 → 8 across two deliberate scoping
// sweeps a day apart, and BOTH sweeps missed perfectmind and eventbrite, because those two
// attach coordinates inline in a parse step with no geo-shaped filename to grep for. If two
// focused audits cannot enumerate the producers, no adapter author will discover the
// pattern by looking around. It has to be enforced, not documented.
//
// SHAPE — the same shape as tests/compliance/no-bypass.test.ts, deliberately:
//
//   (A) DIRECTORY-DISCOVERED, PER-EMISSION-SITE. Every adapter family is discovered from
//       `worker/adapters/` rather than from a hand-kept list, every .ts file is read from
//       disk, its COMMENTS ARE STRIPPED (so a comment mentioning venueGeoAuthority cannot
//       satisfy the check), and every `venueLat:` emission site is examined inside its own
//       enclosing object literal.
//
//   (B) THE RAW-SQL BACKSTOP. `venue.geo` may be written by exactly two files. Any other
//       source file containing SQL that writes that column fails by name — that is the
//       hole a ninth producer would actually come through, since a hand-written INSERT
//       bypasses StructuredRecord entirely and (A) would never see it.
//
//   (C) THE ORDINAL IS PINNED, and the golden harness's independently re-declared copy of
//       it is cross-checked against the real one. tests/geo/venue-geo-golden.test.ts
//       deliberately hardcodes its own tier numbers so it cannot be defeated by editing the
//       code it polices; this is where the two are reconciled, so "independent" cannot
//       quietly become "wrong".
//
//   (D) TRIPWIRE SELF-CHECK. Synthetic snippets are fed through the same scanners to prove
//       each class is still caught. A scanner nobody has watched fail is a scanner nobody
//       should trust.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { VENUE_GEO_AUTHORITY } from '../../worker/core/venue-geo-authority';

const ROOT = process.cwd();

/** Strips block and line comments so a COMMENT can never satisfy a code assertion. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The declaration a `venueLat:` emission site must carry. The spread form is named
 * explicitly rather than matched loosely: library's authority genuinely varies per record
 * (feed coordinate vs curated fallback), so it declares through one shared helper instead of
 * inline — but only THAT helper counts, so a future `...someOtherSpread()` does not sneak
 * through on a substring match.
 */
const AUTHORITY_DECLARATION = /venueGeoAuthority|\.\.\.venueGeoDeclaration\(/;

/** Directories that hold real code (never fixtures, artefacts or the suite itself). */
const NON_CODE_DIRS = new Set(['__fixtures__', 'fixtures', '__snapshots__', 'node_modules']);

function walkTs(dir: string): string[] {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (NON_CODE_DIRS.has(entry.name)) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkTs(rel));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(rel);
  }
  return out.sort();
}

/**
 * Every `venueLat:` VALUE assignment in `src` (type declarations `venueLat?:` excluded), each
 * paired with the text of its enclosing object literal — found by walking backwards to the
 * literal's `{` and forwards to its balanced `}`. Per-site rather than per-file: a file that
 * emits two records, one declared and one not, must fail.
 */
function venueLatEmissionSites(src: string): string[] {
  const sites: string[] = [];
  const re = /venueLat\s*:/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    // `venueLat?:` is an interface field, not an emission.
    if (src.slice(Math.max(0, m.index - 1), m.index + 'venueLat'.length + 2).includes('?')) continue;

    let start = m.index;
    for (let depth = 0; start > 0; start -= 1) {
      const c = src[start];
      if (c === '}') depth += 1;
      else if (c === '{') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    let end = m.index;
    for (let depth = 0; end < src.length; end += 1) {
      const c = src[end];
      if (c === '{') depth += 1;
      else if (c === '}') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    sites.push(src.slice(start, end + 1));
  }
  return sites;
}

/** SQL that writes the `venue` table's geo column, in any of the shapes this repo uses. */
function writesVenueGeoSql(src: string): boolean {
  const insert = /INSERT\s+INTO\s+venue\s*\(([^)]*)\)/is.exec(src);
  if (insert && /\bgeo\b/i.test(insert[1])) return true;
  return /UPDATE\s+venue[\s\S]{0,400}?\bSET\b[\s\S]{0,400}?\bgeo\s*=/i.test(src);
}

/**
 * The ONLY two files permitted to write `venue.geo` directly.
 *
 * Declared here, in the test, rather than imported from anywhere — widening it must be an
 * edit to THIS file, which is the point. `scripts/backfill-venue-geo.ts` is on the list
 * because it is deliberately STRICTER than the shared writer (it keeps `AND geo IS NULL`, so
 * the geocoder still structurally cannot clobber), not because it is exempt from the rule.
 */
const SANCTIONED_VENUE_GEO_WRITERS = ['worker/core/venue.ts', 'scripts/backfill-venue-geo.ts'];

/** Source roots scanned. Tests are excluded — a fixture writing a row is not a producer. */
const SOURCE_ROOTS = ['worker', 'app', 'lib', 'scripts'];

/**
 * Files that mention `venueLat` WITHOUT being a coordinate producer — the admin form's own
 * intake layer, which parses and range-validates the two numbers a human typed and hands
 * them on. The venue write itself happens one layer down in `_lib/data.ts`, which declares
 * ADMIN_MANUAL.
 *
 * Every exemption is DECLARED HERE rather than inferred, so widening the list is an edit to
 * this file — and each one is PROVEN safe below (`an exempted file cannot secretly be a
 * producer`) by asserting it neither calls resolveVenue nor writes venue.geo in SQL. An
 * exemption that stops being true fails; it does not quietly hide a producer.
 */
const NON_PRODUCER_VENUELAT_FILES = [
  'app/admin/listings/_lib/vocab.ts',
  'app/admin/listings/actions.ts',
];

describe('(A) every coordinate emission declares an authority', () => {
  const adapterRoot = resolve(ROOT, 'worker/adapters');
  const families = readdirSync(adapterRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !NON_CODE_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();

  it('discovers the adapter families from disk, not from a list that can go stale', () => {
    // Not an exhaustive pin of WHICH families exist (adapters get added; that is normal) —
    // an assertion that discovery found a real tree, so a broken walk cannot make the scan
    // below vacuously green.
    expect(families.length).toBeGreaterThanOrEqual(6);
    expect(families).toContain('activenet');
    expect(families).toContain('perfectmind');
    expect(families).toContain('eventbrite');
  });

  it('every adapter file that emits venueLat declares venueGeoAuthority at the SAME emission site', () => {
    const undeclared: string[] = [];
    for (const family of families) {
      for (const file of walkTs(`worker/adapters/${family}`)) {
        const src = stripComments(readFileSync(resolve(ROOT, file), 'utf8'));
        venueLatEmissionSites(src).forEach((site, i) => {
          if (!AUTHORITY_DECLARATION.test(site)) undeclared.push(`${file} (emission site #${i + 1})`);
        });
      }
    }
    expect(
      undeclared,
      'a coordinate is being emitted with no declared authority — see worker/core/venue-geo-authority.ts'
    ).toEqual([]);
  });

  it('the same rule applies OUTSIDE worker/adapters — admin, lib and scripts included', () => {
    const undeclared: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of walkTs(root)) {
        if (file.startsWith('worker/adapters/')) continue;
        if (NON_PRODUCER_VENUELAT_FILES.includes(file)) continue;
        // worker/core/adapter.ts declares the FIELD; it emits nothing.
        const src = stripComments(readFileSync(resolve(ROOT, file), 'utf8'));
        venueLatEmissionSites(src).forEach((site, i) => {
          if (!AUTHORITY_DECLARATION.test(site)) undeclared.push(`${file} (emission site #${i + 1})`);
        });
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('an exempted file cannot secretly be a producer', () => {
    // The exemption list is only safe while its members genuinely do not reach the venue
    // row. Asserted, not assumed: the moment one of them starts calling the resolver or
    // writing the column, it stops being exempt and this fails naming it.
    for (const file of NON_PRODUCER_VENUELAT_FILES) {
      const src = stripComments(readFileSync(resolve(ROOT, file), 'utf8'));
      expect(src, `${file} is exempt but calls resolveVenue`).not.toMatch(/resolveVenue\s*\(/);
      expect(writesVenueGeoSql(src), `${file} is exempt but writes venue.geo`).toBe(false);
    }
  });

  it('the admin manual-listing path declares an authority for the coordinate a human typed', () => {
    // The admin form is producer #8, it does not go through StructuredRecord, and it used to
    // carry a private copy of the resolver that never updated geo at all. Named explicitly
    // because a generic scan would not distinguish "declares nothing" from "is not a
    // producer".
    const src = stripComments(readFileSync(resolve(ROOT, 'app/admin/listings/_lib/data.ts'), 'utf8'));
    expect(src).toMatch(/VENUE_GEO_AUTHORITY\.ADMIN_MANUAL/);
    expect(src, 'the admin path must go through the shared resolver, not a copy of it').toMatch(
      /resolveVenue\(client,/
    );
  });

  it('the geocoder backfill declares its tier AND keeps its stricter NULL-only predicate', () => {
    // Deleting this predicate would be an invisible, catastrophic, one-line regression in a
    // file nobody reads — which is why it is pinned mechanically rather than left to review.
    // Why it is load-bearing: `GEOCODER_BACKFILL` in worker/core/venue-geo-authority.ts.
    const src = stripComments(readFileSync(resolve(ROOT, 'scripts/backfill-venue-geo.ts'), 'utf8'));
    expect(src).toMatch(/VENUE_GEO_AUTHORITY\.GEOCODER_BACKFILL/);
    expect(src).toMatch(/WHERE id = \$1 AND geo IS NULL/);
  });
});

describe('(B) raw SQL cannot bypass the declaration', () => {
  it('only the two sanctioned writers touch venue.geo directly', () => {
    const offenders: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of walkTs(root)) {
        if (SANCTIONED_VENUE_GEO_WRITERS.includes(file)) continue;
        if (writesVenueGeoSql(stripComments(readFileSync(resolve(ROOT, file), 'utf8')))) {
          offenders.push(file);
        }
      }
    }
    expect(
      offenders,
      'a file is writing venue.geo with hand-written SQL, bypassing the authority rule entirely'
    ).toEqual([]);
  });

  it('the sanctioned writers are real files, so the allow-list cannot rot into a no-op', () => {
    for (const file of SANCTIONED_VENUE_GEO_WRITERS) {
      expect(statSync(resolve(ROOT, file)).isFile(), file).toBe(true);
      expect(writesVenueGeoSql(readFileSync(resolve(ROOT, file), 'utf8')), file).toBe(true);
    }
  });
});

describe('(C) the ordinal is pinned and the harness agrees with it', () => {
  it('the tier values are pinned — reordering them silently re-ranks every producer', () => {
    expect(VENUE_GEO_AUTHORITY).toEqual({
      ADMIN_MANUAL: 50,
      CURATED_PROVENANCED: 40,
      COMMITTED_OPEN_DATA: 30,
      ADAPTER_CONFIG_LITERAL: 20,
      LIVE_VENDOR_PAYLOAD: 10,
      GEOCODER_BACKFILL: 5,
      LEGACY_UNATTRIBUTED: 0,
    });
  });

  it('the golden harness\'s independently re-declared tiers match the real ordinal', () => {
    // The harness hardcodes its own numbers on purpose (a tripwire that reads its
    // expectations out of the code it polices can be widened by editing that code alone).
    // "Independent" must not be allowed to become "stale", so the two are reconciled HERE.
    const harness = readFileSync(resolve(ROOT, 'tests/geo/venue-geo-golden.test.ts'), 'utf8');
    const declared = (name: string): number =>
      Number(new RegExp(`const ${name}\\s*=\\s*(\\d+)\\s*;`).exec(harness)?.[1]);
    expect(declared('TIER_CURATED_PROVENANCED')).toBe(VENUE_GEO_AUTHORITY.CURATED_PROVENANCED);
    expect(declared('TIER_COMMITTED_OPEN_DATA')).toBe(VENUE_GEO_AUTHORITY.COMMITTED_OPEN_DATA);
    expect(declared('TIER_ADAPTER_CONFIG_LITERAL')).toBe(VENUE_GEO_AUTHORITY.ADAPTER_CONFIG_LITERAL);
  });

  it('the migration documents the same ordinal the code enforces', () => {
    // The DB comment is what a DBA reads out of `\d venue`; a stale one is a lie in the place
    // someone consults when the code is not to hand.
    const migration = readFileSync(
      resolve(ROOT, 'supabase/migrations/0025_venue_geo_provenance.sql'),
      'utf8'
    );
    for (const value of Object.values(VENUE_GEO_AUTHORITY)) {
      expect(migration, `tier ${value} is missing from the migration's documented ordinal`).toMatch(
        new RegExp(`\\b${value}\\b`)
      );
    }
  });
});

describe('(D) tripwire self-check — the scanners actually catch what they claim to', () => {
  const DECLARED = `
    const record = {
      venueName: name,
      venueLat: geo.lat,
      venueLng: geo.lng,
      venueGeoAuthority: VENUE_GEO_AUTHORITY.ADAPTER_CONFIG_LITERAL,
    };`;
  const UNDECLARED = `
    const record = {
      venueName: name,
      venueLat: geo.lat,
      venueLng: geo.lng,
    };`;
  const DECLARED_VIA_SPREAD = `
    const record = {
      venueLat: e.location?.lat,
      venueLng: e.location?.lng,
      ...venueGeoDeclaration(e.location, 'library:vpl'),
    };`;

  it('catches an emission with no declaration', () => {
    expect(venueLatEmissionSites(UNDECLARED).some((s) => AUTHORITY_DECLARATION.test(s))).toBe(false);
  });

  it('accepts an inline declaration and the named spread helper', () => {
    expect(venueLatEmissionSites(DECLARED).every((s) => AUTHORITY_DECLARATION.test(s))).toBe(true);
    expect(venueLatEmissionSites(DECLARED_VIA_SPREAD).every((s) => AUTHORITY_DECLARATION.test(s))).toBe(
      true
    );
  });

  it('is not satisfied by a COMMENT claiming the authority is declared', () => {
    const commentOnly = `
      const record = {
        // venueGeoAuthority: VENUE_GEO_AUTHORITY.ADMIN_MANUAL — declared upstream, honest
        venueLat: geo.lat,
        venueLng: geo.lng,
      };`;
    const sites = venueLatEmissionSites(stripComments(commentOnly));
    expect(sites.length).toBe(1);
    expect(AUTHORITY_DECLARATION.test(sites[0])).toBe(false);
  });

  it('does not mistake an interface FIELD declaration for an emission', () => {
    expect(venueLatEmissionSites('interface R { venueLat?: number; venueLng?: number; }')).toEqual([]);
  });

  it('catches a SECOND emission site in a file whose first one is declared', () => {
    // The case a per-FILE scan would miss entirely, and the likeliest real shape: an adapter
    // that already declares in one branch and gains a second branch that does not.
    const sites = venueLatEmissionSites(`${DECLARED}\n${UNDECLARED}`);
    expect(sites.length).toBe(2);
    expect(sites.filter((s) => !AUTHORITY_DECLARATION.test(s)).length).toBe(1);
  });

  it('catches raw SQL that writes venue.geo, in both the INSERT and UPDATE shapes', () => {
    expect(
      writesVenueGeoSql(`INSERT INTO venue (name, address, geo) VALUES ($1, $2, ST_MakePoint($3,$4))`)
    ).toBe(true);
    expect(writesVenueGeoSql(`UPDATE venue SET geo = ST_MakePoint($1,$2) WHERE id = $3`)).toBe(true);
    expect(
      writesVenueGeoSql(`UPDATE venue\n SET address = COALESCE($1, address),\n geo = $2\n WHERE id = $3`)
    ).toBe(true);
  });

  it('does not fire on venue writes that touch no coordinate', () => {
    expect(writesVenueGeoSql(`INSERT INTO venue (name, municipality_id) VALUES ($1, $2)`)).toBe(false);
    expect(writesVenueGeoSql(`UPDATE venue SET phone = COALESCE($1, phone) WHERE id = $2`)).toBe(false);
    expect(writesVenueGeoSql(`SELECT geo FROM venue WHERE id = $1`)).toBe(false);
  });
});
