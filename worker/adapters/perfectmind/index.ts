// worker/adapters/perfectmind/index.ts — T8: live PerfectMind / Xplor BookMe4 drop-in
// adapter (TSD §5.1 Adapter F, family `perfectmind`).
//
// Live path = the tenant widget's own BookMe4 JSON endpoints (GetCategoriesDataV2 →
// ClassesV2, cursor-paginated by `after`). Plain HTTP, identified UA, credential-free,
// no anti-forgery token, no headless render — see config.ts for the D-10/D-11 authority
// note and client.ts for the measured contract.
//
// DEFAULT MODE IS FIXTURE-ONLY, and staying live-off takes no action. Three independent
// gates must ALL be open for a single network request to happen:
//   1. config  — `tenant.enabled` and a non-empty `dropInCategoryNames`
//   2. env     — `KIDS_FUN_LIVE_PERFECTMIND=<tenantKey,...>` (the same comma-separated
//                allow-list pattern as KIDS_FUN_LIVE_ACTIVENET; absent ⇒ fixtures, zero
//                network)
//   3. DB      — the terms/robots gate in worker/core/terms-gate.ts, applied by the
//                source runner before fetch() is ever called
// tests/compliance/no-bypass.test.ts asserts gate 2 behaviourally: a PerfectMind adapter
// with the env var unset makes ZERO network calls.
import type { Adapter, AdapterRunDiagnostics, StructuredRecord, DedupKey } from '../../core/adapter';
import { zonedDateString } from '../../core/time';
import {
  PERFECTMIND_TENANTS,
  BOOKME4_ASSET_BUILD_STAMP,
  getPerfectMindTenant,
  ingestableTenants,
  clientsBaseUrl,
  widgetStartPageUrl,
  calendarPageUrl,
  policyKeyFor,
  type PerfectMindTenantConfig,
} from './config';
import {
  RequestBudget,
  fetchTenant,
  stridesForWindow,
  type CalendarFetchResult,
} from './client';
import { parseTenantCalendars, type ParseResult } from './parse';
import { assessRunHealth, type PerfectMindHealthVerdict } from './health';

/** How far ahead a run ingests. The cursor walk would happily follow the vendor months
 *  into the future; drop-in schedules change weekly, so a 28-day horizon keeps the
 *  occurrence table from filling with provisional far-future slots. Matches ActiveNet's
 *  DEFAULT_WINDOW_DAYS deliberately — one horizon for the project, not two. */
export const DEFAULT_WINDOW_DAYS = 28;

const ENV_ALLOW_LIST = 'KIDS_FUN_LIVE_PERFECTMIND';

function envAllowsTenant(tenantKey: string): boolean {
  const raw = process.env[ENV_ALLOW_LIST] ?? '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(tenantKey.toLowerCase());
}

export interface FetchWindow {
  startDate: string;
  endDate: string;
}

/**
 * Inclusive local-date window spanning EXACTLY `DEFAULT_WINDOW_DAYS` days in the tenant's
 * zone: `[today, today + (DEFAULT_WINDOW_DAYS - 1)]`.
 *
 * THE `- 1` IS THE FIX FOR QA C1, and it is the constant finally meaning what it says.
 * The previous form (`today + DEFAULT_WINDOW_DAYS`) declared an INCLUSIVE 29-day window
 * while `stridesForWindow(28)` fetched 2 strides = 28 days — so the final declared day
 * was never fetched at all. QA measured 41 real occurrences lost on that one day. It
 * rolls forward daily rather than accumulating, which is exactly why it was invisible.
 *
 * Fixed by shrinking the window to match the name rather than by buying a third stride:
 * covering the 29th day would have cost a whole extra stride (~50% more requests) to gain
 * one day at the far edge of a horizon that exists to be approximate.
 *
 * NOTE for whoever touches worker/adapters/activenet/index.ts: it has the SAME
 * off-by-one (its `defaultWindow` also declares 29 inclusive days for a 28-day constant).
 * Harmless there — ActiveNet fetches its whole calendar period in one request and windows
 * client-side, so the extra day is simply kept rather than lost — but it is the same
 * imprecision and worth knowing about. Deliberately NOT changed here: different adapter,
 * different stream, no bug to fix.
 */
export function defaultWindow(tenant: PerfectMindTenantConfig, now: Date = new Date()): FetchWindow {
  const startDate = zonedDateString(now, tenant.timezone);
  const end = new Date(now.getTime() + (DEFAULT_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000);
  return { startDate, endDate: zonedDateString(end, tenant.timezone) };
}

/**
 * Inclusive day count a window actually spans, computed from the window's OWN dates.
 *
 * Exists so crawl depth derives from the window that will really be applied, not from the
 * constant the window was built from (QA C2). Those are the same thing today and were the
 * same thing when B1 was fixed — but "the same thing today" is precisely the assumption
 * that produced B1, and re-deriving from the real value costs nothing.
 */
export function windowDays(window: FetchWindow): number {
  const start = Date.parse(`${window.startDate}T00:00:00Z`);
  const end = Date.parse(`${window.endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return DEFAULT_WINDOW_DAYS;
  return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * Calendars that PRODUCED DATA and then stopped short of the declared window.
 *
 * Extracted and exported rather than inlined, for a reason worth stating: at the current
 * 28-day window this condition is UNREACHABLE through `fetch()` (2 strides — a walk cannot
 * both exit early and leave strides unwalked, and the one path that yields
 * `stridesWalked: 0`, a per-calendar fetch failure, is excluded by the `occurrenceCount`
 * half). So no adapter-level test can tell "guard present" from "guard deleted", and a
 * mutation removing it passed silently until this was pulled out where it can be exercised
 * directly. Unreachable-today logic still has to be provably correct for the day the
 * window widens — otherwise it is decoration that will be trusted later.
 *
 * Evaluated PER CALENDAR, never against a min across all of them: a scalar min lets one
 * failed calendar speak for the whole tenant and cannot name the culprit in the alert.
 * See health.ts for why `occurrenceCount > 0` is load-bearing (it is what keeps fetch
 * failures and legitimately-empty calendars out of a COVERAGE alert).
 */
export function shortfallCalendarsFor(
  calendars: Pick<CalendarFetchResult, 'calendarName' | 'calendarId' | 'occurrenceCount' | 'stridesWalked'>[],
  stridesRequired: number
): string[] {
  return calendars
    .filter((c) => c.occurrenceCount > 0 && c.stridesWalked < stridesRequired)
    .map((c) => c.calendarName ?? c.calendarId);
}

/** What one fetch() produced — the single element fetch() returns, consumed by extract(). */
export interface PerfectMindRawPayload {
  tenantKey: string;
  live: boolean;
  window: FetchWindow;
  calendars: CalendarFetchResult[];
  requestsUsed: number;
  warnings: string[];
  unrecognisedKeys: string[];
}

/** Everything a run wants to report: parse stats, coverage, health verdict. */
export interface PerfectMindRunReport {
  tenantKey: string;
  live: boolean;
  window: FetchWindow;
  requestsUsed: number;
  calendarsFetched: number;
  calendarsTruncated: number;
  /** Strides the window required vs the fewest any calendar walked. DIAGNOSTIC only —
   *  the alarm is `shortfallCalendars`, because a bare comparison of these two mislabels
   *  failed and legitimately-empty calendars (see health.ts). */
  stridesRequired: number;
  minStridesWalked: number;
  /** Calendars that produced data and THEN stopped short — raises `coverage_shortfall`. */
  shortfallCalendars: string[];
  /** Calendars cut short with data still arriving — raises `coverage_truncated`. Kept
   *  distinct from a shortfall: this one is unambiguously bad. */
  truncatedCalendars: string[];
  parse: ParseResult['stats'];
  warnings: string[];
  unrecognisedKeys: string[];
  health: PerfectMindHealthVerdict;
}

/** Shape-faithful synthetic payload for the fixture path. Deliberately synthetic (not a
 *  disk read) so the dry-run has no I/O at all; the REAL captured payloads live in
 *  __fixtures__/ and drive the contract tests. */
function fixtureCalendars(tenant: PerfectMindTenantConfig): CalendarFetchResult[] {
  const today = zonedDateString(new Date(), tenant.timezone).replace(/-/g, '');
  return [
    {
      calendarId: '00000000-0000-0000-0000-000000000001',
      calendarName: 'Open Gym Schedules',
      categoryName: '**Drop-In Schedules',
      occurrenceCount: 1,
      pagesFetched: 0,
      stridesWalked: stridesForWindow(DEFAULT_WINDOW_DAYS), // synthetic: a dry run walks nothing
      truncated: false,
      warnings: [],
      classes: [
        {
          EventId: 'fixture-open-gym',
          CourseId: '00000001',
          EventName: `$3 Open Gym 8yrs+ ${tenant.municipality} Fixture 10:00-11:30am`,
          Details: 'Drop-in family gym time. Regular admission fees apply.',
          OccurrenceDate: today,
          EventTimeDescription: '10:00 am - 11:30 am',
          PriceRange: 'No fee',
          AllDayEvent: false,
          MinAge: 8,
          MinAgeMonths: null,
          MaxAge: null,
          MaxAgeMonths: null,
          NoAgeRestriction: false,
          AgeRestrictions: '8+',
          DisplayableRestrictionsForCourses: 'Age: 8+',
          Facility: 'Gymnasium',
          Location: `${tenant.municipality} Community Recreation Centre`,
          Address: {
            AddressTag: `${tenant.municipality} Community Recreation Centre`,
            Street: '1 Example Street',
            City: tenant.municipality,
            PostalCode: 'V0V 0V0',
            Latitude: 49.3,
            Longitude: -123.0,
          },
          OrgName: tenant.sourceName,
          Spots: '',
          BookButtonText: 'More Info',
        },
      ],
    },
  ];
}

export class PerfectMindAdapter implements Adapter {
  readonly family = 'perfectmind';

  /** Populated by the last extract(); the runner/health board reads it. */
  private report: PerfectMindRunReport | null = null;

  constructor(private readonly tenant: PerfectMindTenantConfig) {}

  isLiveFetchEnabled(): boolean {
    return (
      this.tenant.enabled &&
      this.tenant.dropInCategoryNames.length > 0 &&
      envAllowsTenant(this.tenant.tenantKey)
    );
  }

  async fetch(): Promise<unknown[]> {
    const window = defaultWindow(this.tenant);
    if (!this.isLiveFetchEnabled()) {
      return [
        {
          tenantKey: this.tenant.tenantKey,
          live: false,
          window,
          calendars: fixtureCalendars(this.tenant),
          requestsUsed: 0,
          warnings: [],
          unrecognisedKeys: [],
        } satisfies PerfectMindRawPayload,
      ];
    }

    const budget = new RequestBudget(this.tenant.tenantKey, this.tenant.maxRequestsPerRun);
    // Crawl depth is DERIVED from the window THIS RUN will actually apply — not from the
    // constant, and never hard-coded. Depth and window drifting apart is exactly how this
    // adapter once ingested 14 days while claiming 28 (B1), and then how it declared 29
    // days while fetching 28 (C1). Deriving from the real value is what makes a third
    // instance of that class structurally impossible rather than merely fixed twice.
    // Pinned behaviourally by the adapter-level full-window test — hard-coding a stride
    // count here fails it.
    const result = await fetchTenant(this.tenant, { budget }, stridesForWindow(windowDays(window)));
    return [
      {
        tenantKey: result.tenantKey,
        live: true,
        window,
        calendars: result.calendars,
        requestsUsed: result.requestsUsed,
        warnings: result.warnings,
        unrecognisedKeys: result.unrecognisedKeys,
      } satisfies PerfectMindRawPayload,
    ];
  }

  extract(raw: unknown[]): StructuredRecord[] {
    const payload = raw[0] as PerfectMindRawPayload | undefined;
    if (!payload) {
      this.report = null;
      return [];
    }

    const parsed = parseTenantCalendars(this.tenant, payload.calendars, { window: payload.window });
    const warnings = [...payload.warnings, ...parsed.warnings];
    const truncatedCalendars = payload.calendars
      .filter((c) => c.truncated)
      .map((c) => c.calendarName ?? c.calendarId);
    const stridesRequired = stridesForWindow(windowDays(payload.window));
    const minStridesWalked = payload.calendars.length
      ? Math.min(...payload.calendars.map((c) => c.stridesWalked))
      : stridesRequired;
    const shortfallCalendars = shortfallCalendarsFor(payload.calendars, stridesRequired);

    this.report = {
      tenantKey: payload.tenantKey,
      live: payload.live,
      window: payload.window,
      requestsUsed: payload.requestsUsed,
      calendarsFetched: payload.calendars.length,
      calendarsTruncated: truncatedCalendars.length,
      truncatedCalendars,
      shortfallCalendars,
      stridesRequired,
      minStridesWalked,
      parse: parsed.stats,
      warnings,
      unrecognisedKeys: payload.unrecognisedKeys,
      health: assessRunHealth({
        tenantKey: payload.tenantKey,
        occurrencesParsed: parsed.records.length,
        requestsUsed: payload.requestsUsed,
        // Baseline is a DB read; the runner supplies it when it has one. A fetch() that
        // never reached the DB simply reports no baseline (a first run is not a collapse).
        baselineOccurrences: null,
        unrecognisedKeys: payload.unrecognisedKeys,
        truncatedCalendars,
        shortfallCalendars,
        warnings,
      }),
    };
    return parsed.records;
  }

  /**
   * Self-assess the run just extracted (Adapter.assessRun). ingestSource calls this with
   * the source's trailing record-count baseline and turns an alerting verdict into a run
   * error, so a yield collapse or a payload-shape change lands on the T15 health board
   * instead of passing as a quiet green over an empty municipality.
   */
  assessRun(baselineRecordsFound: number | null): AdapterRunDiagnostics | null {
    if (!this.report) return null;
    // A fixture dry-run must never alert: it is a synthetic single record, and comparing
    // it to a live baseline would fire a collapse on every non-live run.
    if (!this.report.live) {
      return { code: 'fixture_dry_run', alert: false, detail: 'fixture dry-run — no live data assessed' };
    }

    const verdict = assessRunHealth({
      tenantKey: this.report.tenantKey,
      occurrencesParsed: this.report.health.occurrences,
      requestsUsed: this.report.requestsUsed,
      baselineOccurrences: baselineRecordsFound,
      unrecognisedKeys: this.report.unrecognisedKeys,
      truncatedCalendars: this.report.truncatedCalendars,
      shortfallCalendars: this.report.shortfallCalendars,
      warnings: this.report.warnings,
    });
    this.report = { ...this.report, health: verdict };
    return { code: verdict.code, alert: verdict.alert, detail: verdict.detail };
  }

  /** The last run's honest accounting — parse stats, coverage gaps, health verdict. */
  lastRunReport(): PerfectMindRunReport | null {
    return this.report;
  }

  dedupKeys(record: StructuredRecord): DedupKey {
    return { key: `perfectmind::${this.tenant.tenantKey}::${record.sourceRecordId}` };
  }
}

export function loadPerfectMindAdapters(): PerfectMindAdapter[] {
  return PERFECTMIND_TENANTS.map((tenant) => new PerfectMindAdapter(tenant));
}

export {
  PERFECTMIND_TENANTS,
  BOOKME4_ASSET_BUILD_STAMP,
  getPerfectMindTenant,
  ingestableTenants,
  clientsBaseUrl,
  widgetStartPageUrl,
  calendarPageUrl,
  policyKeyFor,
};
export type { PerfectMindTenantConfig };
