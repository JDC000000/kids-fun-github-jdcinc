// worker/adapters/eventbrite/client.ts — G-T10-2: the ONLY place this project may
// talk to Eventbrite, and the place the organizer-scoping guarantee is made
// structural rather than promised.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE GUARANTEE, AND HOW IT IS ENFORCED (IR-03 / TSD §5 row 10)
//
// "The connector only pulls configured organizer feeds; no anonymous area-query
// path exists." That is stated three independent ways, so no single edit can quietly
// undo it:
//
//   1. THERE IS NO URL PARAMETER.  Nothing outside this file can hand the client a
//      URL. The only entry point takes an EventbriteOrganizerConfig, and the URL is
//      assembled here from a hard-coded host + a hard-coded path template with the
//      organizer's id interpolated into a PATH SEGMENT. Scope is structural: the
//      endpoint physically cannot return another organizer's events.
//
//   2. THE QUERY STRING IS A CLOSED SET.  ALLOWED_QUERY_PARAMS is exhaustive. The
//      builder iterates the ALLOW-LIST, not the caller's object, so an unknown key is
//      not merely rejected — it is never read. Every area/geo/free-text parameter
//      Eventbrite's retired search endpoint accepted (`location.address`,
//      `location.within`, `location.latitude`, `location.longitude`,
//      `location.viewport.*`, `q`, `categories`, `within`) is outside that set and
//      therefore unreachable.
//
//   3. A RUNTIME TRIPWIRE ON THE FINAL URL.  assertOrganizerScopedUrl() throws unless the
//      host is EXACTLY EVENTBRITE_API_HOST, the path matches the organizer-scoped shape
//      exactly, and no forbidden or credential-shaped parameter is present. It is
//      production code, not a test: a future edit that reintroduced an area query would
//      fail closed at runtime, not just go red in CI.
//      It runs at BOTH call sites, deliberately, because they prove different things:
//      once inside buildOrganizationEventsUrl (fail fast at construction, precise error)
//      and again in fetchOrganizerEvents immediately before politeFetch — the second is
//      what makes the guarantee about what is SENT rather than what was BUILT. QA proved
//      the difference by appending a parameter to the url AFTER the builder returned.
//      Both call sites, and their ORDER relative to the fetch, are pinned structurally in
//      tests/compliance/eventbrite-organizer-scope.test.ts — deleting either one, or
//      moving the assert after the fetch, fails there.
//
// tests/compliance/eventbrite-organizer-scope.test.ts then proves all three
// behaviourally (spied fetch) AND structurally (this file is read from disk, its
// comments stripped, and the remaining CODE scanned for area-query fingerprints and
// for every bypass class tests/compliance/no-bypass.test.ts bans) — the same
// "provably absent, not merely unused" standard T7/T8 are held to.
//
// ─────────────────────────────────────────────────────────────────────────────
// ON THE Authorization HEADER — why this family is not in no-bypass's blanket scan.
//
// tests/compliance/no-bypass.test.ts bans the Authorization header outright for every
// adapter it lists, and rightly: those adapters read PUBLIC pages, so a credential
// there could only mean logging in as somebody to reach content we were not offered.
// This family is the opposite case by definition — an organizer-scoped partner feed is
// authorised access, and Eventbrite's API has NO anonymous read path at all, so a
// bearer token the organizer granted is the only way to honour the acceptance criterion
// rather than a way around one.
//
// That is a real narrowing, so it is handled the way T7/T8 handled theirs (a NAMED,
// documented exception, not a silent omission): this family is deliberately NOT added
// to no-bypass's ADAPTER_SOURCES, and its own compliance file re-runs EVERY prohibition
// from that scan — CAPTCHA, password credentials, Cookie, credentials:'include',
// headless navigation, checkout/cart, anti-forgery tokens, and all mutating methods
// INCLUDING POST — with Authorization as the single narrowed item, permitted only in
// this file and only as `Bearer <token-from-env>`. Coverage is therefore complete, and
// the one thing that moved is visible in both files.
//
// The token itself: it is read from an env var named by config, never written to a
// literal, never placed in a URL (asserted), and never logged. If it is absent the
// adapter is not live and issues zero requests.
// ─────────────────────────────────────────────────────────────────────────────
import { politeFetch } from '../../health/policy';
import {
  EVENTBRITE_API_HOST,
  ORGANIZATION_EVENTS_PATH_TEMPLATE,
  type EventbriteOrganizerConfig,
} from './config';

/**
 * The EXHAUSTIVE set of query parameters this client may send, with the value it is
 * allowed to carry. Deliberately tiny: every one of these narrows or orders an
 * ALREADY organizer-scoped result set. None of them can widen it.
 *
 * `time_filter=current_future` is how the forward window is expressed — Eventbrite
 * answers with upcoming events only, so no client-side date arithmetic (and therefore
 * no worker/core/time.ts conversion) is needed here. Unlike the ActiveNet/BookMe4
 * portals, Eventbrite returns an explicit UTC instant per event (`start.utc`) plus the
 * event's own IANA zone, so there is no offset-less local wall-clock to resolve. Using
 * time.ts here would be inventing a conversion the payload does not require.
 */
export const ALLOWED_QUERY_PARAMS = {
  /** Only published, live listings. Never draft/cancelled. */
  status: 'live',
  /** Soonest first, so a per-run cap keeps the most useful events. */
  order_by: 'start_asc',
  /** Upcoming only. The forward window, expressed by the API rather than by us. */
  time_filter: 'current_future',
  /** Inline the venue + price so a listing needs no follow-up per-event request. */
  expand: 'venue,ticket_availability',
  /** Page size. Eventbrite's maximum is 50. */
  page_size: '50',
} as const;

/**
 * Any parameter under this prefix is a geographic area query by construction — the
 * defining shape of what IR-03 forbids.
 *
 * QA F4 — "this guard is redundant; removing it is behaviourally invisible." Correct
 * TODAY, and it is KEPT anyway, deliberately. It is redundant only while
 * ALLOWED_QUERY_PARAMS stays closed and small; the moment someone adds a legitimate
 * parameter to that set (a future vendor filter, a pagination tweak), the allow-list stops
 * being a blanket "no" and this becomes the thing still standing between the adapter and
 * an area query. Deleting a guard because it is currently unreachable is how guards die
 * just before they are needed.
 *
 * What QA was right about is that "kept for a reason" must be checkable, not asserted. The
 * two rejections carry DIFFERENT error messages ("forbidden area-query parameter" vs "not
 * in the closed allow-list"), and the compliance suite pins location.* to the FORMER — so
 * the test proves this guard fires, not the allow-list standing in front of it.
 *
 * WHY THERE IS NO DENY-LIST OF SPECIFIC PARAMETER NAMES HERE. The obvious companion —
 * an array literal of every banned parameter (`location.address`, `q`, `within`,
 * `categories`, …) — is deliberately NOT in this file. It lives in
 * tests/compliance/eventbrite-organizer-scope.test.ts instead, for the same reason
 * no-bypass.test.ts declares its own allow-list rather than importing one: a tripwire
 * that reads its rules from the code it polices can be widened by editing that code
 * alone. It is also self-defeating here in a concrete way — the compliance scan reads
 * this file with comments stripped and fails on any area-query fingerprint in CODE, so
 * a deny-list ARRAY would be indistinguishable from the thing it bans. The allow-list is
 * the guarantee; the deny-list is the test's business.
 */
const FORBIDDEN_PARAM_PREFIX = 'location.';

/** The one path shape permitted: an organizer-scoped event list, nothing else. */
const ORGANIZATION_EVENTS_PATH_RE = /^\/v3\/organizations\/[A-Za-z0-9_-]+\/events\/$/;

/** Continuation cursor param — pagination WITHIN one organizer's result set. */
const CONTINUATION_PARAM = 'continuation';

export class OrganizerScopeViolationError extends Error {
  constructor(
    message: string,
    readonly url: string
  ) {
    super(`${message} — ${url}`);
    this.name = 'OrganizerScopeViolationError';
  }
}

/** Raised when a run would exceed its configured request cap. */
export class EventbriteRequestCapExceededError extends Error {
  constructor(readonly cap: number) {
    super(`Eventbrite request budget exhausted at ${cap} — aborting run`);
    this.name = 'EventbriteRequestCapExceededError';
  }
}

/**
 * The runtime tripwire. Throws unless `url` is an organizer-scoped Eventbrite event
 * list carrying only allow-listed parameters.
 *
 * Exported so the compliance suite can drive it directly against adversarial inputs
 * (the retired search endpoint, a look-alike host, a smuggled `location.*` parameter)
 * rather than only observing it via a happy-path fetch.
 */
export function assertOrganizerScopedUrl(url: URL, expectedOrganizationId?: string): void {
  const raw = url.toString();
  if (url.protocol !== 'https:') {
    throw new OrganizerScopeViolationError('Eventbrite requests must be https', raw);
  }
  // EXACT hostname, never endsWith — `www.eventbriteapi.com.attacker.example` is not it.
  if (url.hostname !== EVENTBRITE_API_HOST) {
    throw new OrganizerScopeViolationError(
      `host is not the Eventbrite API host (${EVENTBRITE_API_HOST})`,
      raw
    );
  }
  if (!ORGANIZATION_EVENTS_PATH_RE.test(url.pathname)) {
    throw new OrganizerScopeViolationError(
      'path is not the organizer-scoped event list /v3/organizations/{id}/events/',
      raw
    );
  }
  if (expectedOrganizationId != null) {
    const idInPath = url.pathname.split('/')[3];
    if (idInPath !== expectedOrganizationId) {
      throw new OrganizerScopeViolationError(
        `path organization id ${idInPath} is not the configured organizer ${expectedOrganizationId}`,
        raw
      );
    }
  }
  const permitted = new Set<string>([...Object.keys(ALLOWED_QUERY_PARAMS), CONTINUATION_PARAM]);
  for (const name of url.searchParams.keys()) {
    if (name.startsWith(FORBIDDEN_PARAM_PREFIX)) {
      throw new OrganizerScopeViolationError(`forbidden area-query parameter "${name}"`, raw);
    }
    // A credential must never be smuggled into the URL (Eventbrite historically accepted
    // `?token=`; banned here so it can never land in a log, a Referer or an error string).
    //
    // QA F2 FIX — matched on the parameter NAME, never on the raw query string. The first
    // version tested /token|auth|key=/ against url.search, which also sees VALUES: an
    // opaque Eventbrite continuation cursor that merely CONTAINS "auth" or "token" as a
    // substring ("abcAUTHxyz", "tokenish123") threw and aborted an otherwise legitimate
    // run. Failing closed and loud was the right direction, but on the wrong signal —
    // we control parameter names, we do not control the vendor's cursor alphabet.
    //
    // Deliberately NARROW (token/auth only). The closed allow-list below is the actual
    // guarantee — it already refuses every parameter not named in ALLOWED_QUERY_PARAMS,
    // so this branch exists to give the credential case a PRECISE error rather than to
    // add coverage. Listing more credential words here would buy nothing and would itself
    // trip the family's bypass scan, which bans those literals in code for good reason.
    if (/token|auth/i.test(name)) {
      throw new OrganizerScopeViolationError(`credential-shaped query parameter "${name}"`, raw);
    }
    if (!permitted.has(name)) {
      throw new OrganizerScopeViolationError(`parameter "${name}" is not in the closed allow-list`, raw);
    }
  }
}

/**
 * Build the organizer-scoped events URL. The organizer id goes in the PATH; the query
 * string is assembled by iterating the ALLOW-LIST (never a caller-supplied object), so
 * an unexpected parameter has no route in.
 */
export function buildOrganizationEventsUrl(organizationId: string, continuation?: string): URL {
  if (!/^[A-Za-z0-9_-]+$/.test(organizationId)) {
    throw new OrganizerScopeViolationError(
      'organizationId must be a plain id (no path or query characters)',
      organizationId
    );
  }
  const path = ORGANIZATION_EVENTS_PATH_TEMPLATE.replace('{organization_id}', organizationId);
  const url = new URL(`https://${EVENTBRITE_API_HOST}${path}`);
  for (const [name, value] of Object.entries(ALLOWED_QUERY_PARAMS)) {
    url.searchParams.set(name, value);
  }
  if (continuation) url.searchParams.set(CONTINUATION_PARAM, continuation);
  assertOrganizerScopedUrl(url, organizationId);
  return url;
}

// ── Eventbrite API v3 payload shape (public documentation, 2026-07-31) ───────────
//
// PROVENANCE, stated plainly: these types are transcribed from Eventbrite's PUBLISHED
// API documentation. They have NOT been verified against a live response, because no
// organizer has authorised this project and therefore no live call has ever been made
// (see config.ts "HONEST ZERO"). The fixture in __fixtures__/ mirrors the documented
// shape and is what the tests exercise. Re-verify against a real response the first
// time an organizer is onboarded — do not assume these are field-accurate until then.

export interface EventbriteMultipartText {
  text?: string | null;
  html?: string | null;
}

export interface EventbriteVenue {
  id?: string;
  name?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  address?: {
    address_1?: string | null;
    address_2?: string | null;
    city?: string | null;
    region?: string | null;
    postal_code?: string | null;
    localized_address_display?: string | null;
  } | null;
}

export interface EventbriteTicketAvailability {
  is_free?: boolean;
  minimum_ticket_price?: { currency?: string; major_value?: string; value?: number } | null;
  maximum_ticket_price?: { currency?: string; major_value?: string; value?: number } | null;
}

export interface EventbriteEvent {
  id: string;
  name?: EventbriteMultipartText | null;
  summary?: string | null;
  description?: EventbriteMultipartText | null;
  url?: string | null;
  /** Explicit UTC instant + the event's own IANA zone — no local-time inference needed. */
  start?: { timezone?: string | null; local?: string | null; utc?: string | null } | null;
  end?: { timezone?: string | null; local?: string | null; utc?: string | null } | null;
  status?: string | null; // 'live' | 'started' | 'ended' | 'completed' | 'canceled' | 'draft'
  is_free?: boolean | null;
  online_event?: boolean | null;
  venue_id?: string | null;
  venue?: EventbriteVenue | null;
  organization_id?: string | null;
  ticket_availability?: EventbriteTicketAvailability | null;
}

export interface EventbritePagination {
  object_count?: number;
  page_number?: number;
  page_size?: number;
  page_count?: number;
  continuation?: string | null;
  has_more_items?: boolean;
}

export interface EventbriteEventsResponse {
  pagination?: EventbritePagination | null;
  events?: EventbriteEvent[] | null;
}

export interface FetchOrganizerEventsResult {
  events: EventbriteEvent[];
  requestsUsed: number;
  /** Non-fatal notes for the check-run/health board (e.g. a truncated page walk). */
  warnings: string[];
}

/**
 * Read ONE configured organizer's upcoming events, following Eventbrite's continuation
 * cursor within that organizer's own result set.
 *
 * `token` is the organizer's authorised credential. It is sent only as an Authorization
 * bearer header — never in the URL, never logged, never included in an error message
 * (the errors below quote the URL, which by construction contains no credential).
 *
 * There is exactly ONE fetch call site in this file, and the URL it receives has already
 * passed assertOrganizerScopedUrl().
 */
export async function fetchOrganizerEvents(
  config: EventbriteOrganizerConfig,
  token: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<FetchOrganizerEventsResult> {
  const policyKey = `eventbrite_organizer::${config.organizerKey}`;
  const events: EventbriteEvent[] = [];
  const warnings: string[] = [];
  let requestsUsed = 0;
  let continuation: string | undefined;

  for (;;) {
    if (requestsUsed >= config.maxRequestsPerRun) {
      // Loud, not silent: a truncated walk that reports success is exactly the
      // "green over an empty municipality" failure T7/T8 were bitten by.
      throw new EventbriteRequestCapExceededError(config.maxRequestsPerRun);
    }
    const url = buildOrganizationEventsUrl(config.organizationId, continuation);
    // QA F1 FIX — assert on the FINAL url, HERE, immediately before the request.
    //
    // The builder asserts too (fail fast at construction, with a precise error), and that
    // is kept. But an assertion inside the builder only proves what was BUILT, not what is
    // SENT: QA's defeat attempt appended `access_token` to the url AFTER the build
    // returned, and the tripwire never saw it — only the behavioural test caught it. The
    // file header claimed this check ran "immediately before the single fetch call site";
    // it did not, and rather than soften the comment to match weaker code, the code now
    // does what the comment always said. Two asserts, deliberately, because they prove
    // different things — and the call site itself is pinned structurally in
    // tests/compliance/eventbrite-organizer-scope.test.ts so DELETING this line fails.
    assertOrganizerScopedUrl(url, config.organizationId);

    const response = await politeFetch(
      policyKey,
      url,
      {
        headers: {
          accept: 'application/json',
          // The organizer's own authorisation. See this file's header for why this one
          // prohibition is narrowed for this family, and where that is enforced.
          Authorization: `Bearer ${token}`,
        },
      },
      { family: 'eventbrite_organizer', fetchImpl: opts.fetchImpl }
    );
    requestsUsed += 1;

    if (!response.ok) {
      throw new Error(
        `Eventbrite organizer feed fetch failed for ${config.organizerKey}: ${response.status} ${response.statusText}`
      );
    }

    const body = (await response.json()) as EventbriteEventsResponse;
    const page = Array.isArray(body?.events) ? body.events : [];
    events.push(...page);

    if (events.length >= config.maxEventsPerRun) {
      if (body?.pagination?.has_more_items) {
        warnings.push(
          `per-run event cap (${config.maxEventsPerRun}) reached for ${config.organizerKey}; more pages were available`
        );
      }
      break;
    }

    const next = body?.pagination?.has_more_items ? (body.pagination?.continuation ?? null) : null;
    if (!next) break;
    // A vendor that reports has_more_items forever would otherwise loop until the cap;
    // an unchanged cursor is a shape drift, so stop and say so rather than spin.
    if (next === continuation) {
      warnings.push(`continuation cursor did not advance for ${config.organizerKey}; stopping page walk`);
      break;
    }
    continuation = next;
  }

  return { events: events.slice(0, config.maxEventsPerRun), requestsUsed, warnings };
}
