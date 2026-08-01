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
// WHY THIS IS NOT `source.authority_tier`. That column (`source`, 0003_core_places.sql)
// ranks who published the PROGRAMMING. This ranks who measured the COORDINATE. They are
// orthogonal, and the counterexample is the system's own most important source: ActiveNet is
// `official` for Vancouver drop-in schedules and is simultaneously the worst geo source in
// the product for pools and rinks, because no City dataset covers them at all and their
// points are hand-placed. Reusing that column would have been a category error that looked
// like reuse.
//
// EVERY RUNG IS A MEASUREMENT ALREADY IN THE REPO, not an intuition. The justifications are
// on each constant. The gaps between rungs are deliberate: new tiers are expected, and
// inserting one should not require renumbering the others (or migrating a CHECK).

export const VENUE_GEO_AUTHORITY = {
  /**
   * 50 — admin manual listing, entered by a human in-product
   * (`app/admin/listings/`). Outranks everything because a person looked at THIS specific
   * venue on purpose. The form range-validates lat/lng — see `parseManualListingInput` in
   * `_lib/vocab.ts` (named, not line-numbered: a line range into a form-validation file is a
   * citation that goes stale on somebody else's unrelated edit).
   */
  ADMIN_MANUAL: 50,

  /**
   * 40 — curated coordinate carrying per-entry provenance
   * (`worker/adapters/activenet/venue-geo.ts` entries with `source: 'curated'`). The only
   * producer in the system with real provenance: `source` + `attribution` + `derivedFrom`
   * per entry. Outranks committed open data because the City's point is sometimes the wrong
   * building on a shared campus: the Britannia convergence measured 139-172 m closer to the
   * building than `community-centres` did, and the pool/rink/arena facilities the City
   * publishes no dataset for at all carry ~74% of measured Vancouver drop-in occurrences per
   * week — the curated entries are the load-bearing half, not the residue.
   *
   * NO COUNT IS RESTATED HERE, deliberately, and this is not fastidiousness — an earlier
   * draft of this comment carried a hardcoded "N of 36 are hand-placed" and it was WRONG, in
   * a way no test could catch, in the file that calls itself the canonical definition. The
   * measured split lives in `VANCOUVER_VENUE_GEO_PROVENANCE`
   * (worker/adapters/activenet/venue-geo.ts), where a test pins it against the actual table.
   * Read it there; a copy here would be unfalsifiable and would drift again.
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
   * Address-derived, so it is the weakest claim in the system.
   *
   * THE CANONICAL STATEMENT OF WHY IT KEEPS ITS OWN `AND geo IS NULL`, which the other three
   * sites point at instead of restating: this tier outranks LEGACY_UNATTRIBUTED, so the
   * authority rule ALONE would newly permit the weakest source in the system to overwrite
   * every legacy hand-placed coordinate in the database with an address-derived guess — a
   * regression introduced by a change whose whole purpose is to protect coordinates. The
   * ordinal is a CEILING on what a writer may do, not a licence; an individual path may be
   * stricter, and this one is. Note the rungs are spaced so new tiers can be inserted, so
   * "5 > 0" is a relation between these two constants, not a fact about the literals 5 and 0.
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
