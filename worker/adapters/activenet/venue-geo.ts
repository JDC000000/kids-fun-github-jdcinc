// worker/adapters/activenet/venue-geo.ts — G-VENUE-1: committed facility-geo constant
// for the Vancouver ActiveCommunities tenant.
//
// ─────────────────────────────────────────────────────────────────────────────
// ATTRIBUTION — required by the licence, do not remove.
//
//   Contains information licensed under the Open Government Licence – Vancouver
//   https://opendata.vancouver.ca/pages/licence/
//
// Source dataset: `community-centres` (City of Vancouver open data), 27 records,
// dataset `modified` = 2020-03-16T10:01:39+00:00 (six years stale, and static by
// nature — it is a list of buildings, not a schedule).
// Supplementary Vancouver open dataset, same licence: `property-addresses`
// (civic address → point), used for the two facilities that have their own civic
// address and no community-centres record.
// Three coordinates come from OpenStreetMap (© OpenStreetMap contributors, ODbL,
// https://www.openstreetmap.org/copyright) — flagged per-entry as
// `attribution: 'osm-odbl'`, so they render the ODbL notice and NOT the OGL one.
// (Two until 2026-08-01, when Britannia Rink moved onto its own OSM building footprint.)
//
// NOTE, recorded rather than glossed: the licence TEXT is not readable from this
// infrastructure. opendata.vancouver.ca/pages/licence/ answers 200 but is a JS-rendered
// shell with no prose in the HTML, and vancouver.ca's canonical OGL page returns 403 to
// us (measured 2026-07-31 — the same 403 that killed `urllink`, below). The licence
// IDENTITY is verified from the dataset's own `license`/`license_url` metadata. The
// posture is fail-safe: the attribution renders unconditionally wherever this data
// surfaces, which satisfies the condition under any reading of it.
// See docs/source-register.md §6.6.
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY A COMMITTED CONSTANT AND NOT AN ADAPTER. This is the same shape the codebase
// already uses twice for venue geo — `venueGeo` in worker/adapters/citycalendar/config.ts
// ("Deterministic, no geocoder") and the `geo` literals in worker/adapters/venue/config.ts.
// The open-data fetch was run ONCE, BY HAND, as a derivation step on 2026-07-31; its
// result is frozen below. There is NO network call here, at runtime, ever. A scheduled
// re-fetch of a file that last changed in 2020 would be pure cost and a permanent
// staleness-alarm false positive.
//
// KEYED ON THE ACTIVENET NAME, NOT THE OPEN-DATA NAME. Measured 2026-07-31: **0 of 36**
// Vancouver ActiveNet centre names match an open-data name on `lower(name)` — the exact
// predicate worker/core/venue.ts::resolveVenue uses. Open data says `Hastings`; the feed
// says `Hastings Community Centre`. Every alias is therefore resolved HERE, at authoring
// time, visibly, by a human — never by runtime fuzzy matching, where the ~10% that
// mis-matches would be silently wrong. Each entry records the open-data name it was
// derived from in `derivedFrom`.
//
// Of the 36 centres ActiveNet's `centerdetails` returns for Vancouver:
//   • 21 resolve to an open-data record by dropping the "Community Centre"/"Recreation"
//     suffix,
//   •  3 are genuine ALIASES that no normalisation would reach:
//        Kitsilano Community Centre            ⟷ open data "Kitsilano War Memorial"
//        RayCam Co-operative Centre            ⟷ open data "Ray-Cam Co-Operative Center"
//                                                (hyphen AND US spelling)
//        West Point Grey Community Centre - Aberthau ⟷ open data "West Point Grey"
//   • 12 are pools, rinks and an arena with NO `community-centres` record at all. 7 take
//     the co-located centre's point (shared civic address, verified in centerdetails),
//     2 resolve against the OGL `property-addresses` dataset, and 3 come from
//     OpenStreetMap — 2 in parkland, in neither City dataset, plus Britannia Rink, which
//     has its own OSM building footprint and moved off the campus site-point on
//     2026-08-01. All 12 are hand-placed.
//
// THE COVERAGE LIMIT, STATED SO NOBODY MISREADS THIS FILE AS "VANCOUVER GEO SOLVED".
// Vancouver publishes no pool, rink, arena or swimming dataset (catalogue searches
// 2026-07-31: pool 0 · rink 0 · arena 0 · swimming 0 hits). ~74% of measured Vancouver
// drop-in occurrences/week happen at those 12 pool/rink/arena facilities — i.e. at
// venues the licensed open dataset cannot locate. Those coordinates are curated,
// per-entry attributed, and are the reason this file exists at all; the open-data join
// is a labour-saver for the community centres, not the substance.
// See docs/source-register.md §6.6.
//
// COORDINATE SOURCE, as opposed to NAME resolution — the two are counted separately and
// it matters: 25 entries take their point verbatim from a City dataset, 11 are
// hand-placed. That is one fewer City point than there are name-matched community
// centres, because `britannia community centre` deliberately does NOT use the City's
// point — see the measured reason on that entry.
//
// `urllink` WAS DELIBERATELY NOT IMPORTED. 24 of the 27 open-data records point at the
// retired `http://vancouver.ca/parks/cc/<name>/index.htm` scheme; only 3 use the current
// `/parks-recreation-culture/*.aspx` form, and vancouver.ca returns 403 to this
// infrastructure under both a bot UA and a browser UA, so none of them are verifiable
// from here. Surfacing probably-dead links to a parent is worse than surfacing none.
//
// THREE OPEN-DATA RECORDS ARE DELIBERATELY NOT SEEDED: `Carnegie Centre`,
// `Evelyne Saller Centre` and `Gathering Place Community Centre` — the only 3 of the 27
// that appear in NO ActiveNet centre roster. Carnegie and Evelyne Saller are Downtown
// Eastside social-service centres (the dataset's own description files Carnegie under
// Community Services, not Parks & Rec). A venue with no programming is not enrichment.
// (The 2026-07-31 scoping doc estimated "6 non-programme centres" from the 5 sampled
// CALENDARS; measured against the full 36-centre `centerdetails` roster the real number
// is 3. Recorded here as the corrected figure.)
//
// Provenance is PER ENTRY (`source` + `attribution` + `derivedFrom`), not per file,
// because this table mixes an OGL-licensed dataset, an OGL-licensed address dataset,
// human co-location judgement, and two ODbL points. Anyone auditing a single coordinate
// can see exactly where it came from without re-deriving the whole table. The three
// fields do different jobs and are deliberately not collapsed into one:
//   `source`      — WHO placed it (open data verbatim, vs. a human).
//   `attribution` — WHICH licence notice must render when this venue is published. A
//                   legal notice is never inferred from a free-text string.
//   `derivedFrom` — the audit trail, in prose.
// Note `source` and `attribution` are independent, in BOTH directions: the 8 co-located
// pool/rink entries are `curated` (a human judged the co-location) but still carry the
// City's coordinate, so they still require OGL attribution — while `britannia community
// centre` is `curated` from this project's own prior work and therefore owes NO
// third-party notice at all, so it omits `attribution` entirely. Omission is a claim,
// not a default, and the entry that makes it explains itself.

/** Where one coordinate came from. `opendata-vancouver` = lifted verbatim from an
 *  OGL-licensed City of Vancouver dataset record for that exact facility/address.
 *  `curated` = a human placed it (co-location judgement, or a non-City source). */
export type VenueGeoSource = 'opendata-vancouver' | 'curated';

/** Which licence notice this coordinate obliges us to publish. */
export type VenueGeoAttributionKey = 'ogl-vancouver' | 'osm-odbl';

export interface ActiveNetVenueGeo {
  lat: number;
  lng: number;
  /** City of Vancouver `geo_local_area` (neighbourhood), for display + area filtering. */
  displayArea?: string;
  source: VenueGeoSource;
  /**
   * Third-party licence notice this coordinate obliges us to publish. Explicit, never
   * inferred. ABSENT means no third-party notice is owed — the point is this project's
   * own curation (see `britannia community centre`). Absent is not a default: it is a
   * claim in itself, and every entry that omits it says why in `derivedFrom`.
   */
  attribution?: VenueGeoAttributionKey;
  /** Exactly how this coordinate was obtained — auditable without re-deriving. */
  derivedFrom: string;
}

/** Attribution string mandated by the Open Government Licence – Vancouver, VERBATIM.
 *  The licence's one hard condition. Rendered wherever these venues surface to a user
 *  (the condition is about publication, not source code) — docs/source-register.md §6.6. */
export const OGL_VANCOUVER_ATTRIBUTION =
  'Contains information licensed under the Open Government Licence – Vancouver';

export const OGL_VANCOUVER_LICENCE_URL = 'https://opendata.vancouver.ca/pages/licence/';

export interface VenueGeoAttribution {
  key: VenueGeoAttributionKey;
  /** Exact notice text to render. */
  text: string;
  /** Licence the notice links to. */
  url: string;
}

const ATTRIBUTIONS: Readonly<Record<VenueGeoAttributionKey, VenueGeoAttribution>> = Object.freeze({
  'ogl-vancouver': {
    key: 'ogl-vancouver',
    text: OGL_VANCOUVER_ATTRIBUTION,
    url: OGL_VANCOUVER_LICENCE_URL,
  },
  'osm-odbl': {
    key: 'osm-odbl',
    text: '© OpenStreetMap contributors',
    url: 'https://www.openstreetmap.org/copyright',
  },
});

/** The one-time derivation, recorded so the numbers in this file are checkable. */
export const VANCOUVER_VENUE_GEO_PROVENANCE = Object.freeze({
  datasetId: 'community-centres',
  datasetUrl:
    'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/community-centres/records?limit=100',
  datasetModified: '2020-03-16T10:01:39+00:00',
  supplementaryDatasetId: 'property-addresses',
  licence: 'Open Government Licence - Vancouver',
  licenceUrl: OGL_VANCOUVER_LICENCE_URL,
  derivedAt: '2026-07-31',
  /** Facilities in the tenant's centerdetails roster at derivation time. */
  activeNetCentresCovered: 36,
  /** Of those, how many took their coordinate straight from a City dataset. */
  fromOpenData: 25,
  /** …and how many a human placed. */
  curated: 11,
  /**
   * The 12 pools, rinks and the arena that have NO `community-centres` record at all, split by
   * where their coordinate actually came from. The header states this breakdown in prose; these
   * fields are what make that prose checkable.
   *
   * ADDED 2026-08-01 after QA noticed that `fromOpenData` / `curated` /
   * `activeNetCentresCovered` were test-pinned against the real table and this breakdown was
   * NOT — so it was the one set of numbers in the file free to drift. That is the same defect
   * class this stream had just spent a commit fixing elsewhere, in the file whose entire value
   * is that its numbers can be trusted, so it is closed rather than noted.
   *
   * THE CLASSIFICATION IS DISJOINT AND ORDER-SENSITIVE, which is exactly why it is worth
   * pinning in code rather than restating in prose: two of the co-located entries ALSO mention
   * `property-addresses` in their `derivedFrom`, so a naive per-marker count returns 7/4/3 = 14
   * and quietly contradicts the header. Measured before writing this: OSM first (by
   * attribution), then co-located, then whatever resolves against `property-addresses`.
   */
  noCommunityCentreRecord: 12,
  /** …of which: co-located on a centre's shared civic address. */
  coLocated: 7,
  /** …resolved against the OGL `property-addresses` dataset. */
  fromPropertyAddresses: 2,
  /** …and sourced from OpenStreetMap (© OpenStreetMap contributors, ODbL). */
  fromOpenStreetMap: 3,
} as const);

/**
 * Vancouver ActiveNet facility name (normalised — see `normaliseVenueGeoKey`) → geo.
 *
 * Names are exactly what `stripCentreSentinel()` emits for the 36 centres in
 * worker/adapters/activenet/__fixtures__/vancouver.centerdetails.json, lowercased.
 * FROZEN: this is a committed derivation, not a cache. Changing a coordinate is a
 * reviewed code change with a stated source, which is the entire point.
 */
export const VANCOUVER_VENUE_GEO: Readonly<Record<string, ActiveNetVenueGeo>> = Object.freeze({
  // ── Community centres: coordinate lifted verbatim from the `community-centres`
  //    dataset record named in `derivedFrom` (OGL – Vancouver). ──────────────────
  // The ONE entry that does not take the City's coordinate, and the reason is measured.
  // The `community-centres` point for Britannia (49.2756, -123.0738) is a site-level
  // point ~250 m west of the actual community-centre building — the Britannia campus
  // spans a full block and the buildings sit on its east side. citycalendar/config.ts
  // already carried a better, building-level point for this exact venue name, verified
  // here against two independent OpenStreetMap POIs at 1661 Napier Street (Britannia CC
  // 49.2755396/-123.0703378, VPL Britannia Branch 49.2749646/-123.0707081): the City's
  // point is 251 m / 235 m away, citycalendar's is 79 m / 96 m — better by 139-172 m.
  //
  // Adopting citycalendar's value VERBATIM (not a third, "more correct" point) is
  // deliberate: `worker/core/venue.ts::resolveVenue` overwrites geo on every ingest
  // (`geo = COALESCE(<incoming>, geo)` — incoming wins whenever it is non-null), so two
  // adapters holding different points for the same venue name make the stored coordinate
  // CHURN with ingest order. Byte-identical values make the churn unobservable for this
  // venue, which matters more here than the last 79 m: Britannia is the highest-volume
  // venue in this table. Excluding the entry instead was considered and rejected — it
  // would leave Britannia with NO coordinates whenever the city-calendar source is not
  // enabled (it is env-gated), and would make `venuesWithoutGeo` name Britannia on every
  // run, degrading the exact warning G-VENUE-2 exists to keep meaningful.
  //
  // NO `attribution`: this point is the project's own curation, not City data, so
  // claiming the OGL over it would be the same false-provenance error QA F1 caught.
  'britannia community centre': {
    lat: 49.2757, lng: -123.0714, displayArea: 'Grandview-Woodland',
    source: 'curated',
    derivedFrom:
      'citycalendar/config.ts venueGeo "britannia community centre" (this project\'s own prior hand-curation), adopted verbatim to converge the two tables. Measured 2026-07-31 as 139-172 m closer to the community-centre building than community-centres "Britannia" (49.2756, -123.0738), against two OSM POIs at 1661 Napier Street. The City\'s site-level point is retained for Britannia Pool and Britannia Rink, which are separate buildings on the same campus with no better per-building source.',
  },
  'champlain heights community centre': {
    lat: 49.2144, lng: -123.0321, displayArea: 'Killarney',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Champlain Heights"',
  },
  'coal harbour community centre': {
    lat: 49.2902, lng: -123.1259, displayArea: 'Downtown',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Coal Harbour"',
  },
  'creekside community recreation centre': {
    lat: 49.2718, lng: -123.1056, displayArea: 'Mount Pleasant',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Creekside"',
  },
  'douglas park community centre': {
    lat: 49.2529, lng: -123.1213, displayArea: 'South Cambie',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Douglas Park"',
  },
  'dunbar community centre': {
    lat: 49.2428, lng: -123.1883, displayArea: 'Dunbar-Southlands',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Dunbar"',
  },
  'false creek community centre': {
    lat: 49.2694, lng: -123.134, displayArea: 'Fairview',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "False Creek"',
  },
  'hastings community centre': {
    lat: 49.2809, lng: -123.0393, displayArea: 'Hastings-Sunrise',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Hastings"',
  },
  'hillcrest community centre': {
    lat: 49.2438, lng: -123.1079, displayArea: 'Riley Park',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Hillcrest"',
  },
  'kensington community centre': {
    lat: 49.2385, lng: -123.0755, displayArea: 'Kensington-Cedar Cottage',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Kensington"',
  },
  'kerrisdale community centre': {
    lat: 49.2332, lng: -123.1571, displayArea: 'Kerrisdale',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Kerrisdale"',
  },
  'killarney community centre': {
    lat: 49.2274, lng: -123.0444, displayArea: 'Killarney',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Killarney"',
  },
  // ALIAS 1 of 3 — no normalisation reaches this; resolved by hand.
  'kitsilano community centre': {
    lat: 49.2621, lng: -123.1601, displayArea: 'Kitsilano',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver',
    derivedFrom: 'community-centres "Kitsilano War Memorial" (ALIAS, hand-resolved)',
  },
  'marpole-oakridge community centre': {
    lat: 49.2145, lng: -123.1275, displayArea: 'Marpole',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Marpole-Oakridge"',
  },
  'mount pleasant community centre': {
    lat: 49.2643, lng: -123.1002, displayArea: 'Mount Pleasant',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Mount Pleasant"',
  },
  // ALIAS 2 of 3 — hyphen AND US spelling differ.
  'raycam co-operative centre': {
    lat: 49.2807, lng: -123.0841, displayArea: 'Strathcona',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver',
    derivedFrom: 'community-centres "Ray-Cam Co-Operative Center" (ALIAS, hand-resolved)',
  },
  'renfrew park community centre': {
    lat: 49.2524, lng: -123.043, displayArea: 'Renfrew-Collingwood',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Renfrew Park"',
  },
  'roundhouse community arts and recreation centre': {
    lat: 49.2733, lng: -123.1217, displayArea: 'Downtown',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Roundhouse"',
  },
  'strathcona community centre': {
    lat: 49.2798, lng: -123.0915, displayArea: 'Strathcona',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Strathcona"',
  },
  'sunset community centre': {
    lat: 49.2229, lng: -123.1006, displayArea: 'Sunset',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Sunset"',
  },
  'thunderbird community centre': {
    lat: 49.2636, lng: -123.0321, displayArea: 'Hastings-Sunrise',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Thunderbird"',
  },
  'trout lake community centre': {
    lat: 49.2553, lng: -123.0655, displayArea: 'Kensington-Cedar Cottage',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "Trout Lake"',
  },
  'west end community centre': {
    lat: 49.2899, lng: -123.1361, displayArea: 'West End',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver', derivedFrom: 'community-centres "West End"',
  },
  // ALIAS 3 of 3 — the feed appends the heritage-house name "- Aberthau".
  'west point grey community centre - aberthau': {
    lat: 49.2718, lng: -123.2045, displayArea: 'West Point Grey',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver',
    derivedFrom: 'community-centres "West Point Grey" (ALIAS, hand-resolved)',
  },

  // ── Pools, rinks and an arena. NONE of these has an open-data record: Vancouver
  //    publishes no pool/rink/arena/swimming dataset (0 catalogue hits, 2026-07-31).
  //    These 12 carry ~74% of measured Vancouver drop-in occurrences, so they are the
  //    part of this file that actually matters — and every one is hand-placed. ──────
  //
  //    8 of the 12 share a civic address with a community centre in the roster above
  //    (verified against `address1` in vancouver.centerdetails.json), i.e. they are the
  //    pool/rink wing of that same site, so they take that site's OGL coordinate. That
  //    is a human co-location judgement layered on open data, so it is classed
  //    `curated`, not `opendata-vancouver`.
  'britannia pool': {
    lat: 49.2756, lng: -123.0738, displayArea: 'Grandview-Woodland',
    source: 'curated', attribution: 'ogl-vancouver',
    derivedFrom:
      'co-located: shares civic address 1661 Napier Street with Britannia Community Centre (ActiveNet centerdetails); point from community-centres "Britannia" — the City\'s SITE-level point, deliberately kept here even though the community-centre entry itself now uses a building-level point, because no per-building source exists FOR THE POOL. Narrowed 2026-08-01: this sentence used to say "for the pool or the rink" and the rink half became false when OSM way 32896473 was adopted for it. Re-measured at the same time rather than assumed — an Overpass sweep of the whole Britannia campus (49.2735,-123.0765,49.2780,-123.0685) returns a named building for the icerink, the community centre, both schools and the library, and NOTHING for a pool. The claim holds for this entry, and it holds because it was checked.',
  },
  // CORRECTED 2026-08-01 (registry round 56 / venue-geo QA session d33dea61), and this
  // entry is the reason the file records `derivedFrom` per entry at all: the previous
  // point was FAITHFUL to its stated source and still 236 m from the building. It was
  // the City's SITE-level point for the whole Britannia campus, inherited because no
  // per-building source was known to exist. One does — OSM carries the rink as its own
  // named building footprint — and OSM is a source this table already trusts and cites
  // for two other facilities, so this introduces no new source class. Not a defect in
  // the shipped code; an accuracy improvement that had been logged and never dispatched.
  'britannia rink': {
    lat: 49.276, lng: -123.0706, displayArea: 'Grandview-Woodland',
    source: 'curated', attribution: 'osm-odbl',
    derivedFrom:
      'OpenStreetMap way 32896473 "Britannia Icerink" (leisure=ice_rink, sport=ice_skating, 1661 Parker Street) — the rink\'s own building footprint. Verified 2026-08-01 against the OSM API directly: the way\'s polygon centroid (49.2759622, -123.0705506) and Overpass\'s bbox centre (49.2759951, -123.0706414) are two independent derivations that agree at this file\'s 4dp convention, so the stored value is not an artefact of one method (rounding cost 3-6 m). Replaces the City community-centres "Britannia" SITE-level point, measured 236 m away. Sanity check: 67 m from the Britannia Community Centre building point, consistent with a separate building on the same campus rather than a duplicate of it. © OpenStreetMap contributors, ODbL',
  },
  'hillcrest aquatic centre': {
    lat: 49.2438, lng: -123.1079, displayArea: 'Riley Park',
    source: 'curated', attribution: 'ogl-vancouver',
    derivedFrom:
      'co-located: shares civic address 4575 Clancy Loranger Way with Hillcrest Community Centre (ActiveNet centerdetails) — one building; point from community-centres "Hillcrest"',
  },
  'hillcrest rink': {
    lat: 49.2438, lng: -123.1079, displayArea: 'Riley Park',
    source: 'curated', attribution: 'ogl-vancouver',
    derivedFrom:
      'co-located: shares civic address 4575 Clancy Loranger Way with Hillcrest Community Centre (ActiveNet centerdetails) — one building; point from community-centres "Hillcrest"',
  },
  'kensington pool': {
    lat: 49.2385, lng: -123.0755, displayArea: 'Kensington-Cedar Cottage',
    source: 'curated', attribution: 'ogl-vancouver',
    derivedFrom:
      'co-located: shares civic address 5175 Dumfries Street with Kensington Community Centre (ActiveNet centerdetails); point from community-centres "Kensington"',
  },
  'killarney pool': {
    lat: 49.2274, lng: -123.0444, displayArea: 'Killarney',
    source: 'curated', attribution: 'ogl-vancouver',
    derivedFrom:
      'co-located: shares civic address 6260 Killarney Street with Killarney Community Centre (ActiveNet centerdetails); point from community-centres "Killarney", cross-checked against property-addresses 6260 KILLARNEY ST (49.22741, -123.04439)',
  },
  'renfrew park pool': {
    lat: 49.2524, lng: -123.043, displayArea: 'Renfrew-Collingwood',
    source: 'curated', attribution: 'ogl-vancouver',
    derivedFrom:
      'co-located: shares civic address 2929 E 22nd Avenue with Renfrew Park Community Centre (ActiveNet centerdetails); point from community-centres "Renfrew Park", cross-checked against property-addresses 2929 E 22ND AV (49.25242, -123.04296). NOTE: citycalendar/config.ts carries a different, older hand-curated point for its own Trumba-named "renfrew pool" (49.2506, -123.0432) — ~200 m south. Different adapter, different key space; not reconciled here.',
  },
  'trout lake rink': {
    lat: 49.2553, lng: -123.0655, displayArea: 'Kensington-Cedar Cottage',
    source: 'curated', attribution: 'ogl-vancouver',
    derivedFrom:
      'co-located: ActiveNet gives 3350 Victoria Drive, community-centres gives 3360 Victoria Drive for Trout Lake Community Centre — same site, the rink is in that building; point from community-centres "Trout Lake"',
  },

  //    2 have their OWN civic address and a matching OGL `property-addresses` record,
  //    so these two are genuine open data, not judgement.
  'kerrisdale cyclone taylor arena': {
    // displayArea is a DISPLAY-ONLY override — the one entry in this table where the
    // City's own value is not used verbatim, called out here rather than done quietly.
    // The City's geo_local_area for this point is "Shaughnessy" (both the
    // property-addresses record and an OSM reverse agree), because the local-area
    // boundary runs along the Arbutus corridor immediately west of the arena. That is
    // correct as a statistical boundary and wrong as a wayfinding label: the facility
    // is named "Kerrisdale Cyclone Taylor Arena", sits 300 m from Kerrisdale Community
    // Centre, and every parent in the city calls it Kerrisdale. This field's job is to
    // help someone find the place, so it says Kerrisdale; the City's published value is
    // preserved in derivedFrom, so nothing about the provenance is lost. The COORDINATE
    // is untouched — only the human-facing label.
    lat: 49.2359, lng: -123.1535, displayArea: 'Kerrisdale',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver',
    derivedFrom:
      'property-addresses 5670 EAST BOULEVARD (49.235893, -123.153463); OSM cross-check agrees to ~75 m. displayArea DISPLAY-ONLY OVERRIDE: the City\'s own geo_local_area for this point is "Shaughnessy" (Arbutus-corridor boundary artefact); shown as "Kerrisdale" because that is the facility\'s own name and how it is found. Coordinate unchanged.',
  },
  'templeton park pool': {
    lat: 49.2785, lng: -123.0588, displayArea: 'Grandview-Woodland',
    source: 'opendata-vancouver', attribution: 'ogl-vancouver',
    derivedFrom:
      'property-addresses 700 TEMPLETON DRIVE (49.278538, -123.058837); OSM cross-check agrees to ~30 m. (ActiveNet centerdetails gives postal code V6G 1Z4 for this site, which is a West End prefix and is wrong; the civic address is right and is what was resolved.)',
  },

  //    2 are in parkland with no `property-addresses` parcel record and no
  //    community-centres record. Sourced from OpenStreetMap, which carries both as
  //    named facility nodes at their exact ActiveNet civic address.
  //    © OpenStreetMap contributors, ODbL — https://www.openstreetmap.org/copyright
  'lord byng pool': {
    lat: 49.2595, lng: -123.1928, displayArea: 'West Point Grey',
    source: 'curated', attribution: 'osm-odbl',
    derivedFrom:
      'OpenStreetMap named node "Lord Byng Pool", 3990 West 14th Avenue (49.2594948, -123.1928355) — matches the ActiveNet civic address exactly. No City dataset covers this facility. © OpenStreetMap contributors, ODbL',
  },
  'sunset rink': {
    lat: 49.2232, lng: -123.0982, displayArea: 'Sunset',
    source: 'curated', attribution: 'osm-odbl',
    derivedFrom:
      'OpenStreetMap named node "Sunset Rink", 390 East 51st Avenue (49.2232263, -123.0982101) — matches the ActiveNet civic address exactly. Distinct from Sunset Community Centre (6810 Main St), ~190 m west. No City dataset covers this facility. © OpenStreetMap contributors, ODbL',
  },
});

/** Per-tenant geo tables. Only Vancouver has one — Burnaby's 7 centres and West
 *  Vancouver's zero were never derived, and pretending otherwise would be worse
 *  than the honest gap `venuesWithoutGeo` reports. */
const TENANT_VENUE_GEO: Readonly<Record<string, Readonly<Record<string, ActiveNetVenueGeo>>>> =
  Object.freeze({
    vancouver: VANCOUVER_VENUE_GEO,
  });

/** Lowercase + collapse whitespace. Deliberately NOT a fuzzy normaliser: it will not
 *  strip a "Community Centre" suffix or a hyphen, because every such divergence is
 *  resolved by hand above. A name that does not hit is reported, never guessed at. */
export function normaliseVenueGeoKey(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when this tenant has a curated geo table at all. */
export function hasVenueGeoTable(tenantKey: string): boolean {
  return Object.prototype.hasOwnProperty.call(TENANT_VENUE_GEO, tenantKey);
}

/** Exact (normalised) lookup. No fuzzy fallback, by design. */
export function lookupVenueGeo(
  tenantKey: string,
  venueName: string | undefined | null
): ActiveNetVenueGeo | undefined {
  if (!venueName) return undefined;
  const table = TENANT_VENUE_GEO[tenantKey];
  if (!table) return undefined;
  return table[normaliseVenueGeoKey(venueName)];
}

/**
 * Every licence notice this project is obliged to publish because it ships these
 * tables — derived from the entries themselves, deduplicated, in a stable order.
 *
 * ── WHY THIS TAKES NO ARGUMENTS. Read before "improving" it back. ────────────────
 * The first version of this was `venueGeoAttribution(venueName)`: look the name up,
 * return that entry's notice, render it on the venue's detail panel. It shipped, and
 * QA proved it renders a FALSE provenance claim today, in default fixture mode, on a
 * live parent-facing surface — `trout-lake-public-skate` ("Trout Lake Rink"),
 * `killarney-skate-lessons` and `l-opengym-van` ("Britannia Community Centre") all
 * showed "licensed under the OGL – Vancouver" for coordinates that never came from
 * the City. `worker/adapters/citycalendar/config.ts` independently carries 5 keys
 * byte-identical to this table's names with DIFFERENT coordinates (up to 802 m
 * apart), and `resolveVenue()` matches on `lower(name)` and OVERWRITES geo
 * (`geo = COALESCE(<incoming>, geo)` — last-writer-wins), so the venue row a parent
 * sees may have been written by an entirely different adapter, and changes with
 * ingest order.
 *
 * The root cause was not the missing tenant check. It was that **a venue name is not
 * provenance**, and the UI has no access to the provenance of the coordinate it is
 * displaying — the `venue` table carries no attribution column and `Activity` carries
 * no coordinates, only a derived `distanceKm`. Any per-record notice on that surface
 * is therefore an inference, and this module's own header forbids inferring a legal
 * notice from a string. Gating on `sourceName` was considered and rejected: it is the
 * same mistake one layer down (`sourceName` is just `new URL(sourceUrl).hostname`),
 * and it does not even fix the reported cases — two of QA's three reproductions have
 * `sourceName: 'vancouver.ca'`, which is also the City-calendar adapter's own host.
 *
 * A SITE-WIDE notice has none of that fragility, because it makes no claim about any
 * individual venue. "This product contains information licensed under the OGL –
 * Vancouver" is unconditionally TRUE for as long as this table ships, cannot misfire
 * on a name collision, and is the normal, accepted way to satisfy an OGL (and the
 * ODbL) — neither licence requires a per-record badge. So the condition is still met
 * in code and still derived from the data, just at the granularity the data can
 * actually support. Rendered by `app/_components/SiteFooter.tsx`.
 *
 * A future entry using a new source automatically appears here with no UI change.
 */
export function requiredGeoAttributions(): VenueGeoAttribution[] {
  const keys = new Set<VenueGeoAttributionKey>();
  for (const table of Object.values(TENANT_VENUE_GEO)) {
    for (const entry of Object.values(table)) {
      if (entry.attribution) keys.add(entry.attribution);
    }
  }
  return (Object.keys(ATTRIBUTIONS) as VenueGeoAttributionKey[])
    .filter((k) => keys.has(k))
    .map((k) => ATTRIBUTIONS[k]);
}
