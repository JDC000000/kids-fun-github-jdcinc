// worker/adapters/library/config.ts — G-T9-1/2: Library system config
// (TSD §5.1 Adapter B). One adapter family across library systems, selected by
// platform: BiblioCommons/BiblioEvents (VPL/Richmond-style) and Communico/Libnet
// (Coquitlam), with a generic per-system feed fallback. Storytime / early-
// learning events carry strong age/date/branch metadata.

export type LibraryPlatform = 'bibliocommons' | 'communico';

export interface LibrarySystemConfig {
  systemKey: string;
  systemName: string;
  platform: LibraryPlatform;
  /** source.family in supabase/seeds/sources.sql. */
  sourceFamily: 'library_bibliocommons' | 'library_communico';
  /** source.name in supabase/seeds/sources.sql. */
  sourceName: string;
  feedBaseUrl: string;
  /** Public BiblioCommons gateway endpoint (JSON); only used when explicitly live-enabled. */
  gatewayEventsUrl?: string;
  /**
   * Public BiblioCommons RSS/XML events feed. Preferred live path where present:
   * the BiblioCommons Terms of Use prohibit automated harvesting "except as may be
   * specifically permitted using RSS/XML feeds", so this is the ToS-compliant
   * mechanism for automated ingestion. When set, it takes priority over
   * gatewayEventsUrl in fetch(). (KIDS FUN Task 5 — VPL enablement, 2026-07-13.)
   */
  rssEventsUrl?: string;
  /** Hard cap per request for live approved-source dry-runs. */
  liveEventsLimit?: number;
  /** Deterministic branch/location metadata used for venue rows; no live geocoder. */
  branchLocations?: Record<string, LibraryBranchLocation>;
}

export interface LibraryBranchLocation {
  address: string;
  lat: number;
  lng: number;
  municipalityName: string;
  displayArea: string;
  locationUrl: string;
}

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
    rssEventsUrl: 'https://gateway.bibliocommons.com/v2/libraries/vpl/rss/events',
    liveEventsLimit: 25,
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
    rssEventsUrl: 'https://gateway.bibliocommons.com/v2/libraries/yourlibrary/rss/events',
    liveEventsLimit: 20,
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
  },
];

export function getLibrarySystem(systemKey: string): LibrarySystemConfig | undefined {
  return LIBRARY_SYSTEMS.find((s) => s.systemKey === systemKey);
}
