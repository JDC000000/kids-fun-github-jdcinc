// worker/core/venue-geo-authority.ts — the coordinate-authority ordinal, and the ONE
// place it is defined.
//
// WHAT PROBLEM THIS SOLVES. `venue.geo` has eight independent producers and, until
// migration 0025, no rule about which of them wins. The stored coordinate was whichever
// adapter's cron ran last — observable today as four Vancouver venues (Killarney,
// Kitsilano, Renfrew Park, Trout Lake) that activenet and citycalendar both carry, up to
// ~802 m apart, whose stored point changes with ingest order. This ordinal is the missing
// comparison.
//
// THE WRITE RULE, stated once, here, because it is the whole mechanism:
//
//     A coordinate is written iff it is non-NULL AND (the stored geo is NULL OR the
//     incoming authority is STRICTLY GREATER than the stored authority).
//
//     Higher authority wins. EQUAL authority leaves the incumbent. Lower authority never
//     overwrites — it fills a NULL only.
//
// WHY "EQUAL AUTHORITY LEAVES THE INCUMBENT" IS NOT THE WHOLE STORY, stated plainly rather
// than left as an assumption of the design: strictly-greater is order-independent only
// while no two EQUAL-authority producers disagree about a venue. If two tier-20 config
// tables ever claim the same venue name with different points, the stored value goes back
// to depending on which one ran first and this ordinal will NOT save it. That invariant is
// asserted mechanically over the committed tables in tests/geo/venue-geo-golden.test.ts
// ("no two EQUAL-authority producers disagree about a venue"). It is NOT assertable for
// the three LIVE tier-10 producers, whose emissions are unbounded — that residual is real
// and is recorded here rather than in a doc nobody reads.
//
// WHY THIS IS NOT `source.authority_tier`. That column (0003_core_places.sql:21) ranks who
// published the PROGRAMMING. This ranks who measured the COORDINATE. They are orthogonal,
// and the counterexample is the system's own most important source: ActiveNet is
// `official` for Vancouver drop-in schedules and is simultaneously the worst geo source in
// the product for pools and rinks, because no City dataset covers them and 12 of the 36
// Vancouver points are hand-placed. Reusing that column would have been a category error
// that looked like reuse.
//
// EVERY RUNG IS A MEASUREMENT ALREADY IN THE REPO, not an intuition. The justifications are
// on each constant. The gaps between rungs are deliberate: new tiers are expected, and
// inserting one should not require renumbering the others (or migrating a CHECK).

export const VENUE_GEO_AUTHORITY = {
  /**
   * 50 — admin manual listing, entered by a human in-product
   * (`app/admin/listings/`). Outranks everything because a person looked at THIS specific
   * venue on purpose. The form range-validates lat/lng (`_lib/vocab.ts:113-124`).
   */
  ADMIN_MANUAL: 50,

  /**
   * 40 — curated coordinate carrying per-entry provenance
   * (`worker/adapters/activenet/venue-geo.ts` entries with `source: 'curated'`). The only
   * producer in the system with real provenance: `source` + `attribution` + `derivedFrom`
   * per entry. Measured: 12 of the 36 Vancouver points are hand-placed pool/rink/arena
   * facilities the City publishes no dataset for at all, and they carry ~74% of measured
   * Vancouver drop-in occurrences/week. The Britannia convergence measured 139-172 m
   * closer to the building than the City's own community-centres point.
   */
  CURATED_PROVENANCED: 40,

  /**
   * 30 — a point taken verbatim from a licensed open dataset for that exact facility
   * (`venue-geo.ts` entries with `source: 'opendata-vancouver'`). Below hand-curation
   * because the City's site-level point is sometimes the wrong building on a shared campus
   * — which is precisely what the Britannia measurement showed — but above an unattributed
   * config literal because it is traceable to a named record in a named dataset.
   */
  COMMITTED_OPEN_DATA: 30,

  /**
   * 20 — a coordinate literal committed in an adapter's own config
   * (citycalendar's `venueGeo`, `worker/adapters/venue/config.ts`'s `geo`, library's
   * `branchLocations`). Curated by a human, but with no per-entry provenance and no
   * recorded measurement, so there is nothing to audit it against.
   */
  ADAPTER_CONFIG_LITERAL: 20,

  /**
   * 10 — a coordinate read LIVE from a third-party payload on every run: library's
   * `bc:latitude`/`bc:longitude` (BiblioCommons RSS), perfectmind's inline `Address` block,
   * eventbrite's API. Unreviewed, with no committed value to diff against and no alarm if
   * the vendor moves the point. Ranked below every curated source for that reason — a
   * silently-changing coordinate is a strictly worse failure mode than a stale one, because
   * a stale one at least holds still.
   *
   * NOT MEASURED: whether these values actually drift between runs. The code paths are
   * confirmed; the volatility is not. Logged as a separate probe, not assumed either way.
   */
  LIVE_VENDOR_PAYLOAD: 10,

  /**
   * 5 — the out-of-band Mapbox geocoder backfill (`scripts/backfill-venue-geo.ts`).
   * Address-derived, so it is the weakest claim in the system. It keeps its own
   * `AND geo IS NULL` predicate ON TOP of this ordinal: 5 outranks 0, so the authority rule
   * ALONE would newly permit it to overwrite every legacy coordinate in the database with a
   * geocoded guess. The ordinal is a ceiling on what a writer may do, not a licence.
   */
  GEOCODER_BACKFILL: 5,

  /**
   * 0 — pre-0025 incumbents, stamped by the migration's backfill. Nobody knows which of the
   * eight producers wrote them, and guessing would be the exact mistake
   * docs/source-register.md §6.6 records. Every declared source outranks them, once, which
   * is the intended one-time settling event.
   */
  LEGACY_UNATTRIBUTED: 0,
} as const;

export type VenueGeoAuthority = (typeof VENUE_GEO_AUTHORITY)[keyof typeof VENUE_GEO_AUTHORITY];
