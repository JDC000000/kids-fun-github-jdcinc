// worker/adapters/venue/config.ts — G-T11-3: launch venue config (TSD §5.1
// Adapter D, source family `venue_html`, PRD §8 fam 4-5).
//
// A "venue" source is a museum / attraction whose PUBLIC website publishes two
// kinds of facts as semi-structured HTML: standing OPEN HOURS (a daily-admission
// state) and one-off SPECIAL EVENTS (dated programmes). The adapter reads the
// schema.org structured data these pages embed (openingHours + Event JSON-LD) —
// the machine-readable layer publishers add for SEO/consumption — never a
// headless render of a JS-only widget, never a login/booking flow.
//
// Config-driven: a new venue is a data entry here, not new code. Default mode is
// fixture-only (zero network). A venue's LIVE path is gated behind BOTH the DB
// terms gate (worker/core/terms-gate.ts — terms_status allowed/summarise_only +
// robots_status allowed) AND the env allow-list KIDS_FUN_LIVE_VENUES=<venueKey>,
// and is only offered for venues explicitly marked liveCapable after a real
// robots.txt + ToS review (see docs/source-register.md §2 / the Round 22 audit).
//
// ── Compliance review, performed live 2026-07-20 (Round 22 / Task LL) ─────────
// Checked candidate Metro Vancouver museums/attractions' actual robots.txt + ToS
// BEFORE choosing what to build against (same discipline as T35's source
// register). Result:
//   • H.R. MacMillan Space Centre (spacecentre.ca) — robots.txt: `User-agent: *`
//     Disallow /wp-admin/ only, Crawl-delay 10; ToS (/terms-of-service/) is
//     purely commercial (tickets/refunds) with NO automated-access, scraping or
//     reproduction restriction; /plan-your-visit/ embeds schema.org
//     EntertainmentBusiness openingHours. Public WP REST (/wp-json) is open.
//     → CLEARED for a live open-hours fetch (liveCapable).
//   • Vancouver Aquarium (vanaqua.org) — robots.txt itself returns an Akamai
//     "Access Denied" (active bot-blocking). Automated access is NOT clearly
//     permitted → EXCLUDED from any live fetch (fixture-only; liveCapable omitted).
//     Retained here only as a synthetic-fixture shape example (matches the
//     G-T11-2 "Aquarium daily visit ≠ swim" acceptance criterion); it makes ZERO
//     network calls.
//   • Museum of Vancouver (Squarespace) — robots.txt blocks ClaudeBot/anthropic-ai
//     et al. AND disallows the machine-readable ?format=json/?format=ical
//     endpoints → restrictive, NOT built against.
//   • Science World (scienceworld.ca) — robots allows all + only a BC-PIPA
//     privacy policy (no reuse restriction), BUT its WP REST API is
//     security-restricted (401) and its events listing is JS-rendered, so there
//     is no clean, headless-free machine path → NOT in the launch set.
//
// Posture matches T35 / the whole codebase: attribute-and-summarise (store short
// factual records + a link back to the venue's official page, never wholesale
// editorial copy), and fail-closed (a venue stays fixture-only until it is BOTH
// DB-cleared and env-enabled).

export type CostStatus = 'known' | 'free' | 'unknown' | 'check_source';

export interface VenueGeo {
  /** Deterministic public coordinates — no live geocoder at ingest (same
   *  principle as the library/citycalendar adapters). */
  lat?: number;
  lng?: number;
}

/** One synthetic special-event fact used to build a fixture page (no network). */
export interface VenueFixtureEvent {
  slug: string;
  title: string;
  /** ISO 8601 UTC; kept in the FUTURE so the occurrence is search-visible. */
  startDatetimeUtc: string;
  endDatetimeUtc?: string;
  typicalAgeRange?: string;
  costStatus?: CostStatus;
  url?: string;
}

export interface VenueConfig {
  /** Registry/env key, e.g. 'hr-macmillan-space-centre'. */
  venueKey: string;
  /** Venue (and source.name) display name. */
  venueName: string;
  municipality: string;
  /** source.family in supabase/seeds/sources.sql. */
  sourceFamily: 'venue_html';
  /** source.name in supabase/seeds/sources.sql (registry key). */
  sourceName: string;
  /** Official public landing page (channel-level source URL). */
  officialUrl: string;
  /** Open-hours admission category — never a rec-programme category (T-02). */
  venueCategory: 'attraction' | 'museum_venue';
  address?: string;
  displayArea?: string;
  geo?: VenueGeo;
  /** Title for the standing open-hours record. Default "General Admission". */
  admissionLabel?: string;
  /** Admission cost posture; venue admission is typically paid → 'check_source'. */
  admissionCostStatus?: CostStatus;
  /** Live open-hours source: public page embedding schema.org openingHours. */
  hoursUrl?: string;
  /** Live special-events source: public page embedding schema.org Event nodes. */
  eventsUrl?: string;
  /** Compliance-cleared for a live fetch (robots + ToS verified). Absent => fixture-only. */
  liveCapable?: boolean;
  /** Hard cap on events per live fetch. */
  liveEventsLimit?: number;
  /** schema.org openingHours value used to synthesise the fixture hours page. */
  fixtureOpenHours: string;
  /** Synthetic special events used to synthesise the fixture events page. */
  fixtureEvents: VenueFixtureEvent[];
}

export const LAUNCH_VENUES: VenueConfig[] = [
  {
    // FIXTURE-ONLY. vanaqua.org actively blocks automated access (Akamai
    // "Access Denied" on robots.txt), so this venue is never live-fetched — it is
    // kept purely as the canonical G-T11-2 shape example (daily visit ≠ swim).
    venueKey: 'vancouver-aquarium',
    venueName: 'Vancouver Aquarium',
    municipality: 'Vancouver',
    sourceFamily: 'venue_html',
    sourceName: 'Vancouver Aquarium',
    officialUrl: 'https://www.vanaqua.org/',
    venueCategory: 'attraction',
    address: '845 Avison Way, Vancouver, BC V6G 3E2',
    displayArea: 'Stanley Park',
    // Deterministic public coordinates for the Stanley Park site (no geocoder).
    geo: { lat: 49.3006, lng: -123.131 },
    admissionLabel: 'General Admission',
    admissionCostStatus: 'check_source',
    // liveCapable intentionally omitted → fixture-only, zero network.
    fixtureOpenHours: 'Mo-Su 09:30-17:00',
    fixtureEvents: [
      {
        slug: 'sensory-friendly-morning-2026-08-15',
        title: 'Sensory-Friendly Morning',
        startDatetimeUtc: '2026-08-15T16:00:00.000Z', // 9:00 AM PDT
        endDatetimeUtc: '2026-08-15T18:00:00.000Z',
        typicalAgeRange: 'All ages',
        costStatus: 'check_source',
      },
      {
        slug: 'ocean-after-hours-2026-09-12',
        title: 'Ocean After Hours',
        startDatetimeUtc: '2026-09-13T02:00:00.000Z', // 7:00 PM PDT, Sep 12
        endDatetimeUtc: '2026-09-13T05:00:00.000Z',
        typicalAgeRange: '19+',
        costStatus: 'check_source',
      },
    ],
  },
  {
    // LIVE-CAPABLE (open hours only). spacecentre.ca robots permits it
    // (Disallow /wp-admin/ + Crawl-delay 10) and its ToS carries no
    // automated-access restriction; /plan-your-visit/ embeds schema.org
    // EntertainmentBusiness openingHours. Live special-events stay OFF: the
    // venue's event dates are only in JS-rendered / Divi markup (no schema.org
    // Event, no clean date field in WP REST), so wiring them would require a
    // headless render — the exact ‹L3› boundary this task does not cross. The
    // schema.org Event PARSER exists and is fixture-verified, so a venue that
    // does publish Event JSON-LD works without code changes.
    venueKey: 'hr-macmillan-space-centre',
    venueName: 'H.R. MacMillan Space Centre',
    municipality: 'Vancouver',
    sourceFamily: 'venue_html',
    sourceName: 'H.R. MacMillan Space Centre',
    officialUrl: 'https://www.spacecentre.ca/',
    venueCategory: 'museum_venue',
    address: '1100 Chestnut St, Vancouver, BC V6J 3J9',
    displayArea: 'Vanier Park',
    // Deterministic public coordinates for the Vanier Park site (no geocoder).
    geo: { lat: 49.2762, lng: -123.1448 },
    admissionLabel: 'General Admission',
    admissionCostStatus: 'check_source',
    hoursUrl: 'https://www.spacecentre.ca/plan-your-visit/',
    liveCapable: true,
    liveEventsLimit: 25,
    // Real schema.org openingHours value published on /plan-your-visit/.
    fixtureOpenHours: 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday 09:00-17:00',
    // Real event titles from the venue's public WP REST event list.
    fixtureEvents: [
      {
        slug: 'perseid-skywatching-101-2026-08-12',
        title: 'Perseid: Skywatching 101',
        startDatetimeUtc: '2026-08-13T03:00:00.000Z', // 8:00 PM PDT, Aug 12
        endDatetimeUtc: '2026-08-13T05:00:00.000Z',
        typicalAgeRange: 'All ages',
        costStatus: 'check_source',
      },
      {
        slug: 'space-camp-saturday-cosmology-2026-09-19',
        title: 'Space Camp Saturday: Cosmology',
        startDatetimeUtc: '2026-09-19T16:00:00.000Z', // 9:00 AM PDT
        endDatetimeUtc: '2026-09-19T23:00:00.000Z',
        typicalAgeRange: 'Ages 6-12',
        costStatus: 'check_source',
      },
    ],
  },
];

export function getVenue(venueKey: string): VenueConfig | undefined {
  return LAUNCH_VENUES.find((v) => v.venueKey === venueKey);
}
