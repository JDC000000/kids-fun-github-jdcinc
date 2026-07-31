// worker/adapters/activenet/client.ts — G-T7R-2: live ActiveCommunities fetch client.
//
// The portal is a JS SPA, but it is a thin client over a clean internal JSON REST API
// that answers PLAIN HTTP. Verified live 2026-07-30 with the project's own identified
// KidsFunBot UA: no cookie, no session, no CSRF/anti-forgery token, no browser-spoofed
// User-Agent, no headless render. This client keeps it that way — see config.ts for the
// D-10 authority note and tests/compliance/no-bypass.test.ts for the enforced posture.
//
// EVERY request goes through the shared politeFetch seam (worker/health/policy.ts):
// identified UA, per-source rate limiting, 403/429 backoff. This adapter opens no HTTP
// path of its own.
//
// ── MEASURED CONTRACT QUIRKS (verified, not assumed) ────────────────────────────────
//  1. `multicenter/events` IGNORES `start_date`/`end_date`. Requesting one day, one
//     week, or omitting the fields entirely all return the SAME payload: the tenant's
//     whole `calendar_period` (Vancouver 2026-07-26→09-20, Burnaby 2026-07-27→11-08 at
//     capture time). Proven by ablation on calendar 5: 1-day → 101 events spanning
//     07-27→09-19; 1-week → identical; no-dates → identical. `center_ids` IS honoured
//     (6 centres → 101 events, 1 centre → 30).
//     CONSEQUENCE: do NOT paginate by date window — it costs requests and returns the
//     same bytes. One request per calendar fetches the full period; the caller windows
//     client-side. The date fields are still SENT because the vendor's own client sends
//     them and a future server-side validation might require them.
//  2. `event_item_id` is the ACTIVITY id, not an occurrence id — it repeats across dates
//     (Vancouver: 3,072 distinct ids across 10,146 occurrences). Occurrence identity
//     needs id + start + centre + facilities (see parse.ts).
//  3. The `/calendars` list includes a "**Choose a Calendar" UI placeholder that is not
//     a calendar. Config excludes it explicitly.
import { politeFetch } from '../../health/policy';
import { restBaseUrl, policyKeyFor, type ActiveNetTenantConfig } from './config';

export const ADAPTER_FAMILY = 'activenet';

/** Read-only endpoint paths, relative to `{sitePath}/rest`. The two POST paths are
 *  POST-AS-QUERY SEARCHES — they mutate nothing; the vendor uses POST only because the
 *  filter payload is a JSON object. They are the sole, named exception carried by
 *  tests/compliance/no-bypass.test.ts (READ_ONLY_POST_SEARCH, decisions_register D-11). */
export const ENDPOINTS = {
  calendars: '/onlinecalendar/calendars',
  filters: '/onlinecalendar/filters',
  events: '/onlinecalendar/multicenter/events',
  centerDetails: '/onlinecalendar/centerdetails',
} as const;

const LOCALE = 'en-US';

/** Centre ids per centerdetails request — keeps the query string comfortably bounded. */
const CENTER_DETAILS_CHUNK = 50;

/** Transient-server-error retries. 429/403 are NEVER retried in-run (see below). */
const MAX_TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_BASE_MS = 2_000;
/** Never sleep longer than this inside a run — beyond it, circuit-break instead. */
const MAX_IN_RUN_BACKOFF_MS = 30_000;

// ── run observability (H6) ──────────────────────────────────────────────────────────
// THE PROBLEM THIS FIXES, observed 2026-07-31: the first real live Vancouver run took
// NINE MINUTES and emitted nothing at all between "job claimed" and "operator killed it".
// From `flyctl logs` there was no way to tell a healthy-but-slow run from a wedged one —
// and both are plausible here. Vancouver is 23 calendars ≈ 47 requests against a 3-second
// politeness floor, so ~2.5 minutes of the wall clock is *deliberate sleeping* before the
// portal has answered anything; add a few seconds of server time per request and a
// legitimate run is minutes long by construction.
//
// So every request now says what it is doing, what it cost, and how long it took. This is
// deliberately console.* and deliberately one greppable line per event: it matches the
// rest of the worker (`[scheduler] tick #N …`), needs no dependency, and costs a string
// concat per HTTP request against a 3s floor. It is a diagnosis aid, not telemetry.
//
// NEVER logged: response bodies, headers, or anything a caller supplied. Only the tenant
// key, the endpoint NAME, the request path, HTTP status, timings and the budget counters.
// There are no credentials anywhere in this flow — the discipline is kept regardless.
const CLIENT_LOG = '[activenet:client]';
const RUN_LOG = '[activenet]';

/**
 * Error text for a log line, with any absolute URL reduced to its path.
 *
 * QA finding A3: FetchTimeoutError embeds the FULL request URL — query string included —
 * in its message, so logging that message raw would bypass the `url.pathname`-only
 * discipline every other line in this module follows. Harmless against today's portal
 * (unauthenticated, `locale=en-US` the only param), but the project already holds an
 * ActiveNet API v2 key that could plausibly end up on a query string in this same file
 * later, and a redaction added only once that happens is a redaction added too late.
 * The rest of the message is preserved — "socket hang up" is exactly what a reader needs.
 */
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

export class ActiveNetFetchError extends Error {
  constructor(
    message: string,
    readonly tenantKey: string,
    readonly kind: 'blocked' | 'rate_limited' | 'unavailable' | 'protocol' | 'request_cap'
  ) {
    super(message);
    this.name = 'ActiveNetFetchError';
  }
}

/** HTTP 403 — an explicit block. Stop the run; do not retry into it. */
export class PortalBlockedError extends ActiveNetFetchError {
  constructor(tenantKey: string, url: string) {
    super(`ActiveNet portal returned 403 (blocked) for ${tenantKey} at ${url}`, tenantKey, 'blocked');
  }
}

/** HTTP 429 — an explicit rate-limit signal. Stop the run and let the daily cadence
 *  retry; sleeping out a multi-minute Retry-After inside a run is worse than stopping,
 *  and retrying against an explicit "too many requests" is exactly the thing the
 *  hygiene rules forbid. politeFetch has already armed the process-level backoff. */
export class PortalRateLimitedError extends ActiveNetFetchError {
  constructor(
    tenantKey: string,
    url: string,
    readonly retryAfterSeconds: number | null
  ) {
    super(
      `ActiveNet portal returned 429 for ${tenantKey} at ${url}` +
        (retryAfterSeconds != null ? ` (Retry-After: ${retryAfterSeconds}s)` : ''),
      tenantKey,
      'rate_limited'
    );
  }
}

/** 5xx after bounded exponential backoff — the vendor is unwell, not blocking us. */
export class PortalUnavailableError extends ActiveNetFetchError {
  constructor(tenantKey: string, url: string, status: number) {
    super(`ActiveNet portal returned ${status} for ${tenantKey} at ${url} after retries`, tenantKey, 'unavailable');
  }
}

/** The payload did not have the shape we parse — a contract break, not a network fault. */
export class PortalProtocolError extends ActiveNetFetchError {
  constructor(tenantKey: string, detail: string) {
    super(`ActiveNet payload contract violation for ${tenantKey}: ${detail}`, tenantKey, 'protocol');
  }
}

export class RequestCapExceededError extends ActiveNetFetchError {
  constructor(tenantKey: string, cap: number) {
    super(`ActiveNet run for ${tenantKey} hit its hard request cap (${cap})`, tenantKey, 'request_cap');
  }
}

/** Hard per-run request budget. Bounds the crawl footprint even if config or the
 *  vendor's calendar list changes underneath us. */
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

export interface ActiveNetEnvelope<TBody> {
  headers?: { response_code?: string; response_message?: string; [k: string]: unknown };
  body?: TBody;
}

export interface ActiveNetCalendar {
  calendar_id: number;
  name: string;
  retired?: boolean;
  hide_on_internet?: boolean;
  [k: string]: unknown;
}

export interface ActiveNetCentreRef {
  id: number;
  name: string;
}

export interface ActiveNetFacility {
  facility_id?: number;
  facility_name?: string;
  center_id?: number;
  center_name?: string;
  [k: string]: unknown;
}

export interface ActiveNetPrice {
  free?: boolean;
  estimate_price?: string | null;
  [k: string]: unknown;
}

export interface ActiveNetEvent {
  title?: string;
  /** LOCAL wall-clock, no offset: "2026-07-30 15:30:00". */
  start_time?: string;
  end_time?: string;
  description?: string;
  event_item_id?: number;
  activity_detail_url?: string;
  activity_location_desc?: string;
  facilities?: ActiveNetFacility[];
  price?: ActiveNetPrice;
  instructors?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface ActiveNetCentreEvents {
  center_id: number;
  center_name?: string;
  events?: ActiveNetEvent[];
  total?: number;
  extra_notes?: string;
}

export interface ActiveNetCentreDetail {
  id: number;
  name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  phone?: string;
  [k: string]: unknown;
}

/** One calendar's fetched slice: what filters said, and what events came back. */
export interface CalendarFetchResult {
  calendarId: number;
  calendarName?: string;
  centreIds: number[];
  centreNames: Record<number, string>;
  centreEvents: ActiveNetCentreEvents[];
  occurrenceCount: number;
  /** Non-fatal problems worth reporting rather than swallowing. */
  warnings: string[];
}

export interface TenantFetchResult {
  tenantKey: string;
  calendars: CalendarFetchResult[];
  /** Every centre id seen across the run, for the venue batch. */
  centreIds: number[];
  centreDetails: ActiveNetCentreDetail[];
  requestsUsed: number;
  warnings: string[];
  /** Top-level payload keys we did not recognise — the shape-drift canary. */
  unrecognisedKeys: string[];
}

// ── recognised-shape canary ─────────────────────────────────────────────────────────
// These endpoints are undocumented and unversioned. An unrecognised TOP-LEVEL body key
// means the vendor added something; that is a signal to re-verify the parser, not a
// crash. Collected and surfaced (health.ts routes it to a source_check_run) — never
// thrown, so a benign addition degrades to a warning instead of emptying a municipality.

const KNOWN_BODY_KEYS: Record<keyof typeof ENDPOINTS, string[]> = {
  calendars: ['calendars'],
  filters: [
    'center',
    'activity',
    'activity_category',
    'activity_sub_category',
    'activity_center',
    'facilities',
    'calendar_period',
    'event_types',
    'permit_center',
  ],
  events: ['center_events'],
  centerDetails: ['center_details'],
};

function unrecognisedBodyKeys(endpoint: keyof typeof ENDPOINTS, body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const known = new Set(KNOWN_BODY_KEYS[endpoint]);
  return Object.keys(body as Record<string, unknown>).filter((k) => !known.has(k));
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
 * One polite, credential-free request with the circuit-breaker policy applied.
 *  • 403 → PortalBlockedError immediately (never retry into a block).
 *  • 429 → PortalRateLimitedError immediately, carrying Retry-After for the scheduler.
 *  • 5xx → bounded exponential backoff (honouring a short Retry-After), then
 *          PortalUnavailableError.
 *  • other non-2xx → PortalProtocolError.
 */
async function request<TBody>(
  tenant: ActiveNetTenantConfig,
  endpoint: keyof typeof ENDPOINTS,
  url: URL,
  init: RequestInit & { headers?: Record<string, string> },
  opts: ClientOptions
): Promise<{ body: TBody; unrecognised: string[] }> {
  const sleep = opts.sleepImpl ?? defaultSleep;
  const attemptsAllowed = MAX_TRANSIENT_RETRIES + 1;
  let lastStatus = 0;

  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
    try {
      opts.budget.spend();
    } catch (err) {
      // Run-ending and, until now, completely silent: the cap is what stops a crawl dead,
      // so it has to be the loudest line in the log rather than an unexplained abort.
      // eslint-disable-next-line no-console
      console.warn(
        `${CLIENT_LOG} ${tenant.tenantKey} ${endpoint} request budget exhausted at ${opts.budget.cap} — aborting run`
      );
      throw err;
    }
    // One label per attempt, carrying everything needed to read a slow run: which tenant,
    // which endpoint, which attempt, and how much of the tenant's hard cap is spent.
    const label = `${tenant.tenantKey} ${endpoint} attempt ${attempt + 1}/${attemptsAllowed} req ${opts.budget.spent}/${opts.budget.cap}`;
    // eslint-disable-next-line no-console
    console.log(`${CLIENT_LOG} ${label} start ${url.pathname}`);

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await politeFetch(policyKeyFor(tenant), url, init, {
        family: ADAPTER_FAMILY,
        fetchImpl: opts.fetchImpl,
        sleepImpl: opts.sleepImpl,
      });
    } catch (err) {
      // politeFetch threw instead of answering: a blown per-request deadline (H4) or an
      // already-armed crawl backoff. Both previously left this layer silent, which is
      // exactly how a run that stopped making progress looked identical to one that never
      // started. The elapsed time is the tell — ~32s means the deadline burned.
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
      throw new PortalBlockedError(tenant.tenantKey, url.pathname);
    }
    if (res.status === 429) {
      const retryAfterSeconds = parseRetryAfter(res);
      // eslint-disable-next-line no-console
      console.warn(
        `${CLIENT_LOG} ${label} 429 rate-limited (retry-after ${retryAfterSeconds ?? 'unset'}) — circuit-breaking the run`
      );
      throw new PortalRateLimitedError(tenant.tenantKey, url.pathname, retryAfterSeconds);
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
        break; // too long to hold a run open
      }
      // The single most useful line for reading a multi-minute run: how much of it was
      // this module deliberately sleeping, and why.
      // eslint-disable-next-line no-console
      console.warn(`${CLIENT_LOG} ${label} HTTP ${res.status} transient — retrying in ${backoff}ms`);
      await sleep(backoff);
      continue;
    }
    if (!res.ok) {
      throw new PortalProtocolError(tenant.tenantKey, `HTTP ${res.status} at ${url.pathname}`);
    }

    let envelope: ActiveNetEnvelope<TBody>;
    try {
      envelope = (await res.json()) as ActiveNetEnvelope<TBody>;
    } catch {
      throw new PortalProtocolError(tenant.tenantKey, `non-JSON response at ${url.pathname}`);
    }
    const code = envelope.headers?.response_code;
    if (code != null && code !== '0000') {
      throw new PortalProtocolError(
        tenant.tenantKey,
        `response_code ${code} (${envelope.headers?.response_message ?? 'no message'}) at ${url.pathname}`
      );
    }
    if (envelope.body == null) {
      throw new PortalProtocolError(tenant.tenantKey, `empty body at ${url.pathname}`);
    }
    return { body: envelope.body, unrecognised: unrecognisedBodyKeys(endpoint, envelope.body) };
  }

  throw new PortalUnavailableError(tenant.tenantKey, url.pathname, lastStatus);
}

function endpointUrl(
  tenant: ActiveNetTenantConfig,
  endpoint: keyof typeof ENDPOINTS,
  params: Record<string, string> = {}
): URL {
  const url = new URL(`${restBaseUrl(tenant)}${ENDPOINTS[endpoint]}`);
  url.searchParams.set('locale', LOCALE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

const JSON_POST_HEADERS = { accept: 'application/json', 'content-type': 'application/json' };
const JSON_GET_HEADERS = { accept: 'application/json' };

// ── endpoint wrappers ───────────────────────────────────────────────────────────────

export async function listCalendars(
  tenant: ActiveNetTenantConfig,
  opts: ClientOptions
): Promise<{ calendars: ActiveNetCalendar[]; unrecognised: string[] }> {
  const { body, unrecognised } = await request<{ calendars?: ActiveNetCalendar[] }>(
    tenant,
    'calendars',
    endpointUrl(tenant, 'calendars'),
    { headers: JSON_GET_HEADERS },
    opts
  );
  return { calendars: body.calendars ?? [], unrecognised };
}

export async function fetchCalendarCentres(
  tenant: ActiveNetTenantConfig,
  calendarId: number,
  opts: ClientOptions
): Promise<{ centres: ActiveNetCentreRef[]; unrecognised: string[] }> {
  const { body, unrecognised } = await request<{ center?: ActiveNetCentreRef[] }>(
    tenant,
    'filters',
    endpointUrl(tenant, 'filters'),
    { method: 'POST', headers: JSON_POST_HEADERS, body: JSON.stringify({ calendar_id: calendarId }) },
    opts
  );
  return { centres: body.center ?? [], unrecognised };
}

export interface EventWindow {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

export async function fetchCalendarEvents(
  tenant: ActiveNetTenantConfig,
  calendarId: number,
  centreIds: number[],
  window: EventWindow,
  opts: ClientOptions
): Promise<{ centreEvents: ActiveNetCentreEvents[]; unrecognised: string[] }> {
  const { body, unrecognised } = await request<{ center_events?: ActiveNetCentreEvents[] }>(
    tenant,
    'events',
    endpointUrl(tenant, 'events'),
    {
      method: 'POST',
      headers: JSON_POST_HEADERS,
      body: JSON.stringify({
        calendar_id: calendarId,
        center_ids: centreIds,
        // Sent for contract fidelity; MEASURED to be ignored by the server (header note 1).
        start_date: window.startDate,
        end_date: window.endDate,
        activity_ids: [],
        activity_category_ids: [],
        activity_sub_category_ids: [],
        age: null,
        time_after: '',
        time_before: '',
      }),
    },
    opts
  );
  return { centreEvents: body.center_events ?? [], unrecognised };
}

export async function fetchCentreDetails(
  tenant: ActiveNetTenantConfig,
  centreIds: number[],
  opts: ClientOptions
): Promise<{ details: ActiveNetCentreDetail[]; unrecognised: string[] }> {
  const details: ActiveNetCentreDetail[] = [];
  const unrecognised = new Set<string>();
  for (let i = 0; i < centreIds.length; i += CENTER_DETAILS_CHUNK) {
    const chunk = centreIds.slice(i, i + CENTER_DETAILS_CHUNK);
    const res = await request<{ center_details?: ActiveNetCentreDetail[] }>(
      tenant,
      'centerDetails',
      endpointUrl(tenant, 'centerDetails', { center_ids: chunk.join(',') }),
      { headers: JSON_GET_HEADERS },
      opts
    );
    details.push(...(res.body.center_details ?? []));
    res.unrecognised.forEach((k) => unrecognised.add(k));
  }
  return { details, unrecognised: [...unrecognised] };
}

// ── the run: calendars → filters → events → centerdetails ───────────────────────────

const CALENDAR_PLACEHOLDER_RE = /choose a calendar/i;

/**
 * Fetch one tenant's full drop-in slice. Pagination is by CALENDAR × CENTRE-SET, not by
 * date window (header note 1): one filters call + one events call per configured
 * calendar, then one batched centerdetails call. Request cost ≈ 2N + 2.
 *
 * A per-calendar failure is captured as a warning and the run continues — one calendar
 * breaking must not empty a municipality. A BLOCK / RATE-LIMIT / CAP failure aborts the
 * whole run (circuit breaker), because continuing would mean hammering a host that has
 * just told us to stop.
 */
export async function fetchTenant(
  tenant: ActiveNetTenantConfig,
  window: EventWindow,
  opts: ClientOptions
): Promise<TenantFetchResult> {
  const warnings: string[] = [];
  const unrecognised = new Set<string>();
  const calendars: CalendarFetchResult[] = [];
  const centreNames = new Map<number, string>();
  const runStartedAt = Date.now();

  // H6: the run's own progress line. A per-request log alone still can't answer "how far
  // through Vancouver's 23 calendars did the 9 minutes get us?" — this can.
  // eslint-disable-next-line no-console
  console.log(
    `${RUN_LOG} ${tenant.tenantKey} run start — ${tenant.dropInCalendarIds.length} calendar(s), ` +
      `cap ${opts.budget.cap} request(s), window ${window.startDate}..${window.endDate}`
  );

  const listed = await listCalendars(tenant, opts);
  listed.unrecognised.forEach((k) => unrecognised.add(`calendars.${k}`));

  // Drift canary: config pins the calendar set; the portal is asked every run.
  const livePortalIds = listed.calendars
    .filter((c) => !CALENDAR_PLACEHOLDER_RE.test(c.name ?? '') && !c.retired && !c.hide_on_internet)
    .map((c) => c.calendar_id);
  const added = livePortalIds.filter((id) => !tenant.dropInCalendarIds.includes(id));
  const removed = tenant.dropInCalendarIds.filter((id) => !livePortalIds.includes(id));
  if (added.length) warnings.push(`calendar drift: portal lists ${added.length} calendar(s) not in config: ${added.join(', ')}`);
  if (removed.length) warnings.push(`calendar drift: config lists ${removed.length} calendar(s) absent from the portal: ${removed.join(', ')}`);

  const nameById = new Map(listed.calendars.map((c) => [c.calendar_id, c.name]));

  const calendarCount = tenant.dropInCalendarIds.length;
  for (const [index, calendarId] of tenant.dropInCalendarIds.entries()) {
    const calendarStartedAt = Date.now();
    const result: CalendarFetchResult = {
      calendarId,
      calendarName: nameById.get(calendarId),
      centreIds: [],
      centreNames: {},
      centreEvents: [],
      occurrenceCount: 0,
      warnings: [],
    };
    try {
      const { centres, unrecognised: fu } = await fetchCalendarCentres(tenant, calendarId, opts);
      fu.forEach((k) => unrecognised.add(`filters.${k}`));
      result.centreIds = centres.map((c) => c.id).filter((n) => Number.isFinite(n));
      for (const c of centres) {
        centreNames.set(c.id, c.name);
        result.centreNames[c.id] = c.name;
      }

      if (result.centreIds.length === 0) {
        // A finding, not a rounding error: this calendar exists but has no centres.
        result.warnings.push('no centres configured — calendar yields zero occurrences');
      } else {
        const { centreEvents, unrecognised: eu } = await fetchCalendarEvents(
          tenant,
          calendarId,
          result.centreIds,
          window,
          opts
        );
        eu.forEach((k) => unrecognised.add(`events.${k}`));
        result.centreEvents = centreEvents;
        result.occurrenceCount = centreEvents.reduce((n, g) => n + (g.events?.length ?? 0), 0);
        for (const g of centreEvents) if (g.center_name) centreNames.set(g.center_id, g.center_name);
      }
    } catch (err) {
      // Circuit-break on signals that mean "stop touching this host".
      if (
        err instanceof PortalBlockedError ||
        err instanceof PortalRateLimitedError ||
        err instanceof RequestCapExceededError
      ) {
        throw err;
      }
      result.warnings.push(err instanceof Error ? err.message : String(err));
      warnings.push(`calendar ${calendarId}: ${result.warnings[result.warnings.length - 1]}`);
    }
    // eslint-disable-next-line no-console
    console.log(
      `${RUN_LOG} ${tenant.tenantKey} calendar ${calendarId} (${index + 1}/${calendarCount}) — ` +
        `${result.centreIds.length} centre(s), ${result.occurrenceCount} occurrence(s), ` +
        `${result.warnings.length} warning(s) in ${Date.now() - calendarStartedAt}ms, ` +
        `req ${opts.budget.spent}/${opts.budget.cap}`
    );
    calendars.push(result);
  }

  const centreIds = [...centreNames.keys()].sort((a, b) => a - b);
  let centreDetails: ActiveNetCentreDetail[] = [];
  if (centreIds.length > 0) {
    try {
      const res = await fetchCentreDetails(tenant, centreIds, opts);
      centreDetails = res.details;
      res.unrecognised.forEach((k) => unrecognised.add(`centerDetails.${k}`));
    } catch (err) {
      if (
        err instanceof PortalBlockedError ||
        err instanceof PortalRateLimitedError ||
        err instanceof RequestCapExceededError
      ) {
        throw err;
      }
      warnings.push(`centerdetails: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const occurrences = calendars.reduce((n, c) => n + c.occurrenceCount, 0);
  // eslint-disable-next-line no-console
  console.log(
    `${RUN_LOG} ${tenant.tenantKey} run complete — ${calendars.length} calendar(s), ` +
      `${centreIds.length} centre(s), ${occurrences} occurrence(s), ` +
      `${opts.budget.spent}/${opts.budget.cap} request(s), ${warnings.length} warning(s) ` +
      `in ${Math.round((Date.now() - runStartedAt) / 1000)}s`
  );

  return {
    tenantKey: tenant.tenantKey,
    calendars,
    centreIds,
    centreDetails,
    requestsUsed: opts.budget.spent,
    warnings,
    unrecognisedKeys: [...unrecognised],
  };
}
