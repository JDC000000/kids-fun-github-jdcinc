// worker/adapters/seasonal/index.ts — G-T12-1: seasonal status-page watcher
// (TSD §5.1 Adapter E, §7.1). A lightweight watcher that reads an attraction's
// OFFICIAL public status page and classifies it into a single season/suspension
// signal. It does NOT ingest bookings or schedules — only the open/closed/
// seasonal/weather STATE. map.ts turns that signal into a `season_state`
// transition; manual.ts covers operator-supplied seasonal records.
//
// Fixture-first & live-gated (same posture as every other adapter): fetch()
// returns the captured fixture text unless the source is `live-capable-gated`,
// has a liveStatusUrl, AND is opted in via KIDS_FUN_LIVE_SEASONAL. The DB
// terms/robots gate is enforced separately by runSeasonalWatch (see below).
import type { Pool } from 'pg';
import {
  evaluateLiveFetchGate,
  evaluateTermsGate,
  SOURCE_GATE_COLUMNS,
  type Environment,
} from '../../core/terms-gate';
import { politeFetch } from '../../health/policy';
import {
  SEASONAL_SOURCES,
  getSeasonalSource,
  seasonalLiveEnabledFor,
  type SeasonalSourceConfig,
} from './config';
import { resolveSeasonState, applySeasonState, type SeasonTransition, type SeasonOverride } from './map';

const FETCH_TIMEOUT_MS = 10_000;

/** The classified state of a status page — the watcher's only output. */
export type SeasonalSignal =
  | 'open' // currently open / operating — in season
  | 'opening_soon' // pre-season: season announced but not yet started
  | 'closed_seasonal' // out of season / closed for the season
  | 'suspended' // out of service / temporarily closed (incl. weather holds)
  | 'unknown'; // no recognisable signal

export interface SeasonalStatusSignal {
  sourceKey: string;
  sourceName: string;
  signal: SeasonalSignal;
  /** The status-page phrase that produced the classification (audit/debug). */
  matchedText: string;
  /** True when a weather/condition hold (not a calendar season) drove `suspended`. */
  weatherRelated: boolean;
  /** Whether the text came from a live fetch or the captured fixture. */
  live: boolean;
  observedAtIso: string;
}

// Prioritised classification rules. Order matters: the strongest / most specific
// signal wins. Suspension (out of service) and explicit season-closure beat the
// generic "open" cues, and "opening soon / opens <date>" beats a bare "open".
interface Rule {
  signal: SeasonalSignal;
  re: RegExp;
  weather?: boolean;
}

// Weather-noun alternation accepts both singular and plural forms (wind/winds,
// storm/storms, rain/rains, snow/snows) so "closed due to high winds" is caught
// as a weather hold, not left to fall through to the imprecise 'unknown' state.
// The `closed/suspended` prefix + `due to/because of/owing to` connector are still
// both required, so widening the noun set cannot upgrade genuinely ambiguous input.
const WEATHER_HOLD_RE =
  /\b(?:closed|suspended|on hold|not (?:running|operating))\b[^.<\n]{0,60}\b(?:due to|because of|owing to)\b[^.<\n]{0,40}\b(?:weather|snows?|rains?|winds?|storms?|ice|conditions|lightning|fog|heat)\b/i;

const RULES: Rule[] = [
  // Weather / condition holds — a temporary suspension, flagged separately.
  { signal: 'suspended', re: WEATHER_HOLD_RE, weather: true },
  // Out of service / suspended (not a seasonal calendar close).
  {
    signal: 'suspended',
    re: /\b(?:out of service|temporarily closed|closed until further notice|suspended|offline|not (?:currently )?(?:running|operating|in service)|remains? (?:closed|offline)|service (?:is )?suspended)\b/i,
  },
  // Season is over / closed for the season.
  {
    signal: 'closed_seasonal',
    re: /\b(?:closed for the (?:season|winter|summer)|(?:the )?season (?:has )?ended|end of (?:the )?season|closed until (?:next (?:season|spring|year)|the spring|spring)|out of season|post[-\s]?season)\b/i,
  },
  // Pre-season: announced but not yet started.
  {
    signal: 'opening_soon',
    re: /\b(?:opening soon|opens?\s+(?:on\s+)?(?:good friday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)|season (?:opens|starts|begins|returns)|re[-\s]?open(?:s|ing)?|coming soon|pre[-\s]?season|see you (?:in|next) (?:the )?(?:spring|season))\b/i,
  },
  // Currently open / operating — in season.
  {
    signal: 'open',
    re: /\b(?:now open|currently open|open (?:daily|today|now|for the season|for (?:skiing|the winter))|now (?:running|operating|open for)|in operation|operating (?:daily|now)|report:\s*open)\b/i,
  },
];

/** Classify a status-page text blob into a single seasonal signal. */
export function classifyStatusText(text: string): { signal: SeasonalSignal; matchedText: string; weather: boolean } {
  const hay = (text ?? '').replace(/\s+/g, ' ').trim();
  for (const rule of RULES) {
    const m = rule.re.exec(hay);
    if (m) return { signal: rule.signal, matchedText: m[0].trim(), weather: rule.weather === true };
  }
  return { signal: 'unknown', matchedText: '', weather: false };
}

/**
 * The watcher for one seasonal source. Mirrors the fixture-first / live-gated shape
 * of the occurrence adapters but its output is a status SIGNAL, not occurrences.
 */
export class SeasonalWatcher {
  readonly family = 'seasonal';

  constructor(private readonly config: SeasonalSourceConfig) {}

  /** True only when this source may perform a live network read right now. */
  isLiveFetchEnabled(): boolean {
    return (
      this.config.compliance.livePosture === 'live-capable-gated' &&
      Boolean(this.config.liveStatusUrl) &&
      seasonalLiveEnabledFor(this.config.key)
    );
  }

  /** Fetch the raw status-page text — live when gated-on, otherwise the fixture. */
  async fetch(): Promise<{ text: string; live: boolean }> {
    if (this.isLiveFetchEnabled() && this.config.liveStatusUrl) {
      const text = await fetchStatusPage(this.config.liveStatusUrl, `seasonal::${this.config.key}`);
      return { text, live: true };
    }
    return { text: this.config.fixtureStatusText, live: false };
  }

  /** Classify already-fetched text (pure — the unit-testable core). */
  extract(text: string, live = false): SeasonalStatusSignal {
    const { signal, matchedText, weather } = classifyStatusText(text);
    return {
      sourceKey: this.config.key,
      sourceName: this.config.sourceName,
      signal,
      matchedText,
      weatherRelated: weather,
      live,
      observedAtIso: new Date().toISOString(),
    };
  }

  /** fetch() + extract() — the full watch for one source. */
  async watch(): Promise<SeasonalStatusSignal> {
    const { text, live } = await this.fetch();
    return this.extract(text, live);
  }
}

async function fetchStatusPage(url: string, policyKey: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Polite fetch seam (G-T15-5): identified UA + conditional headers + rate limit + backoff.
    const res = await politeFetch(
      policyKey,
      new URL(url),
      { headers: { accept: 'text/html,application/xhtml+xml' }, signal: controller.signal },
      { family: 'seasonal' }
    );
    if (!res.ok) {
      throw new Error(`seasonal status fetch failed: ${res.status} ${res.statusText}`);
    }
    const body = await res.text();
    // Strip tags to plain text so the classifier scans visible copy, not markup.
    return body
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } finally {
    clearTimeout(timer);
  }
}

/** All configured seasonal watchers. */
export function loadSeasonalWatchers(): SeasonalWatcher[] {
  return SEASONAL_SOURCES.map((c) => new SeasonalWatcher(c));
}

export interface SeasonalWatchResult {
  ok: boolean;
  signal?: SeasonalStatusSignal;
  gate: { allowed: boolean; reason: string };
  transition?: SeasonTransition;
  error?: string;
}

/**
 * End-to-end watch for one seasonal source, DB-backed and terms-gated:
 *   1. load the source row (terms/robots) by (family,name),
 *   2. enforce the same terms gate every adapter runs (worker/core/terms-gate),
 *      and the stronger live-fetch gate when the watcher would go to network,
 *   3. classify the status text into a signal,
 *   4. map signal (with optional manual override) -> season_state and APPLY the
 *      transition to `source.season_state` (visible in the admin sources console).
 *
 * Matches worker/core/source-runner.ts so a season watch is gated exactly like an
 * ingest. Returns the transition (from -> to) so callers can log/alert on changes.
 */
export async function runSeasonalWatch(
  pool: Pool,
  config: SeasonalSourceConfig,
  environment: Environment = 'staging',
  override?: SeasonOverride
): Promise<SeasonalWatchResult> {
  const { rows } = await pool.query<{
    id: string;
    terms_status: string;
    robots_status: string;
    robots_override_decision: string | null;
  }>(
    // Same shared column list as source-runner.ts: no seasonal source carries an F-5
    // override today, and this is here so that granting one later doesn't produce a
    // source that reads "authorised" and never watches (see terms-gate.ts).
    `SELECT id, ${SOURCE_GATE_COLUMNS}
       FROM source
      WHERE family = $1 AND name = $2
      LIMIT 1`,
    [config.sourceFamily, config.sourceName]
  );
  const row = rows[0];
  if (!row) {
    return { ok: false, gate: { allowed: false, reason: 'source not found' }, error: `source not found: ${config.sourceFamily} / ${config.sourceName}` };
  }

  const source = {
    id: row.id,
    termsStatus: row.terms_status,
    robotsStatus: row.robots_status,
    robotsOverrideDecision: row.robots_override_decision,
  };
  const baseGate = evaluateTermsGate(source, environment);
  if (!baseGate.allowed) {
    return { ok: false, gate: baseGate, error: baseGate.reason };
  }

  const watcher = new SeasonalWatcher(config);
  // The live-fetch gate only matters when the watcher would actually go to network.
  const liveGate = watcher.isLiveFetchEnabled() ? evaluateLiveFetchGate(source, environment) : baseGate;
  if (!liveGate.allowed) {
    return { ok: false, gate: liveGate, error: liveGate.reason };
  }

  const signal = await watcher.watch();
  const mapping = resolveSeasonState(signal, override);
  const transition = await applySeasonState(
    pool,
    { id: row.id },
    mapping.seasonState,
    { reason: mapping.reason, touchLastCheck: true }
  );

  return { ok: true, signal, gate: liveGate, transition };
}

export { SEASONAL_SOURCES, getSeasonalSource };
