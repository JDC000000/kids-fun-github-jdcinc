// worker/adapters/citycalendar/config.ts — KIDS FUN Task 9: city / parks
// public-calendar config (TSD §5.1 Adapter C, source family `city_calendar`).
//
// The live path consumes a municipality's PUBLIC calendar-syndication feed —
// the mechanism a city publishes expressly for external subscription (RSS /
// iCal / JSON), the same "intended-for-syndication" bar that made the library
// RSS feeds ToS-tractable. Launch tenant is the City of Vancouver events
// calendar (Trumba), whose feed carries Park Board / community-centre / pool /
// park programming — the recreation-adjacent coverage KIDS FUN had zero of.
// Config-driven: a new city is a data entry here, not new code.

export interface CityCalendarVenueGeo {
  /** Deterministic, venue-level public coordinates — NO live geocoder at ingest
   *  (same principle as the library adapter's branchLocations fallback). */
  lat: number;
  lng: number;
  address?: string;
  displayArea?: string;
}

export interface CityCalendarConfig {
  calendarKey: string;
  municipality: string;
  /** source.family in supabase/seeds/sources.sql. */
  sourceFamily: 'city_calendar';
  /** source.name in supabase/seeds/sources.sql (registry key). */
  sourceName: string;
  /** Public JSON syndication feed (plain GET, no auth/login/CAPTCHA). */
  feedUrl: string;
  /** Human landing page for the calendar (channel-level source URL). */
  calendarUrl: string;
  /** Hard cap per request for live approved-source dry-runs. */
  liveEventsLimit?: number;
  /**
   * Deterministic geo for recurring recreation venues. The Trumba feed exposes a
   * structured street address (via a Google-Maps `?q=` link) but no lat/lng, so
   * geo for well-known community-centre / pool / park venues is attached here
   * rather than by calling a geocoder during ingest. Keyed by normalised
   * (lowercased, trimmed) venue name. Unmapped venues still resolve as a venue
   * row (name + address + municipality); their geo stays NULL until enriched.
   */
  venueGeo?: Record<string, CityCalendarVenueGeo>;
}

export const CITY_CALENDARS: CityCalendarConfig[] = [
  {
    calendarKey: 'vancouver',
    municipality: 'Vancouver',
    sourceFamily: 'city_calendar',
    sourceName: 'City of Vancouver events calendar',
    // City of Vancouver events (Trumba). Trumba auto-publishes RSS/Atom/iCal/CSV/
    // JSON feeds for "calendar subscriptions or custom publishing of events";
    // trumba.com/robots.txt is `User-agent: * / Disallow:` (allows all robots).
    // Live-enabled via KIDS_FUN_LIVE_CITY_CALENDARS=vancouver after the Task-9
    // terms/robots check.
    feedUrl: 'https://www.trumba.com/calendars/city-of-vancouver-events.json',
    calendarUrl: 'https://vancouver.ca/news-calendar/calendar-of-events.aspx',
    liveEventsLimit: 40,
    // Venue-level public coordinates for the recreation venues that recur in the
    // City of Vancouver / Park Board feed. Deterministic, no geocoder.
    venueGeo: {
      'renfrew park community centre': { lat: 49.2596, lng: -123.0434, displayArea: 'Renfrew-Collingwood' },
      'renfrew pool': { lat: 49.2506, lng: -123.0432, address: '2929 East 22nd Ave, Vancouver, BC', displayArea: 'Renfrew-Collingwood' },
      'kitsilano community centre': { lat: 49.2637, lng: -123.1648, address: '2690 Larch St, Vancouver, BC', displayArea: 'Kitsilano' },
      'connaught park': { lat: 49.2637, lng: -123.1636, address: '2690 Larch St, Vancouver, BC', displayArea: 'Kitsilano' },
      'hastings park': { lat: 49.2819, lng: -123.0387, address: '2901 E Hastings St, Vancouver, BC', displayArea: 'Hastings-Sunrise' },
      'trout lake community centre': { lat: 49.2556, lng: -123.0656, address: '3360 Victoria Dr, Vancouver, BC', displayArea: 'Trout Lake' },
      'hillcrest centre': { lat: 49.2456, lng: -123.1078, address: '4575 Clancy Loranger Way, Vancouver, BC', displayArea: 'Riley Park' },
      'killarney community centre': { lat: 49.2214, lng: -123.0398, address: '6260 Killarney St, Vancouver, BC', displayArea: 'Killarney' },
      'britannia community centre': { lat: 49.2757, lng: -123.0714, address: '1661 Napier St, Vancouver, BC', displayArea: 'Grandview-Woodland' },
    },
  },
];

export function getCityCalendar(calendarKey: string): CityCalendarConfig | undefined {
  return CITY_CALENDARS.find((c) => c.calendarKey === calendarKey);
}
