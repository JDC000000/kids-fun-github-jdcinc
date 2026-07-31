// worker/adapters/activenet/index.ts — T7 REBUILD: live ActiveCommunities drop-in adapter
// (TSD §5.1 Adapter A, family `activenet`).
//
// Live path = the tenant portal's internal JSON REST API (calendars → filters →
// multicenter/events → centerdetails). Plain HTTP, identified UA, credential-free — see
// config.ts for the D-10 authority note and client.ts for the measured contract.
//
// DEFAULT MODE IS FIXTURE-ONLY, and staying live-off takes no action. Three independent
// gates must ALL be open for a single network request to happen:
//   1. config  — `tenant.enabled` and a non-empty `dropInCalendarIds`
//   2. env     — `KIDS_FUN_LIVE_ACTIVENET=<tenantKey>` (the KIDS_FUN_LIVE_CITY_CALENDARS
//                precedent: comma-separated allow-list, absent ⇒ fixtures, zero network)
//   3. DB      — the terms/robots gate in worker/core/terms-gate.ts, applied by the
//                source runner before fetch() is ever called
// tests/compliance/no-bypass.test.ts asserts gate 2 behaviourally: an ActiveNet adapter
// with the env var unset makes ZERO network calls.
import type { Adapter, AdapterRunDiagnostics, StructuredRecord, DedupKey } from '../../core/adapter';
import { zonedDateString } from '../../core/time';
import {
  ACTIVENET_TENANTS,
  ACTIVENET_PORTAL_VERSION,
  getTenantConfig,
  ingestableTenants,
  calendarPageUrl,
  restBaseUrl,
  policyKeyFor,
  type ActiveNetTenantConfig,
} from './config';
import {
  RequestBudget,
  fetchTenant,
  type CalendarFetchResult,
  type EventWindow,
  type TenantFetchResult,
} from './client';
import { parseTenantCalendars, type ParseResult } from './parse';
import { buildVenueIndex, applyVenues } from './venues';
import { assessRunHealth, type ActiveNetHealthVerdict } from './health';

/** How far ahead a run ingests. The portal returns its whole calendar period (~8–15
 *  weeks) in one response regardless, so this is a client-side bound on what we STORE,
 *  not a request-count lever. Drop-in schedules change weekly, so a 28-day horizon is
 *  well inside the useful range and keeps the occurrence table from filling with
 *  provisional far-future slots. */
export const DEFAULT_WINDOW_DAYS = 28;

const ENV_ALLOW_LIST = 'KIDS_FUN_LIVE_ACTIVENET';

function envAllowsTenant(tenantKey: string): boolean {
  const raw = process.env[ENV_ALLOW_LIST] ?? '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(tenantKey.toLowerCase());
}

/** Inclusive local-date window [today, today + DEFAULT_WINDOW_DAYS] in the tenant's zone. */
export function defaultWindow(tenant: ActiveNetTenantConfig, now: Date = new Date()): EventWindow {
  const startDate = zonedDateString(now, tenant.timezone);
  const end = new Date(now.getTime() + DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { startDate, endDate: zonedDateString(end, tenant.timezone) };
}

/** What one fetch() produced — the single element fetch() returns, consumed by extract(). */
export interface ActiveNetRawPayload {
  tenantKey: string;
  live: boolean;
  window: EventWindow;
  calendars: CalendarFetchResult[];
  centreDetails: TenantFetchResult['centreDetails'];
  requestsUsed: number;
  warnings: string[];
  unrecognisedKeys: string[];
}

/** Everything a run wants to report: parse stats, venue coverage, health verdict. */
export interface ActiveNetRunReport {
  tenantKey: string;
  live: boolean;
  window: EventWindow;
  requestsUsed: number;
  parse: ParseResult['stats'];
  unmappedCentreIds: number[];
  recordsWithoutAddress: number;
  /** Facilities in the feed that worker/adapters/activenet/venue-geo.ts cannot locate,
   *  BY NAME. Sits beside unmappedCentreIds because it is the same class of fact: a
   *  coverage gap that must be readable, not a percentage that reads as solved. */
  venuesWithoutGeo: string[];
  recordsWithoutGeo: number;
  warnings: string[];
  unrecognisedKeys: string[];
  health: ActiveNetHealthVerdict;
}

/** Centre id used by the dry-run fixture, so its venue join resolves like a live run. */
const FIXTURE_CENTRE_ID = 44;

/** Shape-faithful synthetic payload for the fixture path. Deliberately synthetic (not a
 *  disk read) so the dry-run has no I/O at all; the REAL captured payloads live in
 *  __fixtures__/ and drive the contract tests. */
function fixtureCalendars(tenant: ActiveNetTenantConfig): CalendarFetchResult[] {
  const start = `${zonedDateString(new Date(), tenant.timezone)} 10:00:00`;
  const end = `${zonedDateString(new Date(), tenant.timezone)} 11:30:00`;
  return [
    {
      calendarId: 5,
      calendarName: '*Open Gym Times',
      centreIds: [FIXTURE_CENTRE_ID],
      centreNames: { [FIXTURE_CENTRE_ID]: `*${tenant.municipality} Community Centre` },
      occurrenceCount: 1,
      warnings: [],
      centreEvents: [
        {
          center_id: FIXTURE_CENTRE_ID,
          center_name: `*${tenant.municipality} Community Centre`,
          total: 1,
          events: [
            {
              title: 'Family Open Gym',
              start_time: start,
              end_time: end,
              description: 'Drop-in family gym time.',
              event_item_id: 1,
              activity_detail_url: calendarPageUrl(tenant),
              activity_location_desc: `${tenant.municipality} Community Centre Gymnasium`,
              facilities: [
                {
                  facility_id: 1,
                  facility_name: 'Gymnasium',
                  center_id: FIXTURE_CENTRE_ID,
                  center_name: `*${tenant.municipality} Community Centre`,
                },
              ],
              price: { free: true, estimate_price: 'Free' },
            },
          ],
        },
      ],
    },
  ];
}

export class ActiveNetAdapter implements Adapter {
  readonly family = 'activenet';

  /** Populated by the last extract(); the runner/health board reads it. */
  private report: ActiveNetRunReport | null = null;

  constructor(private readonly tenant: ActiveNetTenantConfig) {}

  isLiveFetchEnabled(): boolean {
    return (
      this.tenant.enabled &&
      this.tenant.dropInCalendarIds.length > 0 &&
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
          // A matching centre detail so the dry run exercises the venue join end to
          // end (and does not emit a spurious "centre unresolved" warning).
          centreDetails: [
            {
              id: FIXTURE_CENTRE_ID,
              name: `*${this.tenant.municipality} Community Centre`,
              address1: '1 Example Street',
              city: this.tenant.municipality,
              state: 'BC',
              zip_code: 'V0V 0V0',
            },
          ],
          requestsUsed: 0,
          warnings: [],
          unrecognisedKeys: [],
        } satisfies ActiveNetRawPayload,
      ];
    }

    const budget = new RequestBudget(this.tenant.tenantKey, this.tenant.maxRequestsPerRun);
    const result = await fetchTenant(this.tenant, window, { budget });
    return [
      {
        tenantKey: result.tenantKey,
        live: true,
        window,
        calendars: result.calendars,
        centreDetails: result.centreDetails,
        requestsUsed: result.requestsUsed,
        warnings: result.warnings,
        unrecognisedKeys: result.unrecognisedKeys,
      } satisfies ActiveNetRawPayload,
    ];
  }

  extract(raw: unknown[]): StructuredRecord[] {
    const payload = raw[0] as ActiveNetRawPayload | undefined;
    if (!payload) {
      this.report = null;
      return [];
    }

    const parsed = parseTenantCalendars(this.tenant, payload.calendars, { window: payload.window });
    const venueIndex = buildVenueIndex(this.tenant, payload.centreDetails);
    const applied = applyVenues(parsed.records, venueIndex);

    const warnings = [...payload.warnings, ...parsed.warnings, ...applied.warnings];
    this.report = {
      tenantKey: payload.tenantKey,
      live: payload.live,
      window: payload.window,
      requestsUsed: payload.requestsUsed,
      parse: parsed.stats,
      unmappedCentreIds: applied.unmappedCentreIds,
      recordsWithoutAddress: applied.recordsWithoutAddress,
      venuesWithoutGeo: applied.venuesWithoutGeo,
      recordsWithoutGeo: applied.recordsWithoutGeo,
      warnings,
      unrecognisedKeys: payload.unrecognisedKeys,
      health: assessRunHealth({
        tenantKey: payload.tenantKey,
        occurrencesParsed: applied.records.length,
        requestsUsed: payload.requestsUsed,
        // Baseline is a DB read; the runner supplies it when it has one. A fetch()
        // that never reached the DB simply reports no baseline (a first run is not
        // a collapse).
        baselineOccurrences: null,
        unrecognisedKeys: payload.unrecognisedKeys,
        warnings,
      }),
    };
    return applied.records;
  }

  /**
   * Self-assess the run just extracted (Adapter.assessRun). ingestSource calls this with
   * the source's trailing record-count baseline and turns an alerting verdict into a run
   * error, so a yield collapse or a payload-shape change lands on the T15 health board
   * instead of passing as a quiet green over an empty municipality.
   *
   * Re-runs the classification with the real baseline (extract() has none — it never
   * touches the DB) and updates the stored report so lastRunReport() and the check run
   * agree.
   */
  assessRun(baselineRecordsFound: number | null): AdapterRunDiagnostics | null {
    if (!this.report) return null;
    // A fixture dry-run must never alert: it is a synthetic single record, and comparing
    // it to a live baseline would fire a collapse on every non-live run.
    if (!this.report.live) return { code: 'fixture_dry_run', alert: false, detail: 'fixture dry-run — no live data assessed' };

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

  /** The last run's honest accounting — parse stats, venue gaps, health verdict. */
  lastRunReport(): ActiveNetRunReport | null {
    return this.report;
  }

  dedupKeys(record: StructuredRecord): DedupKey {
    return { key: `activenet::${this.tenant.tenantKey}::${record.sourceRecordId}` };
  }
}

export function loadActiveNetAdapters(): ActiveNetAdapter[] {
  return ACTIVENET_TENANTS.map((tenant) => new ActiveNetAdapter(tenant));
}

export {
  ACTIVENET_TENANTS,
  ACTIVENET_PORTAL_VERSION,
  getTenantConfig,
  ingestableTenants,
  calendarPageUrl,
  restBaseUrl,
  policyKeyFor,
};
export type { ActiveNetTenantConfig };
