// worker/adapters/library/index.ts — G-T9-1/2: Library adapter scaffold
// (TSD §5.1 Adapter B, PRD §8 fam 7). Family 'library'; the extract() parser is
// selected per-system by platform (BiblioCommons, Communico, or generic_rss), the
// Communico parser doubling as the generic per-system feed fallback.
//
// The generic_rss handler (NVDPL, D-12) lives in ./generic-rss.ts rather than here:
// its feed carries no structured fields at all, so it needs a free-text date parser,
// a venue resolver and a kid-relevance classifier that the other two platforms don't.
//
// Default mode remains fixture-only. Richmond Public Library / BiblioCommons can
// be explicitly live-enabled with KIDS_FUN_LIVE_LIBRARY_SYSTEMS=rpl after D-6
// approval; the live path uses the public BiblioCommons gateway events endpoint,
// one paginated request, no login, no headless browser, no CAPTCHA bypass.
import type { Adapter, StructuredRecord, DedupKey } from '../../core/adapter';
// The union-of-tags resolver for a source's own audience taxonomy. Imported rather than
// re-implemented for the same reason the eventbrite adapter imports extractAgeWording: the rule
// for reading a structured tag list is a property of the age model, not of this feed.
import { parseAudienceLabels } from '../../core/age';
import { politeFetch } from '../../health/policy';
import { VENUE_GEO_AUTHORITY } from '../../core/venue-geo-authority';
// Shared, DST-correct local-wall-clock -> UTC conversion. BiblioCommons publishes
// offset-less local timestamps, and so does ActiveNet — one implementation, in
// worker/core/time.ts, rather than a second copy of a DST rule that can rot.
import { zonedLocalToUtcIso } from '../../core/time';
import { LIBRARY_SYSTEMS, getLibrarySystem, type LibraryBranchLocation, type LibrarySystemConfig } from './config';
// Dependency-free XML/HTML text helpers, shared with the generic_rss handler rather
// than duplicated (see ./rss-text.ts header).
import { decodeXmlText, finiteFloat, firstTag, stripHtml, tagBlocks } from './rss-text';
import {
  GENERIC_RSS_FIXTURE_XML,
  ageHaystack,
  anchoredBareAgeWording,
  assessGenericRssRun,
  parseGenericRss,
  type GenericRssEvent,
  type GenericRssParseDiagnostics,
} from './generic-rss';
// The family-wide run-health vocabulary, shared with the generic_rss handler rather than
// re-stated here: same tally fields, same tally line, same empty-feed/collapse/truncation
// verdicts. See ./run-health.ts for why it was extracted.
import {
  assessLibraryFeedRun,
  formatFeedTally,
  type LibraryFeedTally,
  type LibraryHealthVerdict,
} from './run-health';

/** BiblioCommons/BiblioEvents-shaped event after normalisation from gateway JSON. */
interface BiblioEvent {
  id: string;
  title: string;
  branch: string;
  startsAt: string;
  endsAt?: string;
  /**
   * Free-text age WORDING, when the description carried some. Optional: an item whose prose
   * says nothing about age now carries nothing, rather than the old `'See event details'`
   * placeholder — that string parsed as "wording present but unresolvable", which downgrades
   * `parse_quality.ageResolved` from null (0.6, no claim made) to false (0.4, we tried and
   * failed) for every silent item. Silence is not a failed parse.
   */
  ages?: string;
  /** BiblioCommons' own audience tags for this item — see StructuredRecord.ageAudienceLabels. */
  audienceLabels?: string[];
  url: string;
  registrationRequired: boolean;
  /**
   * WHERE `registrationRequired` came from — recorded at the point it is derived rather than
   * re-inferred downstream, for the same reason `LibraryBranchLocation.coordsFrom` exists:
   * once the boolean is in hand there is no way left to tell a structured vendor flag from a
   * regex over prose, and they are not the same claim.
   *
   *   'registration-info'  — the block was PRESENT and carried real BOOKING evidence (an
   *                          enabled method, a login requirement, or the affirmative absence
   *                          of both). Authoritative in BOTH directions: this IS the
   *                          library's own booking system, so a present-and-genuinely-empty
   *                          block means turn up.
   *   'capacity-only'      — the block was present but said NOTHING about booking: only
   *                          `maxSeats`/`cap`, which is how many people the room holds. No
   *                          evidence in either direction.
   *   'description-prose'  — /registration required/i over the RSS description. Authoritative
   *                          only when it MATCHES. A miss means the prose did not mention it,
   *                          which is silence, not a drop-in claim.
   *   'absent'             — the gateway event carried NO registrationInfo block at all. No
   *                          evidence in either direction.
   *
   * ADDED 'absent' 2026-08-02 (QA round 139, F5) to close a real tri-state contract
   * violation. `registrationInfo` is optional on the vendor type, and with the block missing
   * the derivation computed `Boolean(undefined || undefined)` = `false` while this field was
   * hardcoded to 'registration-info' — so silence was published as an AUTHORITATIVE drop-in
   * claim. That pinned the row into the default view AND disabled the title heuristic for it,
   * which is the precise failure the tri-state contract in ../../core/adapter.ts exists to
   * prevent, in the one direction nothing was watching. Distinguishing absent from
   * present-but-empty is what makes both honest: the second is a real fact, the first is not.
   */
  registrationSignal: 'registration-info' | 'description-prose' | 'capacity-only' | 'absent';
  descriptionText?: string;
  categoryHint?: string;
  location?: LibraryBranchLocation;
}

/** Communico/Libnet-shaped event. */
interface CommunicoEvent {
  eventId: string;
  name: string;
  location: string;
  start: string;
  end: string;
  audience: string;
  detailUrl: string;
}

interface BiblioCommonsGatewayResponse {
  events?: { items?: string[] };
  entities?: {
    events?: Record<string, BiblioCommonsGatewayEvent>;
    locations?: Record<string, { name?: string }>;
    eventAudiences?: Record<string, { name?: string }>;
    eventTypes?: Record<string, { name?: string }>;
  };
}

interface BiblioCommonsGatewayEvent {
  id: string;
  definition?: {
    start?: string;
    end?: string;
    title?: string;
    description?: string;
    branchLocationId?: string | null;
    audienceIds?: string[];
    typeIds?: string[];
    registrationInfo?: {
      enabledMethods?: string[];
      loginToRegister?: boolean;
      maxSeats?: number | null;
      cap?: number | null;
    };
    isCancelled?: boolean;
  };
}

const DEFAULT_BIBLIOCOMMONS_LIMIT = 20;

/**
 * The cap a BiblioCommons parse ACTUALLY applies — the config value, or the platform default
 * when a system omits it.
 *
 * One function rather than a repeated `?? DEFAULT_BIBLIOCOMMONS_LIMIT` because the parser and
 * the tally line MUST agree on it: a tally line quoting `system.liveEventsLimit` would print
 * `undefined` for any system relying on the default, while the parse it describes had silently
 * used 20.
 */
function biblioCommonsLimit(system: LibrarySystemConfig): number {
  return system.liveEventsLimit ?? DEFAULT_BIBLIOCOMMONS_LIMIT;
}

/** Stable per-source politeness key (rate-limit + backoff state) for a library system. */
function libraryPolicyKey(system: LibrarySystemConfig): string {
  return `${system.sourceFamily}::${system.systemKey}`;
}

function liveEnabledFor(systemKey: string): boolean {
  const raw = process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(systemKey.toLowerCase());
}

function categoryHint(title: string, typeNames: string[] = []): string | undefined {
  const t = `${title} ${typeNames.join(' ')}`.toLowerCase();
  if (/story\s*time|babytime|toddler/.test(t)) return 'storytime';
  if (/duplo|lego|free play|play/.test(t)) return 'indoor_play';
  if (/workshop|club|class|robot|steam|craft/.test(t)) return 'class_program';
  return 'class_program';
}

/**
 * The gateway's registration verdict AND its provenance, derived TOGETHER in one place.
 *
 * COMPUTED AS A PAIR DELIBERATELY, and this is the root-cause fix rather than a third patch.
 * The boolean and the provenance label used to be produced at two separate sites — the
 * derivation function here and a ternary at the map site — and they fell out of sync TWICE,
 * in opposite directions, each time publishing an over-claim:
 *   • QA F5   — block ABSENT: boolean was `false` but provenance said 'registration-info',
 *               so silence was published as an authoritative DROP-IN claim.
 *   • QA F-16 — block present with ONLY a seat cap: after narrowing the boolean to
 *               `loginToRegister || enabledMethods`, it became `false` while provenance
 *               still said 'registration-info' — flipping a row that used to be (correctly)
 *               treated as registration-shaped into an authoritative DROP-IN claim instead.
 *               Strictly worse than the original breadth, because it also DISABLES the title
 *               heuristic for that row. My narrowing moved the error from one pole to the
 *               other rather than to the middle.
 * Returning both from one rule makes that whole class of divergence unrepresentable.
 *
 * THE THREE-WAY TABLE. The middle row is the one both bugs above were missing:
 *   loginToRegister OR enabledMethods.length > 0   → TRUE      the vendor says you must book
 *   block present, neither, and no cap/maxSeats    → FALSE     a genuine drop-in claim
 *   block present, ONLY cap/maxSeats               → UNDEFINED a room size is not a booking fact
 *   block absent entirely                          → UNDEFINED silence
 *
 * The two UNDEFINED rows fall through to the unchanged, conservative title heuristic in
 * lib/search/filters/registration.ts — which is exactly what the tri-state contract in
 * ../../core/adapter.ts is for. `maxSeats`/`cap` genuinely say nothing about booking in
 * EITHER direction: nearly every walk-in library storytime has a room capacity, and so does
 * every registered course.
 */
export function gatewayRegistrationVerdict(event: BiblioCommonsGatewayEvent): {
  registrationRequired: boolean;
  registrationSignal: BiblioEvent['registrationSignal'];
} {
  const info = event.definition?.registrationInfo;
  if (!info) return { registrationRequired: false, registrationSignal: 'absent' };

  const mustBook = Boolean(info.loginToRegister || (info.enabledMethods && info.enabledMethods.length > 0));
  if (mustBook) return { registrationRequired: true, registrationSignal: 'registration-info' };

  // No booking evidence. A seat cap alone is a capacity statement, not a booking one, so it
  // cannot support the affirmative "turn up" claim a `false` would publish.
  const capacityOnly = info.maxSeats != null || info.cap != null;
  return {
    registrationRequired: false,
    registrationSignal: capacityOnly ? 'capacity-only' : 'registration-info',
  };
}

/**
 * What this event lets us honestly ASSERT about registration, for StructuredRecord.
 *
 * The boolean on BiblioEvent is not symmetric across the two feeds, and collapsing that
 * asymmetry is the one thing this function exists to prevent:
 *
 *   • `registration-info` (the JSON gateway) reads BiblioCommons' own structured
 *     registrationInfo block. A false there is the vendor saying no registration method is
 *     enabled on its own booking system — a real drop-in claim — so it passes through.
 *   • `description-prose` (the RSS feed) is /registration required/i over free text. A true
 *     is real evidence; a false only means the sentence was absent. Returning `false` for
 *     that would invent a drop-in assertion out of silence, which is exactly the failure
 *     mode ./adapter.ts's tri-state contract exists to make impossible. So a prose miss
 *     yields `undefined`.
 *
 * Note the existing `bookingUrl` encoding is left EXACTLY as it was. It has always
 * collapsed both feeds' booleans into one url-or-nothing and downstream consumers read it;
 * changing its meaning is a separate decision from persisting the fact alongside it.
 */
export function registrationAssertion(event: BiblioEvent): boolean | undefined {
  // Both "nothing was said" (F5) and "only a room size was said" (F-16) are NO EVIDENCE, and
  // neither may fall through to the boolean — which is `false` in both cases purely because
  // there was no booking fact to read, not because the source claimed drop-in.
  if (event.registrationSignal === 'absent' || event.registrationSignal === 'capacity-only') {
    return undefined;
  }
  if (event.registrationSignal === 'registration-info') return event.registrationRequired;
  return event.registrationRequired ? true : undefined;
}

function mapBiblioCommonsGateway(system: LibrarySystemConfig, body: BiblioCommonsGatewayResponse): BiblioEvent[] {
  const ids = body.events?.items ?? [];
  const events = body.entities?.events ?? {};
  const locations = body.entities?.locations ?? {};
  const audiences = body.entities?.eventAudiences ?? {};
  const types = body.entities?.eventTypes ?? {};

  return ids.flatMap((id) => {
    const event = events[id];
    const def = event?.definition;
    if (!event || !def || !def.title || !def.start || def.isCancelled) return [];
    const branch = def.branchLocationId ? locations[def.branchLocationId]?.name : undefined;
    const location = branch ? system.branchLocations?.[branch] : undefined;
    const audienceNames = (def.audienceIds ?? []).map((a) => audiences[a]?.name).filter(Boolean) as string[];
    const typeNames = (def.typeIds ?? []).map((t) => types[t]?.name).filter(Boolean) as string[];
    const descriptionText = stripHtml(def.description);
    const detailUrl = `${new URL(system.feedBaseUrl).origin}/v2/events/${event.id}`;

    return [
      {
        id: event.id,
        title: def.title,
        branch: branch ?? `${system.systemName} branch`,
        startsAt: zonedLocalToUtcIso(def.start) ?? def.start,
        endsAt: zonedLocalToUtcIso(def.end),
        // Same precedence as the RSS path, from the same helper. The gateway's mistake was the
        // mirror image of the RSS one: it CONCATENATED the audience names with a prose match
        // ("Toddlers, Preschool Age Children — children ages …") into a single phrase, which
        // hands the prose parser a string containing both claims and lets its keyword ordering,
        // not the source, decide which one is heard.
        ...resolveBiblioCommonsAgeSignal(def.title, descriptionText, audienceNames),
        url: detailUrl,
        // Both halves from ONE rule — see gatewayRegistrationVerdict for why they can no
        // longer be derived separately.
        ...gatewayRegistrationVerdict(event),
        descriptionText,
        categoryHint: categoryHint(def.title, typeNames),
        location,
      } as BiblioEvent,
    ];
  });
}

async function fetchBiblioCommonsEvents(system: LibrarySystemConfig): Promise<BiblioEvent[]> {
  if (!system.gatewayEventsUrl) {
    throw new Error(`No BiblioCommons gateway URL configured for ${system.systemKey}`);
  }
  const url = new URL(system.gatewayEventsUrl);
  url.searchParams.set('limit', String(system.liveEventsLimit ?? DEFAULT_BIBLIOCOMMONS_LIMIT));
  // Polite fetch seam (G-T15-5): identified UA + conditional headers + rate limit + backoff.
  const response = await politeFetch(
    libraryPolicyKey(system),
    url,
    { headers: { accept: 'application/json' } },
    { family: system.sourceFamily }
  );
  if (!response.ok) {
    throw new Error(`BiblioCommons events fetch failed: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as BiblioCommonsGatewayResponse;
  return mapBiblioCommonsGateway(system, body);
}

// --- BiblioCommons RSS/XML feed path (ToS-permitted automated-access mechanism) ---
// The feed is machine-generated and stable: CDATA-wrapped text nodes plus the
// BiblioCommons `bc:` namespace (start_date in UTC, structured location w/ geo).
// A small dependency-free extractor keeps the worker runtime at pg+puppeteer-core
// (no XML-parser dep, no lockfile churn) and matches the adapter's existing
// regex-based stripHtml style.

function toUtcIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function eventIdFromLink(link: string): string {
  const cleaned = link.split(/[?#]/)[0].replace(/\/$/, '');
  return cleaned.split('/').pop() || cleaned;
}

// Prefer an explicit numeric age/grade range (e.g. "ages 0-2", "grades K-3");
// fall back to a keyword audience hint. Raw wording only — normalizeHook/T13
// resolves it to structured age bands downstream.
const AGE_RANGE_RE = /(?:ages?|grades?)\s*[\dK][^.<\n]{0,40}/i;
const AGE_HINT_RE =
  /(?:children|kids|teens?|tweens?|youth|toddlers?|babies|baby|infants?|preschool(?:ers)?|kindergarten|family|all ages)[^.<\n]{0,40}/i;

/**
 * Which age signal this BiblioCommons item actually offers, in strength order.
 *
 * THE BUG THIS REPLACES, and why the ordering is the whole fix. Both feed paths used to reach
 * for the description's prose keyword BEFORE the item's own audience tags, so VPL's
 *
 *   tags: ["Storytimes", "Preschool Age Children", "Toddlers", "English"]
 *   desc: "A program for parents and caregivers with young children. …"
 *
 * resolved on the bare word "children" — which worker/core/age.ts's broad, deliberately-last
 * KEYWORD_BANDS entry reads as 60–144 months. Family Storytime, a programme the library
 * explicitly tags for toddlers and preschoolers, was published as "Ages 5–11" and filtered out
 * of every toddler search. Babytime survived only by accident: its description happens to say
 * "babies" before it says anything broader, so the first keyword hit was the right one. Same
 * feed, same parser, correct by luck on one row and wrong on the next — which is what a
 * precedence bug looks like from the outside.
 *
 * The library's own audience taxonomy is a deliberate, curated claim about who a programme is
 * for. A word appearing in a sentence about caregivers is not. The only thing allowed to
 * outrank the tags is the source stating ages OUTRIGHT ("Grades K-7", "ages 0-2"), which is
 * strictly more precise than any tag — and is why that check stays first rather than being
 * folded in.
 *
 * `audienceLabels` MUST ALREADY BE GENUINE AUDIENCE TAGS — this function does not vet them.
 * The RSS path gets there through `audienceTagsOf` (per-tenant allowlist); the JSON gateway
 * path is vetted by construction, since its names come from BiblioCommons' `eventAudiences`
 * entity map rather than from the flat `<category>` mixture.
 *
 * AN EARLIER VERSION OF THIS PASSED THE RAW `<category>` LIST STRAIGHT IN, on the reasoning
 * that non-age tags "resolve to nothing" so filtering would be a redundant second judgement.
 * That was measured false on Richmond: "Child Development" is a TOPIC tag that resolves to
 * 5-11 because it contains the word "child". True of Vancouver, whose audience tags are the
 * only child-shaped strings it publishes; not true in general, and generalising from one
 * tenant's vocabulary is what let it through. See `audienceTagsOf`.
 */
export function resolveBiblioCommonsAgeSignal(
  title: string,
  descriptionText: string,
  audienceLabels: string[]
): Pick<BiblioEvent, 'ages' | 'audienceLabels'> {
  // TITLE-BLINDNESS, fixed here (docs/age-pattern-extraction-scope.md §8d). The explicit
  // tier used to read the DESCRIPTION only, so an age stated outright in the title never
  // reached parseAgeText at all — and, worse, an audience TAG then won by default. Measured
  // on the live 2026-08-18 RPL feed, that cost two rows in twenty, one of them the wrong way
  // round on safety: "Richmond Reads: Summer Book Club 2026" says "Must be 18+ to enter" and
  // published [0, ∞) — every band, under-2 included — off the tag "All Ages".
  //
  // The anchored bare-range form (`must be 6-12 years old`, `Must be 18+`, `aged 4-8 years`)
  // is tried only AFTER AGE_RANGE_RE, so no record that already resolves can change winner;
  // and only the two EXPLICIT tiers see the title. AGE_HINT_RE below deliberately still
  // reads the description alone — see ageHaystack in ./generic-rss.ts for why a keyword in a
  // title is the one inference this codebase has already measured and thrown away.
  const hay = ageHaystack(title, descriptionText);
  const explicitRange = hay.match(AGE_RANGE_RE)?.[0]?.trim() ?? anchoredBareAgeWording(hay);
  if (explicitRange) return { ages: explicitRange };
  if (audienceLabels.length && parseAudienceLabels(audienceLabels).resolved) return { audienceLabels };
  const proseHint = descriptionText.match(AGE_HINT_RE)?.[0]?.trim();
  return proseHint ? { ages: proseHint } : {};
}

/**
 * The subset of a feed item's `<category>` values that are genuine AUDIENCE tags for this
 * tenant (LibrarySystemConfig.audienceTagPatterns).
 *
 * THIS FILTER IS THE FIX for a regression QA measured on live Richmond data: 4 of 50 sampled
 * items came out WIDER than before, because the raw category list was being handed to the age
 * normaliser wholesale. Richmond's topic tag "Child Development" contains "child", so the
 * normaliser's broad kids rule scored it 5-11, and because a tag list resolves to the UNION of
 * its tags that vote rode along on every item carrying it — publishing RPL's Babytime and
 * Play & Learn (both genuinely 0-24 months, both correctly tagged "Baby") as ALSO matching
 * 5-9 and 10-14. Under the previous first-match-wins ordering the topic tag could never win,
 * so the union is what gave it a voice it never had; the union is right, but only over tags
 * that are actually audiences.
 *
 * A system with NO patterns configured returns nothing, so its items fall back to the
 * description prose rather than trusting a vocabulary no one has checked. See the field's
 * comment in ./config.ts for why the safe default points that way.
 */
export function audienceTagsOf(system: LibrarySystemConfig, categories: string[]): string[] {
  const patterns = system.audienceTagPatterns;
  if (!patterns?.length) return [];
  return categories.filter((c) => patterns.some((re) => re.test(c.trim())));
}

/** Case/punctuation-insensitive key so a feed branch name matches a config key. */
function normalizeBranchKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Coordinate-authority declaration for a resolved library location. Returns an empty object
 * when there is no coordinate, so it spreads harmlessly into a StructuredRecord that has
 * none.
 *
 * `coordsFrom` is absent on a raw config entry (curated by definition) and set explicitly by
 * rssLocation() — so "absent means curated" is the same rule the config type documents, in
 * one place, rather than repeated at both call sites.
 */
function venueGeoDeclaration(
  location: LibraryBranchLocation | undefined,
  systemId: string
): Pick<StructuredRecord, 'venueGeoAuthority' | 'venueGeoSource'> {
  if (location?.lat === undefined || location?.lng === undefined) return {};
  const fromFeed = location.coordsFrom === 'feed';
  return {
    venueGeoAuthority: fromFeed
      ? VENUE_GEO_AUTHORITY.LIVE_VENDOR_PAYLOAD
      : VENUE_GEO_AUTHORITY.ADAPTER_CONFIG_LITERAL,
    venueGeoSource: fromFeed ? `${systemId}:feed-bc-location` : `${systemId}:branch-locations`,
  };
}

function rssLocation(system: LibrarySystemConfig, itemXml: string): LibraryBranchLocation | undefined {
  const [locBlock] = tagBlocks(itemXml, 'bc:location');
  if (!locBlock) return undefined;
  const name = firstTag(locBlock, 'bc:name');
  const number = firstTag(locBlock, 'bc:number');
  const street = firstTag(locBlock, 'bc:street');
  const city = firstTag(locBlock, 'bc:city');
  const state = firstTag(locBlock, 'bc:state') || 'BC';
  const zip = firstTag(locBlock, 'bc:zip');
  let lat = finiteFloat(firstTag(locBlock, 'bc:latitude'));
  let lng = finiteFloat(firstTag(locBlock, 'bc:longitude'));

  const streetLine = [number, street].filter(Boolean).join(' ');
  const feedAddress = [streetLine, city, [state, zip].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const feedDisplayArea = (name ?? '').replace(/\s+Branch$/i, '').trim() || (city ?? '');

  // Deterministic fallback: when the feed's bc:location block is incomplete (most
  // often a missing bc:latitude/longitude for an online / desk / virtual item),
  // fill the gaps from the curated branchLocations entry for that branch, matched
  // case/punctuation-insensitively on the branch name. Revives the intentionally
  // retained config fallback so a geo-less item still lands with coordinates,
  // address and municipality where we have them — never calling an external
  // geocoder.
  const fallback =
    name && system.branchLocations
      ? Object.entries(system.branchLocations).find(
          ([key]) => normalizeBranchKey(key) === normalizeBranchKey(name)
        )?.[1]
      : undefined;

  // Recorded rather than recomputed downstream: once `lat` has been reassigned there is no
  // way left to tell a feed coordinate from a curated one, and they are two different
  // authority tiers (10 vs 20).
  let coordsFrom: 'curated' | 'feed' | undefined =
    lat !== undefined && lng !== undefined ? 'feed' : undefined;
  if ((lat === undefined || lng === undefined) && fallback?.lat !== undefined && fallback?.lng !== undefined) {
    lat = fallback.lat;
    lng = fallback.lng;
    coordsFrom = 'curated';
  }

  const address = feedAddress || fallback?.address || (name ?? '');
  const municipalityName = city || fallback?.municipalityName || '';
  const displayArea = fallback?.displayArea || feedDisplayArea;

  // Keep the location as long as ANY provenance survives (name, address, or geo).
  // Previously a missing lat/lng dropped the whole block — losing the branch
  // address AND municipality (region filter) even when the feed carried them.
  if (!name && !feedAddress && lat === undefined) return undefined;

  return {
    address,
    lat,
    lng,
    coordsFrom,
    municipalityName,
    displayArea,
    locationUrl: address
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
      : '',
  };
}

/**
 * Per-run tallies for the BiblioCommons RSS feed — the family's only LIVE platform (VPL,
 * RPL), and until now the one throwing this away entirely.
 *
 * Same three universal fields as every other library feed (`LibraryFeedTally`), plus this
 * platform's own two skip buckets. The invariant the buckets exist to uphold — every item
 * the feed delivered lands in exactly ONE bucket, so they sum to `itemsInFeed` — is asserted
 * in tests/adapters/library-bibliocommons-truncation.test.ts, the same way the generic_rss
 * buckets are asserted in tests/adapters/library-nvdpl-rss.test.ts.
 *
 * There is deliberately NO kid-relevance bucket here: unlike NVDPL, this platform does no
 * audience filtering in the parser (it happens downstream), so inventing one would report a
 * filter that does not exist.
 */
export interface BiblioCommonsParseDiagnostics extends LibraryFeedTally {
  /** Skipped: `bc:is_cancelled` — the library withdrew the event. Not a defect. */
  cancelledItems: number;
  /** Skipped: no title, no link, or no parseable `bc:start_date` — structurally unusable. */
  malformedItems: number;
}

export interface BiblioCommonsParseResult {
  events: BiblioEvent[];
  diagnostics: BiblioCommonsParseDiagnostics;
}

export function parseBiblioCommonsRss(
  system: LibrarySystemConfig,
  xml: string
): BiblioCommonsParseResult {
  const items = tagBlocks(xml, 'item');
  const limit = biblioCommonsLimit(system);
  const events: BiblioEvent[] = [];
  const diagnostics: BiblioCommonsParseDiagnostics = {
    itemsInFeed: items.length,
    emitted: 0,
    cancelledItems: 0,
    malformedItems: 0,
    droppedByLimit: 0,
  };

  for (const item of items) {
    if ((firstTag(item, 'bc:is_cancelled') ?? '').toLowerCase() === 'true') {
      diagnostics.cancelledItems += 1;
      continue;
    }
    const title = firstTag(item, 'title');
    const link = firstTag(item, 'link');
    const start = toUtcIso(firstTag(item, 'bc:start_date'));
    if (!title || !link || !start) {
      diagnostics.malformedItems += 1;
      continue;
    }

    // WAS `if (events.length >= limit) break;` AFTER the push, which emitted exactly the
    // same records but abandoned the loop — so the items the cap cost us were never even
    // counted, and "the feed gave us N, we emitted M" was unanswerable without a re-pull.
    // Hoisted ABOVE the field derivation because, past the two skips above, a BiblioCommons
    // item is unconditionally emittable: nothing below can still reject it, so anything
    // refused here is exactly "would have been emitted but for the cap" — the same meaning
    // `droppedByLimit` carries on the generic_rss path.
    if (events.length >= limit) {
      diagnostics.droppedByLimit += 1;
      continue;
    }

    const descriptionHtml = firstTag(item, 'description') ?? '';
    const descriptionText = stripHtml(descriptionHtml);
    const categories = tagBlocks(item, 'category').map((c) => decodeXmlText(c)).filter(Boolean);
    const location = rssLocation(system, item);
    const branch = firstTag(tagBlocks(item, 'bc:location')[0] ?? '', 'bc:name') || `${system.systemName} branch`;
    events.push({
      id: eventIdFromLink(link),
      title,
      branch,
      startsAt: start,
      endsAt: toUtcIso(firstTag(item, 'bc:end_date')),
      // `<category>` is a flat MIXTURE — audiences, topics, languages, series names — so the
      // per-tenant allowlist decides which of them are claims about who the programme is for,
      // and only those outrank a keyword pulled out of the description prose.
      ...resolveBiblioCommonsAgeSignal(title, descriptionText, audienceTagsOf(system, categories)),
      url: link,
      registrationRequired: /registration\s+required/i.test(descriptionText),
      registrationSignal: 'description-prose',
      descriptionText,
      categoryHint: categoryHint(title, categories),
      location,
    });
    diagnostics.emitted += 1;
  }
  return { events, diagnostics };
}

/**
 * Fold a BiblioCommons RSS run's tally into a health-board verdict.
 *
 * Every check here is the family-wide one from ./run-health.ts — empty feed, yield collapse
 * (absolute and against the trailing baseline), and client-side truncation, stating HOW MANY
 * records the cap cost. This platform adds no canary of its own: its fields are structured
 * and versioned, so it has no free-text shape to drift the way NVDPL's Date/Time can.
 *
 * ⚠️ WHAT A `droppedByLimit: 0` DOES AND DOES NOT MEAN, because on VPL it is the answer
 * FOREVER and reading it as "not truncated" would be exactly wrong. `droppedByLimit` counts
 * what OUR cap refused out of what BiblioCommons handed us. If the vendor's page and our cap
 * are the same number — VPL's `liveEventsLimit` is 25, and a single probe once saw a 25-item
 * page — then VPL emits 25 of 25 and drops nothing BY OUR CAP while potentially still being
 * capped upstream. RPL's cap is 20 against that same page, so RPL DOES report
 * `droppedByLimit: 5`. The shape that betrays the collision is `itemsInFeed` sitting on
 * `liveEventsLimit`, and `formatFeedTally` now states it in words instead of leaving two
 * numbers to be compared by eye.
 *
 * ⚠️ NEITHER SHAPE ALERTS, AND THE TALLY LINE IS NOT WHAT MAKES THEM VISIBLE. An `ok`
 * verdict's `detail` is read nowhere: worker/core/ingest.ts consults it only inside
 * `if (verdict?.alert)`, so it is computed and dropped. What makes a permanently-capped
 * source visible is `source_check_run.items_in_feed` (migration 0031) — a recorded number
 * anything can query — not a string on a verdict nobody reads. The vendor's true page size
 * is still UNMEASURED for both tenants; that column is what will measure it.
 */
export function assessBiblioCommonsRun(
  system: LibrarySystemConfig,
  diagnostics: BiblioCommonsParseDiagnostics,
  baselineRecordsFound: number | null = null,
  live = false
): LibraryHealthVerdict {
  return assessLibraryFeedRun(
    system,
    diagnostics,
    formatFeedTally(
      diagnostics,
      [
        { label: 'cancelled', count: diagnostics.cancelledItems },
        { label: 'malformed', count: diagnostics.malformedItems },
      ],
      biblioCommonsLimit(system)
    ),
    baselineRecordsFound,
    live
  );
}

async function fetchBiblioCommonsRss(system: LibrarySystemConfig): Promise<BiblioEvent[]> {
  if (!system.rssEventsUrl) {
    throw new Error(`No BiblioCommons RSS URL configured for ${system.systemKey}`);
  }
  const response = await politeFetch(
    libraryPolicyKey(system),
    new URL(system.rssEventsUrl),
    { headers: { accept: 'application/rss+xml, application/xml, text/xml' } },
    { family: system.sourceFamily }
  );
  if (!response.ok) {
    throw new Error(`BiblioCommons RSS fetch failed: ${response.status} ${response.statusText}`);
  }
  const xml = await response.text();
  return parseAndRecordBiblioCommonsRss(system, xml, true);
}

/** Parse a BiblioCommons RSS body and record its tallies for assessRun(). Mirrors
 *  parseAndRecordGenericRss — the recording lives at the parse seam, not at the fetch seam,
 *  so a test that drives the parser directly exercises the same path production does. */
function parseAndRecordBiblioCommonsRss(
  system: LibrarySystemConfig,
  xml: string,
  live: boolean
): BiblioEvent[] {
  const { events, diagnostics } = parseBiblioCommonsRss(system, xml);
  lastBiblioCommonsDiagnostics.set(system.systemKey, { diagnostics, live });
  return events;
}

/** Last run's BiblioCommons parse tallies per system. Same module-scoped hand-off as
 *  `lastGenericRssDiagnostics` below, for the same reason: the Adapter interface hands
 *  assessRun() only a baseline count, never the parse result. */
const lastBiblioCommonsDiagnostics = new Map<
  string,
  { diagnostics: BiblioCommonsParseDiagnostics; live: boolean }
>();

// --- generic_rss feed path (NVDPL, D-12) ---------------------------------------
// Same seam, same politeness, same single unauthenticated GET as the BiblioCommons RSS
// path above — the ONLY difference is which parser reads the body. Deliberately does not
// fork politeFetch: rate limiting, the 403/429 breaker, the identified UA, the request
// deadline and the conditional headers all stay in one place.

async function fetchGenericRss(system: LibrarySystemConfig): Promise<GenericRssEvent[]> {
  if (!system.rssEventsUrl) {
    throw new Error(`No RSS URL configured for ${system.systemKey}`);
  }
  const response = await politeFetch(
    libraryPolicyKey(system),
    new URL(system.rssEventsUrl),
    { headers: { accept: 'application/rss+xml, application/xml, text/xml' } },
    { family: system.sourceFamily }
  );
  if (!response.ok) {
    throw new Error(`Generic RSS fetch failed: ${response.status} ${response.statusText}`);
  }
  return parseAndRecordGenericRss(system, await response.text(), true);
}

/** Parse a generic_rss body and record its tallies for assessRun(). Used by BOTH the live
 *  and fixture paths, so run health is exercised in tests rather than only in production. */
function parseAndRecordGenericRss(
  system: LibrarySystemConfig,
  xml: string,
  live: boolean
): GenericRssEvent[] {
  const { events, diagnostics } = parseGenericRss(system, xml);
  lastGenericRssDiagnostics.set(system.systemKey, { diagnostics, live });
  return events;
}

/** Last run's parse tallies per system, so assessRun() can report on what fetch() saw.
 *  Module-scoped for the same reason the PerfectMind adapter keeps its own run health:
 *  the Adapter interface hands assessRun() only a baseline count, not the parse result. */
const lastGenericRssDiagnostics = new Map<
  string,
  { diagnostics: GenericRssParseDiagnostics; live: boolean }
>();

export class LibraryAdapter implements Adapter {
  readonly family = 'library';

  constructor(private readonly system: LibrarySystemConfig) {}

  /**
   * TRIPLE GATE. All three must hold before a single byte leaves the process:
   *   1. config  — `liveCapable: true` on this system (a reviewed live path exists);
   *   2. env     — this systemKey named in KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
   *   3. DB      — terms_status ∈ {allowed, summarise_only} AND robots cleared
   *                (robots_status = 'allowed', or NVDPL's F-5 case: robots_status =
   *                'unknown' plus a robots_override_decision matching the anchored
   *                decision-reference shape pattern — NOT merely non-blank; F-QA-1
   *                replaced that test, so a padded or whitespace-only reference is
   *                rejected. This is the D-12 unreadable-robots.txt override,
   *                docs/source-register.md §7),
   *                enforced independently of 1 and 2, in TWO places (QA finding F-C
   *                corrected this pointer — it is NOT politeFetch):
   *                  • worker/core/source-runner.ts — evaluateLiveFetchGate() per run;
   *                  • worker/scheduler/tiered.ts — the same predicate in SQL, so an
   *                    un-cleared source is never even enqueued.
   *                politeFetch does rate-limiting, the identified UA and the request
   *                deadline — NOT the terms gate. Note that worker/health/policy.ts DOES
   *                export a `guardedLiveFetch` that composes the gate with politeFetch,
   *                and it reads like the enforcement point, but it currently has ZERO
   *                callers — which is most likely why this comment was wrong to begin
   *                with. Do not rely on it; the two sites above are the real gate.
   * Default posture with no env var set is fixture-only and ZERO network calls.
   */
  isLiveFetchEnabled(): boolean {
    return this.system.liveCapable === true && liveEnabledFor(this.system.systemKey);
  }

  async fetch(): Promise<unknown[]> {
    if (this.isLiveFetchEnabled()) {
      if (this.system.platform === 'generic_rss') {
        return fetchGenericRss(this.system);
      }
      // Prefer the ToS-permitted RSS/XML feed where configured (e.g. VPL);
      // fall back to the public JSON gateway (e.g. RPL) otherwise.
      if (this.system.rssEventsUrl) {
        return fetchBiblioCommonsRss(this.system);
      }
      return fetchBiblioCommonsEvents(this.system);
    }

    // Synthetic per-platform feed fixtures (no live request). Shape only.
    if (this.system.platform === 'generic_rss') {
      // Mirrors a real NVDPL item, escaped-HTML description and all, so the fixture path
      // exercises the same parser the live path does rather than a hand-built object that
      // could drift from it.
      return parseAndRecordGenericRss(this.system, GENERIC_RSS_FIXTURE_XML, false);
    }
    if (this.system.platform === 'bibliocommons') {
      // NO feed was parsed on this path — the fixture is a hand-built object, not RSS — so
      // there is no tally to record and assessRun() must report nothing rather than a
      // fabricated one. Any tally left over from an earlier LIVE run in this process is
      // dropped here for the same reason: reporting last run's 25-of-25 against a run that
      // never touched the network would be a lie with a plausible number attached.
      lastBiblioCommonsDiagnostics.delete(this.system.systemKey);
      const events: BiblioEvent[] = [
        {
          id: `${this.system.systemKey}-baby-storytime-1`,
          title: 'Baby Storytime',
          branch: `${this.system.systemName} — Central`,
          startsAt: '2026-07-15T17:30:00.000Z',
          endsAt: '2026-07-15T18:00:00.000Z',
          ages: '0-2 years',
          url: `${this.system.feedBaseUrl}/${this.system.systemKey}-baby-storytime-1`,
          registrationRequired: false,
          // Mirrors the gateway shape: a BiblioCommons event whose registrationInfo block is
          // PRESENT and empty (no methods enabled) — which is a real drop-in fact, and is
          // deliberately not the same as the block being absent ('absent', see F5). The
          // fixture asserts drop-in because the payload it stands in for does, not because
          // `false` is a convenient default.
          registrationSignal: 'registration-info',
        },
      ];
      return events;
    }
    const events: CommunicoEvent[] = [
      {
        eventId: `${this.system.systemKey}-toddler-storytime-1`,
        name: 'Toddler Storytime',
        location: `${this.system.systemName} — City Centre`,
        start: '2026-07-15T16:30:00.000Z',
        end: '2026-07-15T17:00:00.000Z',
        audience: 'Ages 2-5',
        detailUrl: `${this.system.feedBaseUrl}/${this.system.systemKey}-toddler-storytime-1`,
      },
    ];
    return events;
  }

  extract(raw: unknown[]): StructuredRecord[] {
    if (this.system.platform === 'generic_rss') {
      return (raw as GenericRssEvent[]).map((e) => ({
        sourceRecordId: e.id,
        title: e.title,
        venueName: e.venueName,
        // Every venue field stays undefined unless the curated table or the feed's own
        // address block supplied it. A geo-less venue is the honest outcome here, not a
        // failure — see the branchLocations comment in ./config.ts.
        venueAddress: e.location?.address || undefined,
        venueLat: e.location?.lat,
        venueLng: e.location?.lng,
        // NVDPL's generic RSS publishes an address but never a lat/lng, and this adapter
        // does not geocode — so a coordinate here can ONLY have come from the curated
        // branchLocations table (worker/adapters/library/generic-rss.ts::resolveLocation).
        // Declared through the shared helper anyway rather than hardcoded, so the day the
        // feed does start carrying coordinates this drops to tier 10 automatically instead
        // of silently claiming curation it does not have.
        ...venueGeoDeclaration(e.location, 'library:nvdpl'),
        venueMunicipalityName: e.location?.municipalityName || undefined,
        venueDisplayArea: e.location?.displayArea || undefined,
        // Parsed from the free-text Date/Time inside `description`, NEVER from pubDate.
        startDatetimeUtc: e.startsAt,
        endDatetimeUtc: e.endsAt,
        // NVDPL library programming is free to attend; the feed publishes no cost field,
        // and 'free' matches the rest of the library family.
        costStatus: 'free' as const,
        ageText: e.ages,
        categoryHint: e.categoryHint,
        sourceUrl: e.url,
        // The feed exposes no registration flag at all, so no bookingUrl is asserted — and
        // for the same reason `registrationRequired` is left UNSET rather than false. NVDPL
        // publishes nothing either way; claiming drop-in from that silence is the one thing
        // the tri-state contract in ../../core/adapter.ts forbids.
        locationUrl: e.location?.locationUrl || undefined,
        raw: e,
      }));
    }
    if (this.system.platform === 'bibliocommons') {
      return (raw as BiblioEvent[]).map((e) => ({
        sourceRecordId: e.id,
        title: e.title,
        venueName: e.branch, // branch/location provenance (G-T9-3)
        venueAddress: e.location?.address,
        venueLat: e.location?.lat,
        venueLng: e.location?.lng,
        // Per RECORD, not per adapter: a BiblioCommons item that carries its own
        // bc:latitude is a live vendor payload (tier 10); one that fell back to the curated
        // branch table is an adapter config literal (tier 20). Same feed, same run, two
        // different claims — collapsing them to one number would have mislabelled whichever
        // half lost.
        ...venueGeoDeclaration(e.location, `library:${this.system.systemKey}`),
        venueMunicipalityName: e.location?.municipalityName,
        venueDisplayArea: e.location?.displayArea,
        startDatetimeUtc: e.startsAt,
        endDatetimeUtc: e.endsAt,
        costStatus: 'free' as const,
        // Exactly one of these two is ever set (resolveBiblioCommonsAgeSignal picks the winner);
        // both are forwarded so ingest resolves the structured tags by their own union rule
        // rather than by the prose parser's first-keyword-wins ordering.
        ageText: e.ages,
        ageAudienceLabels: e.audienceLabels,
        categoryHint: e.categoryHint ?? categoryHint(e.title),
        sourceUrl: e.url,
        // Two DIFFERENT things, deliberately both emitted. `bookingUrl` is a link, and its
        // presence has been the only trace of registration on any persisted row until now —
        // which is why the DB could not distinguish a public swim from a 12-week course.
        // `registrationRequired` is the fact itself, including the case where the source
        // positively says NO registration is needed, which a url can never express.
        bookingUrl: e.registrationRequired ? e.url : undefined,
        registrationRequired: registrationAssertion(e),
        locationUrl: e.location?.locationUrl,
        raw: e,
      }));
    }
    // Communico carries no registration field either — `registrationRequired` stays unset,
    // same reasoning as generic_rss above.
    return (raw as CommunicoEvent[]).map((e) => ({
      sourceRecordId: e.eventId,
      title: e.name,
      venueName: e.location,
      startDatetimeUtc: e.start,
      endDatetimeUtc: e.end,
      costStatus: 'free' as const,
      ageText: e.audience,
      categoryHint: 'storytime',
      sourceUrl: e.detailUrl,
      raw: e,
    }));
  }

  /**
   * Self-assess the run just extracted (Adapter.assessRun), for BOTH feed-parsing platforms.
   *
   * WHY BIBLIOCOMMONS IS NOW INCLUDED, having previously been excluded on the grounds that
   * "the BiblioCommons feeds publish structured, versioned fields whose breakage is loud".
   * That reasoning is sound about SHAPE breakage and irrelevant to the failure this project
   * actually has. Truncation is not a shape change and is not loud: the feed answers 200,
   * every field parses, every record is valid, and the run is silently short. The capability
   * to say so already existed for generic_rss — the one platform that never runs live — so
   * the two sources that DO run live (VPL, RPL) were the two discarding the tally. Reusing
   * the family-wide assessor rather than writing a second one also means empty-feed and
   * yield-collapse now cover them, which are correct on any feed and were simply unreachable.
   *
   * Returns null when there is nothing honest to report: Communico (no feed parser at all),
   * or a BiblioCommons run that took the FIXTURE path, where no feed was parsed. A verdict
   * is only ever derived from a tally an actual parse produced.
   */
  assessRun(baselineRecordsFound: number | null = null): LibraryHealthVerdict | null {
    if (this.system.platform === 'generic_rss') {
      const last = lastGenericRssDiagnostics.get(this.system.systemKey);
      if (!last) return null;
      return assessGenericRssRun(this.system, last.diagnostics, baselineRecordsFound, last.live);
    }
    if (this.system.platform === 'bibliocommons') {
      const last = lastBiblioCommonsDiagnostics.get(this.system.systemKey);
      if (!last) return null;
      return assessBiblioCommonsRun(this.system, last.diagnostics, baselineRecordsFound, last.live);
    }
    return null;
  }

  /**
   * How many items the FEED delivered on the run just extracted (Adapter.reportItemsInFeed),
   * for persistence to `source_check_run.items_in_feed`. Null when this run has no honest
   * number to report.
   *
   * WHY THIS IS THE POINT OF THE UNIT. `records_found` is identically `emitted`
   * (worker/core/ingest.ts increments it once per extracted record), i.e. the quantity OUR
   * OWN cap censors — so every health statistic built on it has our configuration baked into
   * it, and a cap sitting below vendor supply makes a healthy run look thin and a thin run
   * look healthy. `itemsInFeed` is read off the raw response BEFORE any cap logic
   * (`parseBiblioCommonsRss`), and the live request carries no limit parameter, so it is
   * censored only by the VENDOR. It has never been recorded anywhere. This is where that
   * starts.
   *
   * WHY IT IS A SEPARATE METHOD FROM `assessRun` AND NOT A FIELD ON THE VERDICT. The verdict
   * pipeline discards everything on a non-alerting run — ingest.ts reads the verdict ONLY
   * inside `if (verdict?.alert)`. A measurement routed through that pipeline would be lost in
   * exactly the case it exists to illuminate: the quiet, permanently-capped source. Keeping
   * it structurally outside means no future edit to the alert branch can silently drop it.
   *
   * LIVE RUNS ONLY, DELIBERATELY. A fixture run's item count is a property of a hand-written
   * fixture, not of the vendor, and recording it would poison both of the things this column
   * exists for: `max(items_in_feed)` as the measured vendor page size, and a live-only supply
   * baseline. The bibliocommons fixture path gets this for free (it clears the diagnostics
   * map), but the generic_rss fixture path DOES record a tally — so the `live` gate here is
   * what makes "items_in_feed IS NULL ⇒ not a live run" true for the whole family rather than
   * accidentally true for one platform.
   */
  reportItemsInFeed(): number | null {
    const last =
      this.system.platform === 'generic_rss'
        ? lastGenericRssDiagnostics.get(this.system.systemKey)
        : this.system.platform === 'bibliocommons'
          ? lastBiblioCommonsDiagnostics.get(this.system.systemKey)
          : undefined;
    if (!last || !last.live) return null;
    return last.diagnostics.itemsInFeed;
  }

  dedupKeys(record: StructuredRecord): DedupKey {
    return { key: `library::${this.system.systemKey}::${record.sourceRecordId}` };
  }
}

export function loadLibraryAdapters(): LibraryAdapter[] {
  return LIBRARY_SYSTEMS.map((system) => new LibraryAdapter(system));
}

export { LIBRARY_SYSTEMS, getLibrarySystem };
