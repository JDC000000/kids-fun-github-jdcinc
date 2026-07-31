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
import { RequestBudget, fetchTenant, type CalendarFetchResult } from './client';
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

/** Inclusive local-date window [today, today + DEFAULT_WINDOW_DAYS] in the tenant's zone. */
export function defaultWindow(tenant: PerfectMindTenantConfig, now: Date = new Date()): FetchWindow {
  const startDate = zonedDateString(now, tenant.timezone);
  const end = new Date(now.getTime() + DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { startDate, endDate: zonedDateString(end, tenant.timezone) };
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
    const result = await fetchTenant(this.tenant, { budget });
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

    this.report = {
      tenantKey: payload.tenantKey,
      live: payload.live,
      window: payload.window,
      requestsUsed: payload.requestsUsed,
      calendarsFetched: payload.calendars.length,
      calendarsTruncated: payload.calendars.filter((c) => c.truncated).length,
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
