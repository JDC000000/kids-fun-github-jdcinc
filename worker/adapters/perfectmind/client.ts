// worker/adapters/perfectmind/client.ts — G-T8-3: live PerfectMind BookMe4 fetch client.
//
// The BookMe4 page is an ASP.NET MVC + Kendo UI shell that loads its schedule by AJAX,
// but the AJAX endpoints answer PLAIN HTTP. Verified live 2026-07-30 and independently
// RE-VERIFIED 2026-07-31 with the project's own identified KidsFunBot UA: no cookie, no
// session, no anti-forgery token, no browser-spoofed User-Agent, no headless render.
// This client keeps it that way — see config.ts for the D-10/D-11 authority note and
// tests/compliance/no-bypass.test.ts for the enforced posture.
//
// EVERY request goes through the shared politeFetch seam (worker/health/policy.ts):
// identified UA, per-source rate limiting, per-request deadline, 403/429 backoff. This
// adapter opens no HTTP path of its own and forks none of H4/H5/H6's infrastructure.
//
// ── MEASURED CONTRACT QUIRKS (verified by ablation, not assumed) ─────────────────────
//
//  1. PAGINATION IS TWO NESTED LOOPS: `after` walks WITHIN a stride, `page` selects the
//     STRIDE. Both are load-bearing. `dateString` is inert.
//
//     ⚠️ THE FIRST VERSION OF THIS FILE GOT THIS HALF WRONG AND THE COMMENT THAT USED TO
//     SIT HERE ASSERTED THE WRONG CONCLUSION WITH CONFIDENCE. It claimed `page` "silently
//     drops" data and pinned `page: 0` forever. What actually happens is that `page` is a
//     14-day STRIDE SELECTOR (the vendor's own `numberOfDaysToLoad: 14`), so pinning it
//     to 0 caps the adapter at day 13 REGARDLESS of the window it claims to ingest — and
//     it does so while reporting `truncated: false` and no warnings, which is the worst
//     possible failure shape. QA caught it by driving the real client against the real
//     portal and noticing the returned span was exactly half the declared window.
//     Recorded at length because the wrong conclusion was the dangerous part, not the code.
//
//     Full walk, measured against NVRC's Open Gym calendar on 2026-07-31
//     (today = 2026-07-31, so stride 0 = 07-31..08-13 and stride 1 = 08-14..08-27):
//
//       page=0, no cursor         -> 54 records, 07-31..08-05, nextKey 2026-08-05
//       page=0, after=2026-08-05  -> 58 records, 08-06..08-11, nextKey 2026-08-11
//       page=0, after=2026-08-11  -> 15 records, 08-12..08-13, nextKey 2026-08-13
//       page=0, after=2026-08-13  ->  0 records,            -, nextKey 0001-01-01  <- stride 0 done
//       page=1, no cursor         -> 50 records, 08-14..08-18, nextKey 2026-08-18
//       page=1, after=2026-08-18  -> 56 records, 08-19..08-24, nextKey 2026-08-24
//       page=1, after=2026-08-27  ->  0 records,            -, nextKey 0001-01-01  <- stride 1 done
//
//     Note what the earlier ablation missed: `page=1, no cursor` looked like it "skipped"
//     08-06..08-13, but that data is not skipped at all — it is reachable, and only
//     reachable, by continuing the CURSOR inside stride 0. Neither loop alone is
//     sufficient: cursor-only stops at day 13, stride-only drops everything past each
//     stride's first ~55 records.
//
//     `dateString` IS genuinely inert. Ablated three ways: absent, `2026-08-06`, and
//     `20260806` all returned the byte-identical payload. It is sent empty purely for
//     contract fidelity with the vendor's own client and must never bound anything.
//
//     Corroborated against that client
//     (/Scripts/BookMe4/Controllers/ClassBookingV2Controller.js?07231003), which posts
//     `{ calendarId, widgetId, page: pagesLoaded, dateString, values, after }`, does
//     `me.after = result.nextKey` after each response, and increments `pagesLoaded` ONLY
//     when a response comes back EMPTY. That last detail is the whole contract in one
//     line: an empty response means "this stride is finished, move to the next one" —
//     which is exactly what fetchCalendar() below now implements.
//
//  2. `nextKey` IS THE CURSOR, and `"0001-01-01"` (.NET `DateTime.MinValue`) is an
//     END-OF-STRIDE sentinel — NOT end-of-data. Reading it as end-of-data is precisely
//     the bug described above: stride 0 hands it back at day 13 while stride 1 still
//     holds a fortnight of occurrences.
//
//  3. THE VENDOR'S CLIENT SENDS AN ANTI-FORGERY TOKEN AND WE DO NOT. The shell embeds
//     `__RequestVerificationToken` and the browser posts it via `$.ajaxAntiForgeryPost`.
//     The server does not require it (verified: 200 OK without). Not sending it is a
//     compliance requirement, not an optimisation — see buildFormBody(), which is a
//     closed allow-list of field names precisely so a token can never be added by
//     accident, and tests/adapters/perfectmind.test.ts, which asserts it on the wire.
import { politeFetch } from '../../health/policy';
import { clientsBaseUrl, policyKeyFor, type PerfectMindTenantConfig } from './config';

export const ADAPTER_FAMILY = 'perfectmind';

/** Read-only endpoint paths, relative to `/{orgId}/Clients`. Both are POST-AS-QUERY
 *  SEARCHES — they mutate nothing; the vendor uses POST only because the widget/filter
 *  payload is a form body rather than a query string. They are a named exception carried
 *  by tests/compliance/no-bypass.test.ts (READ_ONLY_POST_SEARCH, decisions_register
 *  D-11), host-scoped to this file's tenants.
 *
 *  DELIBERATELY ABSENT: `/BookMe4BookingPages/Courses`. It returns REGISTERED COURSES,
 *  not drop-in occurrences (Richmond: 1,207 course items). Conflating the two would
 *  manufacture drop-in coverage that does not exist, which is the exact failure G-T8-1
 *  was written to prevent. It is not in the allow-list and must not be added without a
 *  separate, reviewed decision. */
export const ENDPOINTS = {
  categories: '/BookMe4V2/GetCategoriesDataV2',
  classes: '/BookMe4BookingPagesV2/ClassesV2',
} as const;

/** `nextKey` sentinel meaning "this STRIDE is exhausted" — .NET `DateTime.MinValue`.
 *  Deliberately NOT named END_OF_DATA: reading it as end-of-data is the exact bug this
 *  module shipped with once, and a name is the cheapest place to prevent a repeat. */
export const END_OF_STRIDE_CURSOR = '0001-01-01';

/** Days covered by one `page` stride — the vendor's own `numberOfDaysToLoad: 14`,
 *  observed inline in the BookMe4 page shell and confirmed by the walk in the header. */
export const STRIDE_DAYS = 14;

/** Strides needed to cover `windowDays` of schedule. Derived, not hard-coded, so the
 *  ingest window and the crawl depth can never drift apart — the drift that produced the
 *  half-empty window in the first place. */
export function stridesForWindow(windowDays: number): number {
  return Math.max(1, Math.ceil(windowDays / STRIDE_DAYS));
}

/** Transient-server-error retries. 429/403 are NEVER retried in-run. */
const MAX_TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_BASE_MS = 2_000;
/** Never sleep longer than this inside a run — beyond it, circuit-break instead. */
const MAX_IN_RUN_BACKOFF_MS = 30_000;

/** Hard ceiling on cursor pages WITHIN one stride. A cursor loop over a vendor-controlled
 *  key is exactly the shape that can spin forever if the vendor's `nextKey` ever stops
 *  advancing, so it is bounded independently of the request budget. Measured need is 3-4
 *  pages for the busiest NVRC calendar; 12 is ~3x headroom. */
export const MAX_PAGES_PER_STRIDE = 12;

/** Consecutive EMPTY STRIDES tolerated before a calendar is considered finished. The
 *  vendor's own client bumps `page` once on an empty response and gives up on the second
 *  (`loadZeroEventsInARow > 1`); we mirror that, at stride granularity. */
export const MAX_EMPTY_STRIDES_IN_A_ROW = 2;

// ── run observability (mirrors H6's ActiveNet treatment, deliberately) ───────────────
// Same problem, same shape of answer: a paginated crawl against a 3s politeness floor is
// minutes long BY CONSTRUCTION, so a run with no per-request log is indistinguishable
// from a wedged one. One greppable line per request and per calendar.
//
// NEVER logged: response bodies, headers, or anything a caller supplied. Only the tenant
// key, the endpoint NAME, the request path, HTTP status, timings and budget counters.
const CLIENT_LOG = '[perfectmind:client]';
const RUN_LOG = '[perfectmind]';

/** Error text for a log line, with any absolute URL reduced to its path. Mirrors the
 *  ActiveNet client's safeErrLabel: FetchTimeoutError embeds the full request URL in its
 *  message, and this module's discipline is pathname-only. */
function safeErrLabel(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw.replace(/https?:\/\/\S+/g, (candidate) => {
    try {
      return new URL(candidate).pathname;
    } catch {
      return '[url]';
    }
  });
}

// ── typed failures (the circuit breaker's vocabulary) ────────────────────────────────

export class PerfectMindFetchError extends Error {
  constructor(
    message: string,
    readonly tenantKey: string,
    readonly kind: 'blocked' | 'rate_limited' | 'unavailable' | 'protocol' | 'request_cap'
  ) {
    super(message);
    this.name = 'PerfectMindFetchError';
  }
}

/** HTTP 403 — an explicit block. Stop the run; never retry into it. */
export class WidgetBlockedError extends PerfectMindFetchError {
  constructor(tenantKey: string, path: string) {
    super(`PerfectMind widget returned 403 (blocked) for ${tenantKey} at ${path}`, tenantKey, 'blocked');
  }
}

/** HTTP 429 — an explicit rate-limit signal. Stop the run and let the daily cadence
 *  retry; politeFetch has already armed the process-level backoff. */
export class WidgetRateLimitedError extends PerfectMindFetchError {
  constructor(
    tenantKey: string,
    path: string,
    readonly retryAfterSeconds: number | null
  ) {
    super(
      `PerfectMind widget returned 429 for ${tenantKey} at ${path}` +
        (retryAfterSeconds != null ? ` (Retry-After: ${retryAfterSeconds}s)` : ''),
      tenantKey,
      'rate_limited'
    );
  }
}

/** 5xx after bounded exponential backoff — the vendor is unwell, not blocking us. */
export class WidgetUnavailableError extends PerfectMindFetchError {
  constructor(tenantKey: string, path: string, status: number) {
    super(`PerfectMind widget returned ${status} for ${tenantKey} at ${path} after retries`, tenantKey, 'unavailable');
  }
}

/** The payload did not have the shape we parse — a contract break, not a network fault. */
export class WidgetProtocolError extends PerfectMindFetchError {
  constructor(tenantKey: string, detail: string) {
    super(`PerfectMind payload contract violation for ${tenantKey}: ${detail}`, tenantKey, 'protocol');
  }
}

export class RequestCapExceededError extends PerfectMindFetchError {
  constructor(tenantKey: string, cap: number) {
    super(`PerfectMind run for ${tenantKey} hit its hard request cap (${cap})`, tenantKey, 'request_cap');
  }
}

/** Hard per-run request budget. Bounds the crawl footprint even if config or the
 *  vendor's category tree changes underneath us. */
export class RequestBudget {
  private used = 0;
  constructor(
    readonly tenantKey: string,
    readonly cap: number
  ) {}

  spend(): void {
    if (this.used >= this.cap) throw new RequestCapExceededError(this.tenantKey, this.cap);
    this.used += 1;
  }

  get spent(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.cap - this.used);
  }
}

// ── wire types (this module owns the vendor contract; parse.ts consumes it) ──────────

export interface BookMe4BookingTypeInfo {
  BookingType?: number;
  [k: string]: unknown;
}

export interface BookMe4Calendar {
  Id?: string;
  Name?: string;
  BookingLink?: string | null;
  BookingTypeInfo?: BookMe4BookingTypeInfo;
  [k: string]: unknown;
}

export interface BookMe4Category {
  Name?: string;
  OriginalName?: string;
  ShowCalendarCategory?: boolean;
  Calendars?: BookMe4Calendar[];
  [k: string]: unknown;
}

export interface BookMe4Address {
  AddressTag?: string | null;
  Street?: string | null;
  City?: string | null;
  PostalCode?: string | null;
  Latitude?: number | null;
  Longitude?: number | null;
  [k: string]: unknown;
}

/** One `classes[]` record. Only the fields the parser reads are named; the rest ride in
 *  `[k: string]: unknown` and are surfaced by the unrecognised-key canary below. */
export interface BookMe4Class {
  EventId?: string;
  CourseId?: string;
  EventName?: string;
  Details?: string;
  /** `yyyyMMdd`, LOCAL date, no offset. */
  OccurrenceDate?: string;
  /** `hh:mm tt - hh:mm tt`, LOCAL wall clock, no offset. */
  EventTimeDescription?: string;
  /** DISPLAY-ONLY price string. NOT trustworthy — see parse.ts classifyCost(). */
  PriceRange?: string | null;
  AllDayEvent?: boolean;
  DurationInMinutes?: number | null;
  /** Structured age bounds. Better than any free text — see parse.ts resolveAgeText(). */
  MinAge?: number | null;
  MinAgeMonths?: number | null;
  MaxAge?: number | null;
  MaxAgeMonths?: number | null;
  NoAgeRestriction?: boolean;
  AgeRestrictions?: string | null;
  DisplayableRestrictionsForCourses?: string | null;
  Facility?: string | null;
  Location?: string | null;
  Address?: BookMe4Address | null;
  OrgName?: string | null;
  Spots?: string | null;
  BookButtonText?: string | null;
  [k: string]: unknown;
}

export interface ClassesV2Response {
  classes?: BookMe4Class[];
  classesMaxEndDateString?: string | null;
  nextKey?: string | null;
  [k: string]: unknown;
}

/** One calendar's fetched slice. */
export interface CalendarFetchResult {
  calendarId: string;
  calendarName?: string;
  categoryName?: string;
  classes: BookMe4Class[];
  occurrenceCount: number;
  /** Total requests spent on this calendar, across all strides. */
  pagesFetched: number;
  /** How many 14-day strides were actually walked. A run that walks fewer strides than
   *  the window needs is covering less than it claims — surfaced so that can be seen. */
  stridesWalked: number;
  /** True when a stride stopped on MAX_PAGES_PER_STRIDE rather than on the vendor saying
   *  "no more" — i.e. the slice may be incomplete. Reported, not hidden. */
  truncated: boolean;
  warnings: string[];
}

export interface TenantFetchResult {
  tenantKey: string;
  calendars: CalendarFetchResult[];
  requestsUsed: number;
  warnings: string[];
  /** Top-level payload keys we did not recognise — the shape-drift canary. */
  unrecognisedKeys: string[];
}

// ── recognised-shape canary ─────────────────────────────────────────────────────────
// These endpoints are undocumented and unversioned. An unrecognised TOP-LEVEL key means
// the vendor added something; that is a signal to re-verify the parser, not a crash.
// Collected and surfaced (health.ts routes it to a source_check_run) — never thrown, so
// a benign addition degrades to a warning instead of emptying a municipality.

const KNOWN_CLASSES_KEYS = ['classes', 'classesMaxEndDateString', 'nextKey'];

const KNOWN_CATEGORY_KEYS = ['Name', 'OriginalName', 'ShowCalendarCategory', 'Calendars'];

/** Record-level keys measured on 2026-07-31. A NEW key here is informational drift; a
 *  MISSING key the parser depends on is caught by parse.ts, not here. */
export const KNOWN_CLASS_KEYS: readonly string[] = [
  'EventId', 'CourseId', 'CourseIdTrimmed', 'EventName', 'Details', 'Spots', 'OccurrenceDate',
  'BookButtonText', 'BookButtonDescription', 'ClosedButtonName', 'Instructor', 'Facility',
  'DisplaySettings', 'PriceRange', 'AllDayEvent', 'AnyTimeBrokenOccurrences',
  'FormattedStartDate', 'FormattedStartTime', 'FormattedEndDate', 'FormattedEndTime',
  'FirstOccurrenceFormattedEndTime', 'EventTimeDescription', 'AlternativeLocation',
  'HasAlternativeLocation', 'OccurrenceDescription', 'Occurrences', 'NumberOfSessions',
  'PrerequisiteEvents', 'DisplayablePrerequisiteEventsRestrictionsForCourses',
  'DisplayableRestrictionsForCourses', 'MinAge', 'MinAgeMonths', 'MaxAge', 'MaxAgeMonths',
  'NoAgeRestriction', 'AgeRestrictions', 'GenderRestrictions', 'RankRestrictions',
  'FromRank', 'ToRank', 'StartingRankId', 'EndingRankId', 'DurationInMinutes',
  'FeeFrequency', 'OrgLogo', 'OrgIsSingleLocation', 'OrgLegalName', 'OrgName', 'Address',
  'Location', 'BookingType',
] as const;

function unrecognised(known: readonly string[], obj: unknown): string[] {
  if (!obj || typeof obj !== 'object') return [];
  const set = new Set(known);
  return Object.keys(obj as Record<string, unknown>).filter((k) => !set.has(k));
}

/** Unrecognised keys across a page of class records, capped so a wholesale contract
 *  change reports a readable signal rather than thousands of duplicate strings. */
export function unrecognisedClassKeys(classes: BookMe4Class[]): string[] {
  const out = new Set<string>();
  for (const c of classes) {
    for (const k of unrecognised(KNOWN_CLASS_KEYS, c)) out.add(k);
    if (out.size > 25) break;
  }
  return [...out];
}

// ── the fetch primitive ─────────────────────────────────────────────────────────────

export interface ClientOptions {
  budget: RequestBudget;
  /** Injectable for tests — FORWARDED to politeFetch, never used to bypass it. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep, used for BOTH this module's retry backoff and (forwarded)
   *  politeFetch's rate-limiter wait, so a test exercises the real politeness path
   *  without paying its wall-clock cost. Unset in production. */
  sleepImpl?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfter(res: Response): number | null {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : null;
}

/**
 * The ONLY place a request body is constructed, and deliberately a CLOSED ALLOW-LIST of
 * field names rather than a spread of a caller-supplied object.
 *
 * This is a compliance control, not a style choice. The one field this vendor's own
 * client sends that we must never send is `__RequestVerificationToken`; a
 * `{...fields}` spread would let a future edit add it in one line, in a file whose POST
 * is already allow-listed. With a closed list, adding it is a visible edit to THIS
 * function — which is also what tests/adapters/perfectmind.test.ts asserts against.
 */
export function buildFormBody(fields: {
  widgetId: string;
  calendarId?: string;
  page?: number;
  /** Measured to be ignored server-side; sent empty for contract fidelity only. */
  dateString?: string;
  /** The real cursor (previous response's `nextKey`). */
  after?: string;
}): string {
  const params = new URLSearchParams();
  params.set('widgetId', fields.widgetId);
  if (fields.calendarId != null) params.set('calendarId', fields.calendarId);
  if (fields.page != null) params.set('page', String(fields.page));
  params.set('dateString', fields.dateString ?? '');
  params.set('after', fields.after ?? '');
  return params.toString();
}

const FORM_POST_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/x-www-form-urlencoded',
};

/**
 * One polite, credential-free request with the circuit-breaker policy applied.
 *  • 403 → WidgetBlockedError immediately (never retry into a block).
 *  • 429 → WidgetRateLimitedError immediately, carrying Retry-After for the scheduler.
 *  • 5xx → bounded exponential backoff (honouring a short Retry-After), then
 *          WidgetUnavailableError.
 *  • other non-2xx → WidgetProtocolError.
 */
async function request<T>(
  tenant: PerfectMindTenantConfig,
  endpoint: keyof typeof ENDPOINTS,
  url: URL,
  body: string,
  opts: ClientOptions
): Promise<T> {
  const sleep = opts.sleepImpl ?? defaultSleep;
  const attemptsAllowed = MAX_TRANSIENT_RETRIES + 1;
  let lastStatus = 0;

  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
    try {
      opts.budget.spend();
    } catch (err) {
      // Run-ending, so it has to be the loudest line in the log rather than an
      // unexplained abort.
      // eslint-disable-next-line no-console
      console.warn(
        `${CLIENT_LOG} ${tenant.tenantKey} ${endpoint} request budget exhausted at ${opts.budget.cap} — aborting run`
      );
      throw err;
    }
    const label = `${tenant.tenantKey} ${endpoint} attempt ${attempt + 1}/${attemptsAllowed} req ${opts.budget.spent}/${opts.budget.cap}`;
    // eslint-disable-next-line no-console
    console.log(`${CLIENT_LOG} ${label} start ${url.pathname}`);

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await politeFetch(
        policyKeyFor(tenant),
        url,
        { method: 'POST', headers: FORM_POST_HEADERS, body },
        { family: ADAPTER_FAMILY, fetchImpl: opts.fetchImpl, sleepImpl: opts.sleepImpl }
      );
    } catch (err) {
      // politeFetch threw instead of answering: a blown per-request deadline (H4) or an
      // already-armed crawl backoff. The elapsed time is the tell.
      // eslint-disable-next-line no-console
      console.warn(`${CLIENT_LOG} ${label} threw after ${Date.now() - startedAt}ms: ${safeErrLabel(err)}`);
      throw err;
    }
    const elapsedMs = Date.now() - startedAt;
    // eslint-disable-next-line no-console
    console.log(`${CLIENT_LOG} ${label} status=${res.status} in ${elapsedMs}ms`);
    lastStatus = res.status;

    if (res.status === 403) {
      // eslint-disable-next-line no-console
      console.warn(`${CLIENT_LOG} ${label} 403 blocked — circuit-breaking the run`);
      throw new WidgetBlockedError(tenant.tenantKey, url.pathname);
    }
    if (res.status === 429) {
      const retryAfterSeconds = parseRetryAfter(res);
      // eslint-disable-next-line no-console
      console.warn(
        `${CLIENT_LOG} ${label} 429 rate-limited (retry-after ${retryAfterSeconds ?? 'unset'}) — circuit-breaking the run`
      );
      throw new WidgetRateLimitedError(tenant.tenantKey, url.pathname, retryAfterSeconds);
    }
    if (res.status >= 500) {
      if (attempt === MAX_TRANSIENT_RETRIES) {
        // eslint-disable-next-line no-console
        console.warn(`${CLIENT_LOG} ${label} HTTP ${res.status} — ${attemptsAllowed} attempts exhausted, giving up`);
        break;
      }
      const retryAfterMs = (parseRetryAfter(res) ?? 0) * 1000;
      const backoff = Math.max(TRANSIENT_BACKOFF_BASE_MS * 2 ** attempt, retryAfterMs);
      if (backoff > MAX_IN_RUN_BACKOFF_MS) {
        // eslint-disable-next-line no-console
        console.warn(
          `${CLIENT_LOG} ${label} HTTP ${res.status} — required backoff ${backoff}ms exceeds the ` +
            `${MAX_IN_RUN_BACKOFF_MS}ms in-run ceiling, giving up`
        );
        break;
      }
      // eslint-disable-next-line no-console
      console.warn(`${CLIENT_LOG} ${label} HTTP ${res.status} transient — retrying in ${backoff}ms`);
      await sleep(backoff);
      continue;
    }
    if (!res.ok) {
      throw new WidgetProtocolError(tenant.tenantKey, `HTTP ${res.status} at ${url.pathname}`);
    }

    try {
      return (await res.json()) as T;
    } catch {
      throw new WidgetProtocolError(tenant.tenantKey, `non-JSON response at ${url.pathname}`);
    }
  }

  throw new WidgetUnavailableError(tenant.tenantKey, url.pathname, lastStatus);
}

function endpointUrl(tenant: PerfectMindTenantConfig, endpoint: keyof typeof ENDPOINTS): URL {
  const url = new URL(`${clientsBaseUrl(tenant)}${ENDPOINTS[endpoint]}`);
  // The vendor's own start page carries `?embed=False`; harmless and kept for fidelity.
  if (endpoint === 'categories') url.searchParams.set('embed', 'False');
  return url;
}

// ── endpoint wrappers ───────────────────────────────────────────────────────────────

/** BookingType 2 = the "Classes" surface ClassesV2 serves; 3 = registered "Courses",
 *  which this adapter deliberately does not read. Measured on both tenants. */
export const CLASSES_BOOKING_TYPE = 2;

export interface DiscoveredCalendar {
  calendarId: string;
  calendarName: string;
  categoryName: string;
}

export async function fetchCategoryTree(
  tenant: PerfectMindTenantConfig,
  opts: ClientOptions
): Promise<{ categories: BookMe4Category[]; unrecognisedKeys: string[] }> {
  const body = await request<BookMe4Category[]>(
    tenant,
    'categories',
    endpointUrl(tenant, 'categories'),
    buildFormBody({ widgetId: tenant.widgetId }),
    opts
  );
  if (!Array.isArray(body)) {
    throw new WidgetProtocolError(tenant.tenantKey, 'GetCategoriesDataV2 did not return an array');
  }
  const keys = new Set<string>();
  for (const c of body) for (const k of unrecognised(KNOWN_CATEGORY_KEYS, c)) keys.add(`categories.${k}`);
  return { categories: body, unrecognisedKeys: [...keys] };
}

/**
 * The tenant's drop-in calendars, resolved from the live category tree by CATEGORY NAME.
 * Dynamic on purpose (G-T8-2): the calendar GUIDs churn, the category name does not.
 *
 * A calendar with an EMPTY `BookingLink` is kept but flagged — NVRC has one ("North Shore
 * Neighbourhood House Schedules") and it is a finding, not a rounding error.
 */
export function selectDropInCalendars(
  tenant: PerfectMindTenantConfig,
  categories: BookMe4Category[]
): { calendars: DiscoveredCalendar[]; warnings: string[] } {
  const warnings: string[] = [];
  const wanted = new Set(tenant.dropInCategoryNames);
  const seenCategoryNames = new Set<string>();
  const calendars: DiscoveredCalendar[] = [];

  for (const category of categories) {
    const name = category.Name ?? '';
    seenCategoryNames.add(name);
    if (!wanted.has(name)) continue;
    for (const cal of category.Calendars ?? []) {
      if (!cal.Id) {
        warnings.push(`category "${name}": a calendar has no Id and was skipped`);
        continue;
      }
      const bookingType = cal.BookingTypeInfo?.BookingType;
      if (bookingType !== CLASSES_BOOKING_TYPE) {
        // Not servable by ClassesV2 — reading it would silently yield nothing.
        warnings.push(
          `category "${name}": calendar "${cal.Name ?? cal.Id}" has BookingType ${bookingType ?? 'unset'} ` +
            `(expected ${CLASSES_BOOKING_TYPE}) — skipped, it is not a drop-in schedule`
        );
        continue;
      }
      if (!cal.BookingLink) {
        warnings.push(`category "${name}": calendar "${cal.Name ?? cal.Id}" has an empty BookingLink — expect zero yield`);
      }
      calendars.push({ calendarId: cal.Id, calendarName: cal.Name ?? cal.Id, categoryName: name });
    }
  }

  for (const want of wanted) {
    if (!seenCategoryNames.has(want)) {
      warnings.push(`configured drop-in category "${want}" is ABSENT from the live widget tree`);
    }
  }
  return { calendars, warnings };
}

/** One cursor page within one stride of a calendar's occurrences. */
export async function fetchClassesPage(
  tenant: PerfectMindTenantConfig,
  calendarId: string,
  stride: number,
  after: string | undefined,
  opts: ClientOptions
): Promise<ClassesV2Response & { unrecognisedKeys: string[] }> {
  const body = await request<ClassesV2Response>(
    tenant,
    'classes',
    endpointUrl(tenant, 'classes'),
    // `page` IS the stride selector and MUST advance — see header note 1. Pinning it to 0
    // caps the crawl at day 13 while still reporting a clean run.
    buildFormBody({ widgetId: tenant.widgetId, calendarId, page: stride, after }),
    opts
  );
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new WidgetProtocolError(tenant.tenantKey, 'ClassesV2 did not return an object');
  }
  const keys = unrecognised(KNOWN_CLASSES_KEYS, body).map((k) => `classes.${k}`);
  for (const k of unrecognisedClassKeys(body.classes ?? [])) keys.push(`classes[].${k}`);
  return { ...body, unrecognisedKeys: keys };
}

/**
 * Walk one calendar over `strides` fourteen-day strides, exhausting the `after` cursor
 * inside each one. TWO NESTED LOOPS, because the vendor's pagination is two nested loops
 * (header note 1):
 *
 *   outer — `page` 0..strides-1, each covering 14 days from today
 *   inner — `after` = the previous response's `nextKey`, until this stride is exhausted
 *
 * Stride transition: an EMPTY response, or the `"0001-01-01"` END_OF_STRIDE_CURSOR
 * sentinel, means "this stride is finished" — increment `page`, RESET the cursor, keep
 * going. It does NOT mean end-of-data, and treating it as such is the bug this function
 * shipped with once (it capped every run at day 13 of a 28-day window while reporting
 * `truncated: false`).
 *
 * Termination, in precedence order:
 *   1. MAX_EMPTY_STRIDES_IN_A_ROW consecutive strides yielding nothing → done. Mirrors
 *      the vendor's own `loadZeroEventsInARow > 1`.
 *   2. All `strides` walked → done, having covered the caller's window.
 *   3. Inner: the cursor did not ADVANCE → end that stride. This is what makes the walk
 *      provably finite even if the vendor starts echoing a fixed key back; without it a
 *      cursor loop is an infinite loop waiting to happen.
 *   4. Inner: MAX_PAGES_PER_STRIDE reached with the cursor still advancing → `truncated`
 *      is set so the caller reports an incomplete slice instead of implying completeness.
 *
 * The request budget bounds everything from the outside regardless.
 */
export async function fetchCalendar(
  tenant: PerfectMindTenantConfig,
  calendar: DiscoveredCalendar,
  opts: ClientOptions,
  onUnrecognised?: (key: string) => void,
  strides = 1
): Promise<CalendarFetchResult> {
  const result: CalendarFetchResult = {
    calendarId: calendar.calendarId,
    calendarName: calendar.calendarName,
    categoryName: calendar.categoryName,
    classes: [],
    occurrenceCount: 0,
    pagesFetched: 0,
    stridesWalked: 0,
    truncated: false,
    warnings: [],
  };

  let emptyStridesInARow = 0;

  for (let stride = 0; stride < strides; stride += 1) {
    result.stridesWalked = stride + 1;
    let cursor: string | undefined;
    let strideYield = 0;
    let pagesInStride = 0;

    // Inner loop: exhaust this stride's cursor.
    for (;;) {
      const body = await fetchClassesPage(tenant, calendar.calendarId, stride, cursor, opts);
      result.pagesFetched += 1;
      pagesInStride += 1;
      body.unrecognisedKeys.forEach((k) => onUnrecognised?.(k));

      const batch = body.classes ?? [];
      result.classes.push(...batch);
      result.occurrenceCount += batch.length;
      strideYield += batch.length;

      // An empty response ends the stride — the vendor's own signal to move `page` on.
      if (batch.length === 0) break;

      const next = (body.nextKey ?? '').trim();
      if (!next || next === END_OF_STRIDE_CURSOR) break;
      if (cursor != null && next <= cursor) {
        // ISO `yyyy-MM-dd` compares correctly as a string. A non-advancing cursor is the
        // vendor telling us nothing new, however it dresses it up.
        result.warnings.push(
          `stride ${stride}: cursor did not advance past ${cursor} — stopping this stride to avoid a loop`
        );
        break;
      }
      cursor = next;

      if (pagesInStride >= MAX_PAGES_PER_STRIDE) {
        result.truncated = true;
        result.warnings.push(
          `stride ${stride}: stopped at the ${MAX_PAGES_PER_STRIDE}-page ceiling with the cursor still ` +
            `advancing (last ${cursor}) — this stride may be incomplete`
        );
        break;
      }
    }

    if (strideYield === 0) {
      emptyStridesInARow += 1;
      if (emptyStridesInARow >= MAX_EMPTY_STRIDES_IN_A_ROW) {
        // Two quiet fortnights in a row: stop asking.
        //
        // QA Q1 — THIS USED TO RETURN SILENTLY, and the comment that stood here argued
        // it should ("not a warning — this is the normal, expected way a short calendar
        // ends"). That argument is wrong in the one case that matters: when the walk ends
        // with strides STILL REMAINING, the run covered less of the window than it
        // declared and said nothing about it. That is B1's exact signature — a clean-
        // looking run over a partly-unexamined window — merely relocated from the stride
        // selector to the exit condition.
        //
        // Ending ON the last stride is genuinely normal and stays quiet. Ending EARLY is
        // reported, names the stride, and leaves `stridesWalked` where it actually
        // stopped so the caller can see the shortfall rather than infer it.
        //
        // (The empty-stride tolerance itself is deliberately NOT reduced: QA's live sweep
        // found NVRC's Skate Schedules has a genuinely empty stride 0 with all its records
        // in stride 1, so MAX_EMPTY_STRIDES_IN_A_ROW = 1 would silently drop a whole real
        // calendar today. The value is load-bearing exactly as it stands.)
        const stridesRemaining = strides - (stride + 1);
        if (stridesRemaining > 0) {
          result.warnings.push(
            `stopped after ${MAX_EMPTY_STRIDES_IN_A_ROW} consecutive empty stride(s) at stride ${stride} ` +
              `with ${stridesRemaining} stride(s) of the declared window never fetched`
          );
        }
        return result;
      }
    } else {
      emptyStridesInARow = 0;
    }
  }

  return result;
}

// ── the run: categories → per-calendar cursor walk ──────────────────────────────────

/**
 * Fetch one tenant's full drop-in slice. Request cost = 1 (categories) + Σ pages per
 * calendar, bounded by the tenant's `maxRequestsPerRun`.
 *
 * A per-calendar failure is captured as a warning and the run continues — one calendar
 * breaking must not empty a municipality. A BLOCK / RATE-LIMIT / CAP failure aborts the
 * whole run (circuit breaker), because continuing would mean hammering a host that has
 * just told us to stop.
 */
export async function fetchTenant(
  tenant: PerfectMindTenantConfig,
  opts: ClientOptions,
  strides = 1
): Promise<TenantFetchResult> {
  const warnings: string[] = [];
  const unrecognisedKeys = new Set<string>();
  const calendars: CalendarFetchResult[] = [];
  const runStartedAt = Date.now();

  // eslint-disable-next-line no-console
  console.log(
    `${RUN_LOG} ${tenant.tenantKey} run start — categories ${JSON.stringify(tenant.dropInCategoryNames)}, ` +
      `${strides} stride(s) x ${STRIDE_DAYS}d, cap ${opts.budget.cap} request(s)`
  );

  const tree = await fetchCategoryTree(tenant, opts);
  tree.unrecognisedKeys.forEach((k) => unrecognisedKeys.add(k));

  const selected = selectDropInCalendars(tenant, tree.categories);
  warnings.push(...selected.warnings);

  if (selected.calendars.length === 0) {
    warnings.push('no drop-in calendars resolved from the live widget tree — zero yield expected');
  }

  const total = selected.calendars.length;
  for (const [index, calendar] of selected.calendars.entries()) {
    const startedAt = Date.now();
    let result: CalendarFetchResult;
    try {
      result = await fetchCalendar(tenant, calendar, opts, (k) => unrecognisedKeys.add(k), strides);
    } catch (err) {
      if (
        err instanceof WidgetBlockedError ||
        err instanceof WidgetRateLimitedError ||
        err instanceof RequestCapExceededError
      ) {
        throw err;
      }
      const detail = err instanceof Error ? err.message : String(err);
      warnings.push(`calendar ${calendar.calendarName}: ${detail}`);
      result = {
        calendarId: calendar.calendarId,
        calendarName: calendar.calendarName,
        categoryName: calendar.categoryName,
        classes: [],
        occurrenceCount: 0,
        pagesFetched: 0,
        stridesWalked: 0,
        truncated: false,
        warnings: [detail],
      };
    }
    warnings.push(...result.warnings.map((w) => `calendar ${calendar.calendarName}: ${w}`));
    // eslint-disable-next-line no-console
    console.log(
      `${RUN_LOG} ${tenant.tenantKey} calendar "${calendar.calendarName}" (${index + 1}/${total}) — ` +
        `${result.occurrenceCount} occurrence(s) over ${result.stridesWalked} stride(s)/` +
        `${result.pagesFetched} page(s)` +
        `${result.truncated ? ' [TRUNCATED]' : ''} in ${Date.now() - startedAt}ms, ` +
        `req ${opts.budget.spent}/${opts.budget.cap}`
    );
    calendars.push(result);
  }

  const occurrences = calendars.reduce((n, c) => n + c.occurrenceCount, 0);
  // eslint-disable-next-line no-console
  console.log(
    `${RUN_LOG} ${tenant.tenantKey} run complete — ${calendars.length} calendar(s), ` +
      `${occurrences} occurrence(s), ${opts.budget.spent}/${opts.budget.cap} request(s), ` +
      `${warnings.length} warning(s) in ${Math.round((Date.now() - runStartedAt) / 1000)}s`
  );

  return {
    tenantKey: tenant.tenantKey,
    calendars,
    requestsUsed: opts.budget.spent,
    warnings,
    unrecognisedKeys: [...unrecognisedKeys],
  };
}
