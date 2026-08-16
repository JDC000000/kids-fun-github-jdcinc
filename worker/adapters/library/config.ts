// worker/adapters/library/config.ts — G-T9-1/2: Library system config
// (TSD §5.1 Adapter B). One adapter family across library systems, selected by
// platform: BiblioCommons/BiblioEvents (VPL/Richmond-style), Communico/Libnet
// (Coquitlam), and a plain namespace-less RSS 2.0 feed (`generic_rss`, NVDPL —
// added 2026-07-31 under decision record D-12). Storytime / early-learning events
// carry strong age/date/branch metadata on the first two platforms; on generic_rss
// almost everything has to be recovered from free text (see ./generic-rss.ts).

export type LibraryPlatform = 'bibliocommons' | 'communico' | 'generic_rss';

export interface LibrarySystemConfig {
  systemKey: string;
  systemName: string;
  platform: LibraryPlatform;
  /** source.family in supabase/seeds/sources.sql. */
  sourceFamily: 'library_bibliocommons' | 'library_communico' | 'library_generic_rss';
  /** source.name in supabase/seeds/sources.sql. */
  sourceName: string;
  feedBaseUrl: string;
  /**
   * Whether this system has a REVIEWED live path at all — the config half of the
   * live-fetch gate, alongside the KIDS_FUN_LIVE_LIBRARY_SYSTEMS env allow-list and the
   * DB terms_status/robots_status gate.
   *
   * WHY THIS IS EXPLICIT RATHER THAN INFERRED FROM `platform`. The gate used to read
   * `platform === 'bibliocommons'`, which quietly conflated "this platform has a parser"
   * with "this tenant is cleared to be fetched". Adding a third platform would have made
   * that check a growing list of platform names, and it had no way to express the
   * Aquarium-style case the venue adapter already needs — a source with a working parser
   * that must NEVER go live. Naming a tenant in the env var is not sufficient on its
   * own; this flag must also be true. Absent/false ⇒ fixture-only, forever, whatever
   * the env says.
   */
  liveCapable?: boolean;
  /** Public BiblioCommons gateway endpoint (JSON); only used when explicitly live-enabled. */
  gatewayEventsUrl?: string;
  /**
   * Public RSS/XML events feed. On `bibliocommons` this is the ToS-permitted path
   * (see below); on `generic_rss` it is the ONLY path the source exposes.
   *
   * Preferred live path where present:
   * the BiblioCommons Terms of Use prohibit automated harvesting "except as may be
   * specifically permitted using RSS/XML feeds", so this is the ToS-compliant
   * mechanism for automated ingestion. When set, it takes priority over
   * gatewayEventsUrl in fetch(). (KIDS FUN Task 5 — VPL enablement, 2026-07-13.)
   */
  rssEventsUrl?: string;
  /** Hard cap per request for live approved-source dry-runs. */
  liveEventsLimit?: number;
  /**
   * Which of THIS tenant's RSS `<category>` values are genuine AUDIENCE tags, as anchored
   * patterns. Only these are read as claims about who a programme is for.
   *
   * AN ALLOWLIST, NOT A DENYLIST, AND NOT "JUST USE THE TAGS". The `<category>` list is a flat
   * mixture of audiences, topics, languages, programme brands and series names, and the two
   * live tenants do NOT share a vocabulary. Reading the raw list as an audience taxonomy is a
   * measured defect, not a hypothetical: Richmond publishes the TOPIC tag "Child Development"
   * (it sits beside "Parenting" and "Literacy, Reading, Writing"), and it contains the word
   * "child", so the age normaliser's broad kids/children rule scores it 5-11. RPL's own
   * Babytime and Play & Learn — both genuinely 0-24 months, both correctly tagged "Baby" —
   * were consequently ALSO published as matching 5-9 and 10-14.
   *
   * Vancouver never showed this because its audience tags happen to be the only child-shaped
   * strings in its vocabulary. Richmond's real audience tags carry a distinct `Children-`
   * prefix that "Child Development" does not share, which is precisely what a topic tag cannot
   * be trusted to respect. Ground-truthed against both live feeds on 2026-08-16.
   *
   * DIRECTION OF FAILURE IS THE POINT. An allowlist that misses a NEW audience tag loses a
   * signal and falls back to the description prose — the behaviour that shipped before any of
   * this. A denylist that misses a NEW topic tag publishes a wrong age band to a parent. The
   * two are not symmetric, so the safe default is "not an audience tag unless named", and a
   * system with NO patterns configured is treated as having no audience taxonomy at all.
   */
  audienceTagPatterns?: RegExp[];
  /** Deterministic branch/location metadata used for venue rows; no live geocoder. */
  branchLocations?: Record<string, LibraryBranchLocation>;
}

export interface LibraryBranchLocation {
  address: string;
  /**
   * Curated `branchLocations` entries always carry coordinates; a location parsed
   * live from an RSS item may not (e.g. an online / desk / virtual location whose
   * bc:location block omits bc:latitude/longitude). Coords are therefore optional
   * so a geo-less item still keeps its name / address / municipality provenance
   * instead of being dropped entirely.
   */
  lat?: number;
  lng?: number;
  /**
   * Where lat/lng came from, for coordinate-authority purposes (worker/core/
   * venue-geo-authority.ts). ABSENT means CURATED — every entry hand-written in this file
   * is curated by definition, so the config tables say nothing and mean tier 20. The RSS
   * parser sets it explicitly to 'feed' when it took the coordinate from the vendor's own
   * `bc:latitude`/`bc:longitude` (tier 10, unreviewed and able to move silently between
   * runs) and to 'curated' when it fell back to the entry below.
   *
   * This is the one producer whose authority genuinely varies PER RECORD rather than per
   * adapter, which is why the discriminator lives on the location object and not on the
   * system config.
   */
  coordsFrom?: 'curated' | 'feed';
  municipalityName: string;
  displayArea: string;
  locationUrl: string;
}

/**
 * NVDPL — North Vancouver District Public Library, the family's 4th tenant and the only
 * `generic_rss` one (decision record D-12, 2026-07-31).
 *
 * COMPLIANCE, STATED PLAINLY RATHER THAN SOFTENED: NVDPL's robots.txt is UNREADABLE —
 * `nvdpl.events.mylibrary.digital/robots.txt` answers HTTP 403 behind a Cloudflare managed
 * challenge. Under this project's own T11 precedent (Vancouver Aquarium, excluded for the
 * identical reason) an unreadable robots.txt is FAIL-CLOSED, not cleared. Jon personally
 * accepted that risk for **NVDPL by name** on 2026-07-31, on the strength of the argument
 * that an RSS feed is by definition published for automated syndication — the same
 * intended-for-syndication bar that made the BiblioCommons feeds tractable. That override
 * does NOT reopen the Aquarium exclusion and does NOT make "unreadable robots.txt is fine"
 * a project policy; any other source with this fact pattern needs its own routed decision.
 * Full reasoning: docs/source-register.md §6.8 + decision record D-12.
 *
 * The override does not discharge the rest of the compliance work: the feed is fetched
 * with one plain unauthenticated GET through the shared politeFetch seam, no cookie is
 * ever sent (the host DOES set a PHPSESSID on the response — we neither store nor return
 * it), and live enablement still needs all three gates (liveCapable + env allow-list + DB
 * terms_status/robots_status). Flipping it live is an operator action, not this config's.
 */
const NVDPL_SYSTEM: LibrarySystemConfig = {
  systemKey: 'nvdpl',
  systemName: 'North Vancouver District Public Library',
  platform: 'generic_rss',
  sourceFamily: 'library_generic_rss',
  sourceName: 'North Vancouver District Public Library Events RSS',
  feedBaseUrl: 'https://nvdpl.events.mylibrary.digital/event',
  // Reviewed live path exists (D-12). Still OFF until named in
  // KIDS_FUN_LIVE_LIBRARY_SYSTEMS *and* cleared in the DB — see liveCapable's doc comment.
  liveCapable: true,
  rssEventsUrl: 'https://nvdpl.events.mylibrary.digital/rss',
  // Live-measured 2026-07-31: 97 items in a rolling ~1-month window, of which 42 classify
  // kid-relevant (41 emit; the 42nd is a multi-day range). The earlier 47 here was the
  // pre-QA-F-A figure that counted 5 adult "Summer Reading Rave" occurrences as kid
  // programming — see docs/source-register.md §6.8.3.
  // 60 leaves real headroom over that without letting an unexpectedly large
  // window ingest unbounded. Exceeding it is COUNTED (`droppedByLimit`, rendered in the run's
  // tally line) but does NOT alert: the `truncated_by_limit` verdict was deleted because a cap
  // below vendor supply drops records on every healthy run and none on a genuinely short one
  // — see the deletion note in ./run-health.ts.
  liveEventsLimit: 60,
  /**
   * Curated NVDPL locations. This feed has NO location element of any kind, so these are
   * the only names an item's title or description prose can be resolved against.
   *
   * WHY THERE ARE NO COORDINATES HERE, DELIBERATELY. Coordinates would have to come from
   * either a geocoder (this adapter never calls one, by project rule) or from memory
   * (which is fabrication). So every entry carries name + municipality and only carries an
   * `address` where a verifiable public source supplied one — and the only one that did is
   * Viewlynn Park, whose street address NVDPL publishes in the feed payload itself. The
   * remaining branches are honestly geo-less: an item resolved to "Parkgate Library" gets a
   * venue name, "North Vancouver" for the region filter, and no map pin, rather than a
   * confident wrong pin. Filling these in is a job for the venue-geo constant workstream
   * (G-VENUE) against a verified dataset, not for this file to guess at.
   */
  branchLocations: {
    'Lynn Valley Library': {
      address: '',
      municipalityName: 'North Vancouver',
      displayArea: 'Lynn Valley',
      locationUrl: '',
    },
    'Capilano Library': {
      address: '',
      municipalityName: 'North Vancouver',
      displayArea: 'Capilano',
      locationUrl: '',
    },
    'Parkgate Library': {
      address: '',
      municipalityName: 'North Vancouver',
      displayArea: 'Parkgate',
      locationUrl: '',
    },
    // Off-site programming venues that appear in event TITLES ("Viewlynn Park Storytime",
    // "Summer Reading Rave at Seylynn Park"). Viewlynn's address is the feed's own
    // (`<p>2510 Viewlynn Dr</p><p>North Vancouver, BC</p><p>V7J 2X3</p>`), which the
    // address-block parser also picks up per-item; keeping it here means the venue still
    // resolves if NVDPL stops appending the block.
    'Viewlynn Park': {
      address: '2510 Viewlynn Dr, North Vancouver, BC V7J 2X3',
      municipalityName: 'North Vancouver',
      displayArea: 'Lynn Valley',
      locationUrl:
        'https://www.google.com/maps/search/?api=1&query=2510%20Viewlynn%20Dr%2C%20North%20Vancouver%2C%20BC%20V7J%202X3',
    },
    'Seylynn Park': {
      address: '',
      municipalityName: 'North Vancouver',
      displayArea: 'Seylynn',
      locationUrl: '',
    },
  },
};

export const LIBRARY_SYSTEMS: LibrarySystemConfig[] = [
  {
    systemKey: 'vpl',
    systemName: 'Vancouver Public Library',
    platform: 'bibliocommons',
    sourceFamily: 'library_bibliocommons',
    sourceName: 'Vancouver Public Library BiblioEvents',
    feedBaseUrl: 'https://vpl.bibliocommons.com/events',
    // ToS-compliant automated-access path: the BiblioCommons public RSS/XML feed
    // (one paginated GET, no login, no headless browser, no CAPTCHA). Each item
    // carries structured venue geo (bc:latitude/longitude/street/city) and UTC
    // start/end, so ingest never calls an external geocoder. Live-enabled via
    // KIDS_FUN_LIVE_LIBRARY_SYSTEMS=vpl after the Task-5 terms/robots check.
    liveCapable: true,
    rssEventsUrl: 'https://gateway.bibliocommons.com/v2/libraries/vpl/rss/events',
    liveEventsLimit: 25,
    // VPL's audience vocabulary, verbatim from the live feed (2026-08-16). Everything else it
    // publishes is a topic, a language or a series — "Storytimes", "English", "Summer Reading
    // Club", "Activities & Games", "Meetups", "Computer & Technology Training", "Inspiration
    // Lab", "Advisory Groups", "Book Clubs & Reading Circles", "ESL Learners", "Newcomers".
    // Anchored so "Preschool Age Children" and "School Age Children" match as whole tags while
    // a topic that merely CONTAINS "children" cannot.
    audienceTagPatterns: [
      /^babies$/i,
      /^toddlers?$/i,
      /^preschool age children$/i,
      /^school age children$/i,
      /^teens?$/i,
      /^tweens?$/i,
      /^adults?$/i,
      /^seniors?$/i,
      /^families$/i,
      /^all ages$/i,
    ],
  },
  {
    systemKey: 'rpl',
    systemName: 'Richmond Public Library',
    platform: 'bibliocommons',
    sourceFamily: 'library_bibliocommons',
    sourceName: 'Richmond Public Library BiblioEvents',
    feedBaseUrl: 'https://yourlibrary.bibliocommons.com/events',
    // ToS-compliant automated-access path, migrated off the JSON gateway (KIDS
    // FUN Task 8, 2026-07-13). BiblioCommons' Terms of Use permit automated
    // harvesting only via RSS/XML feeds, so RPL — the original live source —
    // now uses the same public RSS feed as VPL (slug `yourlibrary`). Each item
    // carries structured venue geo (bc:latitude/longitude) and UTC start/end,
    // so ingest never calls an external geocoder. gatewayEventsUrl is
    // deliberately omitted: with no JSON fallback, RPL can never silently
    // regress onto the ToS-ambiguous gateway path. Live-enabled via
    // KIDS_FUN_LIVE_LIBRARY_SYSTEMS=rpl. NOTE: RSS and the retired JSON gateway
    // expose disjoint event-instance ids, so cutting existing RPL rows over to
    // RSS is a delete-and-replace, not an in-place upsert (see Task 8 findings).
    liveCapable: true,
    rssEventsUrl: 'https://gateway.bibliocommons.com/v2/libraries/yourlibrary/rss/events',
    liveEventsLimit: 20,
    // Richmond's audience vocabulary, verbatim from the live feed (2026-08-16). The `Children-`
    // prefix carries all three child audiences ("Children-All Ages", "Children-Preschool",
    // "Children-School Age") and is the exact distinction that keeps the TOPIC tag "Child
    // Development" out — it names a subject the programme is about, not who may attend, and
    // admitting it published RPL's 0-24-month Babytime and Play & Learn as 5-11 as well.
    //
    // `/^adults?$/i` is anchored for a reason of its own: RPL also publishes the SERIES tag
    // "Adult Summer Reading", which is a reading programme's name. Anchoring keeps the audience
    // "Adults" and rejects the series. "55+/Seniors" is matched as the tenant writes it.
    audienceTagPatterns: [
      /^children-/i,
      /^bab(?:y|ies|ytime)$/i,
      /^toddlers?$/i,
      /^teens?$/i,
      /^tweens?$/i,
      /^adults?$/i,
      /^(?:55\+\/)?seniors?$/i,
      /^families$/i,
      /^all ages$/i,
    ],
    // Deterministic Steveston fallback retained for reference; the live RSS path
    // derives venue geo directly from the feed's bc:location block per item.
    branchLocations: {
      'Steveston Library (Easthope Hub)': {
        address: '4320 Moncton St, Richmond, BC V7E 6T4',
        // Public Richmond map coordinates for RPL Steveston/Moncton area; kept
        // deterministic so ingest never calls an external geocoder.
        lat: 49.12546,
        lng: -123.1783832,
        municipalityName: 'Richmond',
        displayArea: 'Steveston',
        locationUrl: 'https://www.google.com/maps/search/?api=1&query=4320%20Moncton%20St%20Richmond%20BC%20V7E%206T4',
      },
    },
  },
  {
    systemKey: 'cpl',
    systemName: 'Coquitlam Public Library',
    platform: 'communico',
    sourceFamily: 'library_communico',
    sourceName: 'Coquitlam Public Library Communico',
    feedBaseUrl: 'https://coqlibrary.ca/events',
    // liveCapable deliberately omitted: Coquitlam has no reviewed live path (no feed URL
    // configured, no terms/robots check performed). Fixture-only. Previously this was
    // implied by `platform !== 'bibliocommons'`; now it is stated.
  },
  NVDPL_SYSTEM,
];

export function getLibrarySystem(systemKey: string): LibrarySystemConfig | undefined {
  return LIBRARY_SYSTEMS.find((s) => s.systemKey === systemKey);
}
