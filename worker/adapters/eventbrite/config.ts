// worker/adapters/eventbrite/config.ts — G-T10-2: organizer-scoped Eventbrite /
// partner feed config (TSD §5 row 10, §5.1 Adapter C, family `eventbrite_organizer`).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ACCEPTANCE CRITERION THIS FILE EXISTS TO MAKE STRUCTURAL (IR-03).
//
// Eventbrite may be read ONLY through feeds an organizer OWNS or has explicitly
// AUTHORISED us to read. A broad, anonymous, area-wide query ("every kids event
// within 25km of Vancouver") is forbidden — not merely unused, ABSENT. This file
// is the opt-in list: an organizer that is not written down here cannot be read,
// because the client has no way to name a target other than an entry below.
//
// Two facts make that guarantee cheap rather than aspirational, both verified
// against Eventbrite's own published API (2026-07-31, see docs/source-register.md):
//
//   1. Eventbrite RETIRED the anonymous area-wide search endpoint itself.
//      `GET /v3/events/search/` (the one that took `location.address` /
//      `location.within` / `location.latitude`) was removed from public access on
//      2019-12-12 and began returning errors for everyone on 2020-02-20. Their own
//      migration note points callers at exactly the organizer-scoped replacement
//      this adapter uses. So the forbidden path is not merely un-coded here — it no
//      longer exists to code. It is STILL banned structurally (client.ts +
//      tests/compliance/eventbrite-organizer-scope.test.ts), because "the vendor
//      turned it off" is a fact about today's vendor, not a guarantee about our code.
//
//   2. The permitted endpoint is organizer-scoped BY CONSTRUCTION:
//      `GET /v3/organizations/{organization_id}/events/` can only ever return the
//      events of the one organization named in its PATH. There is no location or
//      free-text parameter to widen it with. Scope is a path segment, not a filter
//      we promise not to set.
//
// ─────────────────────────────────────────────────────────────────────────────
// HONEST ZERO — READ THIS BEFORE ADDING AN ENTRY.
//
// `EVENTBRITE_ORGANIZERS` is EMPTY, and that is the correct, measured state, not an
// unfinished stub. Eventbrite's API has no anonymous read path: every organizer-scoped
// call needs either (a) an OAuth app plus that organizer's explicit authorisation, or
// (b) a private token the organizer hands over. KIDS FUN holds neither — checked
// 2026-07-31 against the project credential store, which contains no Eventbrite
// connector of any kind. `supabase/seeds/sources.sql` and docs/source-register.md §6
// have both said "partner-required — none configured" since the source register was
// written, and nothing has changed that.
//
// So this adapter ships BUILT, TESTED and PROVABLY ORGANIZER-SCOPED, with zero live
// feeds — the same honest outcome as Richmond under T8 and West Vancouver under T7,
// where a real adapter correctly stays off because the data (there) or the
// authorisation (here) genuinely is not available. A fabricated organizer id would
// make this file look finished and prove nothing; it is deliberately absent.
//
// Getting a real one is a BUSINESS step, not an engineering one: either a partner
// organizer authorises KIDS FUN directly, or Eventbrite's distribution-partner
// programme approves the project. Neither is an agent's decision.
//
// TO ADD AN AUTHORISED ORGANIZER (data only — no new code):
//   1. Record the authorisation (who authorised, when, in what form) in
//      docs/source-register.md, alongside the ToS/robots decision.
//   2. Add a `source` row: family `eventbrite_organizer`, authority_tier `partner`.
//   3. Add an entry below with that organizer's numeric `organizationId`.
//   4. Store the organizer's token in the env var named by `tokenEnvVar` (never in
//      this file, never in a URL, never in a log line).
//   5. Enable at runtime with KIDS_FUN_LIVE_EVENTBRITE=<organizerKey> — and only once
//      the DB terms/robots gate for that source row is `allowed`.
// ─────────────────────────────────────────────────────────────────────────────

/** Eventbrite API v3 host. EXACT — the only host this family may ever reach. */
export const EVENTBRITE_API_HOST = 'www.eventbriteapi.com';

/** API version segment. Kept separate from the path template so a version bump is visible. */
export const EVENTBRITE_API_VERSION = 'v3';

/**
 * The ONE endpoint shape this family may call, as a template. Organizer scope lives in
 * the `{organization_id}` PATH SEGMENT — it is not a filter that could be omitted or
 * widened. Anything else (notably the retired `/v3/events/search/`) is rejected by
 * assertOrganizerScopedUrl() in client.ts before a request is issued.
 */
export const ORGANIZATION_EVENTS_PATH_TEMPLATE = '/v3/organizations/{organization_id}/events/';

/** Env var holding an organizer's authorised token, derived from its key. Never a literal. */
export function organizerTokenEnvVar(organizerKey: string): string {
  return `KIDS_FUN_EVENTBRITE_TOKEN_${organizerKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export interface EventbriteOrganizerConfig {
  /** Stable local key: the value KIDS_FUN_LIVE_EVENTBRITE names, and the token env suffix. */
  organizerKey: string;
  /**
   * Eventbrite numeric organization id. This is the ENTIRE scope of what the connector
   * may read — it is interpolated into the request PATH, so a request can physically
   * not return another organizer's events.
   */
  organizationId: string;
  /** Human name of the organizer, for the source register and venue attribution. */
  organizerName: string;
  /** source.family in supabase/seeds/sources.sql. */
  sourceFamily: 'eventbrite_organizer';
  /** source.name in supabase/seeds/sources.sql (adapter-registry key). */
  sourceName: string;
  /** Municipality used for venue attribution when the payload's venue lacks one. */
  municipality: string;
  /** IANA zone for this organizer's listings (Eventbrite also returns an explicit
   *  per-event `start.timezone`, which wins when present). */
  timezone: string;
  /**
   * HOW this organizer authorised us, in one line, with a date. Evidence, not
   * aspiration — the partner scope is only real if it is recorded. Required, so an
   * entry cannot be added without stating who said yes.
   */
  authorisationNote: string;
  /**
   * Env var carrying the organizer's token. Defaults to organizerTokenEnvVar(key);
   * declared explicitly so the operator-facing name is visible in config.
   */
  tokenEnvVar: string;
  /**
   * Config-level "this organizer is authorised and ingestable". Runtime ADDITIONALLY
   * requires the KIDS_FUN_LIVE_EVENTBRITE allow-list, a present token, AND the DB
   * terms/robots gate — four independent gates, any one of which keeps it off.
   */
  enabled: boolean;
  /** Hard per-run cap on paginated requests (bounds the crawl footprint). */
  maxRequestsPerRun: number;
  /** Hard cap on events kept per run. */
  maxEventsPerRun: number;
}

/**
 * ZERO authorised organizers. See the "HONEST ZERO" block above before changing this —
 * an entry here is a statement that a named organizer has actually authorised KIDS FUN.
 *
 * tests/adapters/eventbrite.test.ts asserts this is empty and will fail loudly if an
 * entry appears without the accompanying source-register evidence, so adding one is a
 * deliberate, visible act rather than a quiet edit.
 */
export const EVENTBRITE_ORGANIZERS: EventbriteOrganizerConfig[] = [];

export function getEventbriteOrganizer(organizerKey: string): EventbriteOrganizerConfig | undefined {
  return EVENTBRITE_ORGANIZERS.find((o) => o.organizerKey === organizerKey);
}
