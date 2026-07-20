// worker/adapters/seasonal/config.ts — G-T12-1: seasonal status-watcher config
// (TSD §5.1 Adapter E, §7.1 seasonality; source family `seasonal`).
//
// Adapter E does NOT ingest booking/schedule data. It is a lightweight watcher
// that reads an attraction's OFFICIAL public status/info page for season /
// suspension / weather signals and maps them to `season_state` (map.ts). It is
// fixture-first: fetch() only performs a live network read when BOTH the DB
// terms/robots gate (worker/core/terms-gate.ts) AND the env allow-list
// `KIDS_FUN_LIVE_SEASONAL=<key>` permit it. Everything else runs from the
// captured fixture text below — the profile that keeps CI/tests offline.
//
// COMPLIANCE (checked 2026-07-20, mirrors T35's terms/robots discipline):
// each source records its robots.txt result and a live posture. We prefer
// official municipal / park-authority / attraction-operator status pages (the
// kind published to be read by the public) and never touch a booking/checkout/
// login/API path. Sources whose site actively blocks automated reads (WAF 403)
// or that expose no clean public status endpoint are kept FIXTURE-ONLY.

/** Canonical season-watcher source keys (the env allow-list token per source). */
export type SeasonalSourceKey =
  | 'stanley-park-train'
  | 'burnaby-central-railway'
  | 'cypress-mountain'
  | 'grouse-mountain';

/** How the watcher is allowed to obtain the status text for a source. */
export type LivePosture =
  /** Never live-fetched by design; provenance URL recorded for attribution only. */
  | 'fixture-only'
  /** May live-fetch when the DB terms/robots gate AND env allow-list both permit. */
  | 'live-capable-gated';

export interface SeasonalComplianceRecord {
  /** ISO date the robots.txt / page profile was last verified. */
  checkedIso: string;
  /** Short human summary of the robots.txt result. */
  robotsSummary: string;
  /** Terms / page-type note (public status page vs booking/login system). */
  termsNote: string;
  livePosture: LivePosture;
}

export interface SeasonalSourceConfig {
  key: SeasonalSourceKey;
  /** source.family in the DB registry (supabase seeds / no-code source console). */
  sourceFamily: 'seasonal';
  /** source.name in the DB registry (unique together with family). */
  sourceName: string;
  /** Attraction operator / authority (for provenance + attribution). */
  operator: string;
  /** The official PUBLIC status/info page — always recorded for provenance. */
  statusPageUrl: string;
  /**
   * Live-fetchable status URL. Present ONLY for `live-capable-gated` sources whose
   * robots.txt + public status page were verified. `undefined` => fixture-only:
   * fetch() never performs a network request for this source.
   */
  liveStatusUrl?: string;
  /** Recorded compliance decision (see file header). */
  compliance: SeasonalComplianceRecord;
  /**
   * Captured official status text used when not live (the default in CI/tests and
   * for every fixture-only source). Shape only — a representative status snapshot.
   */
  fixtureStatusText: string;
}

/** Single env var (comma-separated keys) that opts a source into live fetching. */
export const SEASONAL_LIVE_ENV_KEY = 'KIDS_FUN_LIVE_SEASONAL' as const;

export const SEASONAL_SOURCES: SeasonalSourceConfig[] = [
  {
    key: 'stanley-park-train',
    sourceFamily: 'seasonal',
    sourceName: 'Stanley Park Miniature Train (Vancouver Park Board)',
    operator: 'Vancouver Board of Parks and Recreation',
    statusPageUrl:
      'https://vancouver.ca/parks-recreation-culture/stanley-park-miniature-train.aspx',
    // FIXTURE-ONLY: vancouver.ca returns HTTP 403 to automated fetchers (edge WAF),
    // so we never live-fetch it; the URL is recorded for provenance/attribution only.
    liveStatusUrl: undefined,
    compliance: {
      checkedIso: '2026-07-20',
      robotsSummary:
        'vancouver.ca robots.txt not retrievable by automated fetch (edge WAF returns HTTP 403).',
      termsNote:
        'Official Park Board attraction page. WAF actively blocks automated reads — kept fixture-only, live disabled.',
      livePosture: 'fixture-only',
    },
    // Real status snapshot (2026-07): the train is out of service pending a new
    // operating model — a genuine "never bookable this season" signal.
    fixtureStatusText:
      'Stanley Park Miniature Train. The train remains offline for the remainder of the ' +
      'year due to safety concerns with its aging systems. Park Board staff are exploring ' +
      'new operating models and partnerships. The attraction is temporarily closed and not ' +
      'currently running; no rides are available.',
  },
  {
    key: 'burnaby-central-railway',
    sourceFamily: 'seasonal',
    sourceName: 'Burnaby Central Railway (BCSME, Confederation Park)',
    operator: 'British Columbia Society of Model Engineers',
    statusPageUrl: 'https://bcsme.org/tickets',
    // FIXTURE-ONLY: bcsme.org public pages are robots-allowed (Drupal defaults,
    // Crawl-delay 10) but the volunteer-run site exposes no clean structured status
    // endpoint; season is a fixed published window. Recorded for provenance only.
    liveStatusUrl: undefined,
    compliance: {
      checkedIso: '2026-07-20',
      robotsSummary:
        'bcsme.org robots.txt: User-agent:* Crawl-delay:10; Drupal defaults block admin/user/system paths, public info pages allowed.',
      termsNote:
        'Official operator (BCSME) hours page. No structured status endpoint; fixed published season — kept fixture-only.',
      livePosture: 'fixture-only',
    },
    // Real seasonal pattern: weekend operation Easter -> Canadian Thanksgiving;
    // 2026 season opens Good Friday, April 3 — a pre-season snapshot before opening.
    fixtureStatusText:
      'Burnaby Central Railway at Confederation Park. The 2026 season opens Good Friday, ' +
      'April 3 at 11:00 AM. Trains run weekends, 11am to 5pm, from Easter to Canadian ' +
      'Thanksgiving. Season opening soon — see you in the spring!',
  },
  {
    key: 'cypress-mountain',
    sourceFamily: 'seasonal',
    sourceName: 'Cypress Mountain (operating status)',
    operator: 'Cypress Mountain Resort',
    statusPageUrl: 'https://www.cypressmountain.com/mountain-report',
    // LIVE-CAPABLE, GATED OFF: robots.txt is `User-Agent: * / (no Disallow)` and
    // /mountain-report is a public operating-status page (Downhill Daily Report,
    // Lift Status, Trail Status) — not a booking/checkout/login/API path. Live
    // fetching still requires the DB terms/robots gate AND KIDS_FUN_LIVE_SEASONAL.
    liveStatusUrl: 'https://www.cypressmountain.com/mountain-report',
    compliance: {
      checkedIso: '2026-07-20',
      robotsSummary:
        'cypressmountain.com robots.txt: `User-Agent: *` with no Disallow (Sitemap only) — all paths crawlable.',
      termsNote:
        'Public operating-status page (Downhill Daily Report / Lift / Trail status). Not a booking/login system.',
      livePosture: 'live-capable-gated',
    },
    // Winter operating snapshot (in-season / open).
    fixtureStatusText:
      'Cypress Mountain Downhill Daily Report: OPEN. Lifts and trails are now open. ' +
      'Winter operations are underway; the mountain is currently open for skiing and ' +
      'snowboarding. Conditions are weather dependent — check the daily report.',
  },
  {
    key: 'grouse-mountain',
    sourceFamily: 'seasonal',
    sourceName: 'Grouse Mountain (mountain conditions)',
    operator: 'Grouse Mountain Resorts',
    statusPageUrl: 'https://www.grousemountain.com/',
    // FIXTURE-ONLY (pending): robots allows a public conditions page but explicitly
    // Disallows /api*, /content*, /checkout*, /cart*, /account*, /orders*, /ecom*,
    // /login. The exact public conditions URL could not be confirmed (candidate
    // /mountain-report returned 404), so no live URL is wired — a live path needs
    // the confirmed conditions URL + a robots re-check first.
    liveStatusUrl: undefined,
    compliance: {
      checkedIso: '2026-07-20',
      robotsSummary:
        'grousemountain.com robots.txt: User-agent:* Disallow /api*,/content*,/checkout*,/cart*,/account*,/orders*,/ecom*,/user_*,/login,/logout; public conditions page not disallowed.',
      termsNote:
        'Conditions page is public, but booking/API paths are robots-disallowed and the exact conditions URL is unconfirmed — kept fixture-only.',
      livePosture: 'fixture-only',
    },
    // Winter conditions snapshot (open).
    fixtureStatusText:
      'Grouse Mountain conditions: the mountain is open daily for skiing and snowboarding. ' +
      'Now open — winter operations in effect. Conditions are weather dependent.',
  },
];

export function getSeasonalSource(key: string): SeasonalSourceConfig | undefined {
  return SEASONAL_SOURCES.find((s) => s.key === key);
}

/**
 * True when a source is opted into live fetching via the env allow-list
 * (`KIDS_FUN_LIVE_SEASONAL=<key>[,<key>...]`). Fixture-only sources (no
 * liveStatusUrl) can never live-fetch regardless of the env value.
 */
export function seasonalLiveEnabledFor(key: string): boolean {
  const raw = process.env[SEASONAL_LIVE_ENV_KEY] ?? '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(key.toLowerCase());
}
