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
  /** Public BiblioCommons gateway endpoint; only used when explicitly live-enabled. */
  gatewayEventsUrl?: string;
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
  },
  {
    systemKey: 'rpl',
    systemName: 'Richmond Public Library',
    platform: 'bibliocommons',
    sourceFamily: 'library_bibliocommons',
    sourceName: 'Richmond Public Library BiblioEvents',
    feedBaseUrl: 'https://yourlibrary.bibliocommons.com/events',
    gatewayEventsUrl: 'https://gateway.bibliocommons.com/v2/libraries/yourlibrary/events',
    liveEventsLimit: 20,
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
