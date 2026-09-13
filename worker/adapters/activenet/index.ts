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
  type ActiveNetEvent,
  type ClientOptions,
  type CalendarFetchResult,
  type EventWindow,
  type TenantFetchResult,
} from './client';
import { parseTenantCalendars, allAgesInPlay, type ParseResult } from './parse';
import { ActivityAgeResolver } from './activity-age';
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
  /** F-8 phone-coverage accounting: how many centres published a number, how many of
   *  those this run refused, and which. Stored on the report (not just handed to the
   *  first assessRunHealth call) because assessRun() re-classifies from the report and
   *  has no venue index to recompute them from. */
  phonesOffered: number;
  phonesRejected: number;
  venuesWithRejectedPhone: string[];
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

  /** Per-run, lazily created so a fixture run never builds one. Caches per activity id. */
  private ageResolver: ActivityAgeResolver | null = null;

  /**
   * `clientOverrides` is the same test seam ClientOptions already documents for `fetchImpl` —
   * forwarded into the real request path, never used to bypass it. Unset in production.
   */
  constructor(
    private readonly tenant: ActiveNetTenantConfig,
    private readonly clientOverrides: Partial<Omit<ClientOptions, 'budget'>> = {}
  ) {}

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

  /**
   * Replace a guess about age with the source's own answer — for the few records where the
   * guess is worth a request.
   *
   * RUNS HERE, NOT IN extract(), for two reasons. extract() is a pure, synchronous parse over a
   * captured payload and is worth keeping that way: every fixture assertion in the suite depends
   * on running it without a network. And ingest already awaits this hook per record
   * (worker/core/ingest.ts), which is exactly the shape a cached, gated lookup wants.
   *
   * The verdict is three-way, and the third arm is the point:
   *   • source states bounds     -> publish them exactly (`ageBounds`, highest authority)
   *   • source says "All ages,"  -> publish all-ages, now ATTRIBUTABLE rather than inferred
   *   • lookup fails / no answer -> leave the record exactly as parsed, which for an
   *                                 unattributed all-ages phrase means no claim at all
   * A failed lookup must never upgrade a record's confidence, so there is no fallback that
   * invents a bound.
   */
  async normalizeHook(record: StructuredRecord): Promise<StructuredRecord> {
    const event = record.raw as ActiveNetEvent | undefined;
    if (!event || !this.isLiveFetchEnabled() || !allAgesInPlay(event)) return record;

    if (!this.ageResolver) {
      // Its own budget: a verification lookup must not be able to eat the crawl's request cap
      // and silently truncate the listing fetch — that would trade a municipality's coverage
      // for an age correction.
      const budget = new RequestBudget(
        `${this.tenant.tenantKey}:activity-age`,
        this.tenant.maxRequestsPerRun
      );
      this.ageResolver = new ActivityAgeResolver(this.tenant, { budget, ...this.clientOverrides });
    }

    const bounds = await this.ageResolver.resolve(event.event_item_id);
    return bounds ? { ...record, ageBounds: bounds } : record;
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
      phonesOffered: applied.phonesOffered,
      phonesRejected: applied.phonesRejected,
      venuesWithRejectedPhone: applied.venuesWithRejectedPhone,
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
        phonesOffered: applied.phonesOffered,
        phonesRejected: applied.phonesRejected,
        venuesWithRejectedPhone: applied.venuesWithRejectedPhone,
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
      // Omitting these would make the phone verdict cosmetic: extract() raises it, but
      // THIS call is the only one ingestSource sees — it would overwrite the alert with a
      // phone-blind `ok` (see phonesOffered's docstring above for why there's no index here).
      phonesOffered: this.report.phonesOffered,
      phonesRejected: this.report.phonesRejected,
      venuesWithRejectedPhone: this.report.venuesWithRejectedPhone,
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
