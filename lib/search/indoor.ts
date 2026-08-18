// lib/search/indoor.ts — the "is this indoors?" reading, in ONE place.
//
// WHY THIS MODULE EXISTS
// "Indoor" and "Rainy-day friendly" are the two strings a parent acts on when it is raining and
// they have a toddler in the hall. They were being INFERRED, in two different places, from things
// that do not carry the claim — and the strongest of those inferences was drawn from the one
// category key that explicitly means "we could not work out what this is".
//
// THE DEFECT THIS REPLACES (found by the 15-persona user-testing cycle, severity 3, live)
// `suitabilityTags()` in ./postgres-repository.ts added `indoor` for `storytime`, `indoor_play`
// AND `class_program`. But `class_program` is also the final fallback of `categoryKeyFromTitle()`
// in that same file, and worker/core/taxonomy.ts assigns it `certainty: 'generic'` for exactly the
// same reason: it is the "unclassified" bucket. So every listing the pipeline could not classify
// was published to parents as Indoor / Rainy-day friendly.
//
// Measured against the live catalogue on 2026-08-18 (4,311 visible occurrences; 3,582 enumerated
// via /api/search, 83.1%): 2,681 listings — 62.2% of everything a parent can see — were
// `class_program`, and 2,280 of the 2,335 in the enumerated sample were carrying an `indoor` tag
// that NOTHING in their source data supported. 34 of them were not merely unsupported but
// actively contradicted by their own titles: "Sportball Outdoor Soccer (5-7yrs) Rain/Shine",
// "Raincity Basketball Outdoor Camp", "Outdoor Baby & Me Bootcamp", "Zumba Outdoor".
//
// THE RULE
// An unknown is rendered as an unknown. This is the same ruling the codebase already applies to
// `registration_required` (passed through verbatim, nulls included — see ./postgres-repository.ts
// and supabase/migrations/0027) and to age (`ageGuide` answers "Not stated" rather than inventing
// 0–18 — see app/preview/_data/format.ts). The fix is honesty, not suppression: where the source
// DOES say outdoors we now say Outdoor, which is more information than the old code gave, not
// less. Where nothing says either, we say nothing.

/**
 * What we can honestly say about whether a listing is indoors.
 *
 * `unknown` is a first-class answer, not a failure. It is what the majority of this catalogue
 * actually supports, and it must never be collapsed into `indoor` (the bug above) or into
 * `outdoor` (its mirror image — a listing with no indoor tag is not thereby an outdoor listing).
 */
export type IndoorReading = 'indoor' | 'outdoor' | 'unknown';

/**
 * Words that, in a listing's own title or description, are the SOURCE saying "this is outdoors".
 * A match here is a hard veto: it can never produce an `indoor` claim, under any category.
 *
 * Outdoor storytime, outdoor play sessions and outdoor gym classes are all real things in this
 * catalogue, which is why the veto applies to EVERY path that can assert `indoor` and not only to
 * the `class_program` one that caused the reported findings.
 *
 * DELIBERATELY EXCLUDED, having been tested against the live catalogue on 2026-08-18:
 * `creek`, `lake`, `river`, `plaza`, `grounds`, `track`, `walk`. Every one of their 94 combined
 * hits was a VENUE NAME rather than a claim about the weather — "Lynn Creek Youth Centre" (83
 * hits, indoors), "Trout Lake Arena" (11 hits, an indoor ice rink). A marker that fires on a place
 * name buys no safety at all and costs real rainy-day recall, so it is not a marker.
 */
const OUTDOOR_MARKERS = [
  'outdoor',
  'outdoors',
  'open air',
  'al fresco',
  'rain or shine',
  'rain/shine',
  'park',
  'spray park',
  'water park',
  'playground',
  'beach',
  'seawall',
  'waterfront',
  'trail',
  'hike',
  'hiking',
  'nature walk',
  'forest',
  'garden',
  'orchard',
  'farm',
  'field',
  'picnic',
  'campfire',
  'tobogganing',
  'sledding',
  'canoe',
  'kayak',
] as const;

/** The mirror set. Needed so an INDOOR claim in the same sentence can rebut a marker above. */
const INDOOR_MARKERS = ['indoor', 'indoors'] as const;

// Each marker's internal spaces and slashes are relaxed to "any run of space, slash or hyphen", so
// one entry covers "Rain/Shine", "rain shine" and "Rain-Shine". No `g` flag: a global regex carries
// `lastIndex` between calls and would silently alternate true/false across listings.
function markerRe(markers: readonly string[]): RegExp {
  return new RegExp(`\\b(?:${markers.map((m) => m.replace(/[/\s]+/g, '[\\s/-]+')).join('|')})\\b`, 'i');
}

const OUTDOOR_MARKER_RE = markerRe(OUTDOOR_MARKERS);
const INDOOR_MARKER_RE = markerRe(INDOOR_MARKERS);

/** True when any of the given free-text fields contains an explicit outdoor marker. */
export function hasOutdoorMarker(...texts: (string | null | undefined)[]): boolean {
  return texts.some((text) => typeof text === 'string' && OUTDOOR_MARKER_RE.test(text));
}

/**
 * What a listing's OWN WORDS say about being indoors — `null` when they say nothing, and also when
 * they say both.
 *
 * The both-case is why this is not just `hasOutdoorMarker`. `playground` and `park` are outdoor
 * markers, so "Indoor Playground" and "Indoor Play at Parkgate" would otherwise read as outdoor
 * claims and the veto would strip `indoor` from exactly the listings that deserve it most. A title
 * carrying both words has settled nothing, so it defers to the tags and the category below rather
 * than casting the deciding vote.
 */
export function indoorTextVerdict(...texts: (string | null | undefined)[]): 'indoor' | 'outdoor' | null {
  const saysIndoor = texts.some((t) => typeof t === 'string' && INDOOR_MARKER_RE.test(t));
  const saysOutdoor = hasOutdoorMarker(...texts);
  if (saysIndoor === saysOutdoor) return null;
  return saysIndoor ? 'indoor' : 'outdoor';
}

/**
 * Category keys whose key IS itself an indoor claim, for the DB READ MODEL's derived tag.
 *
 * `class_program` IS NOT IN THIS SET AND MUST NEVER BE ADDED TO IT. It is the fallback both
 * `categoryKeyFromTitle()` and the taxonomy worker return when classification fails; treating it
 * as evidence of anything is what produced the mislabels this module documents.
 */
export const INDOOR_CATEGORY_KEYS: ReadonlySet<string> = new Set(['storytime', 'indoor_play']);

/**
 * Category keys the RENDER boundary (app/preview/_data/search-api.ts) additionally treats as
 * indoor facilities. Wider than the read model's set above, and deliberately left that way here.
 *
 * KNOWN DIVERGENCE, FLAGGED NOT FIXED. `public_swim` and `skate` are weaker claims than they look
 * — Metro Vancouver has outdoor pools (Kitsilano, Second Beach, New Brighton) and outdoor rinks —
 * so 1,038 live listings are asserting "Indoor" from a facility type rather than from evidence.
 * The outdoor-marker veto below now covers them, which removes the actively-wrong cases, but the
 * unsupported ones remain. Narrowing this set would change the engine's rainy-day filter and rank
 * for ~942 listings, which is a product decision and a much larger blast radius than the defect
 * this module was opened for. Raised with the orchestrator as a scoped follow-up.
 */
const INDOOR_FACILITY_CATEGORY_KEYS: ReadonlySet<string> = new Set([
  ...INDOOR_CATEGORY_KEYS,
  'open_gym',
  'public_swim',
  'skate',
]);

export interface IndoorInput {
  primaryCategoryKey: string;
  /** Every tag on the listing — suitability and category alike. Order and duplicates don't matter. */
  tags: Iterable<string>;
  activityName?: string | null;
  descriptionSnippet?: string | null;
}

/**
 * The one reading, used by every surface that prints "Indoor", "Outdoor" or "Rainy-day friendly".
 *
 * ONE RULE, TWO STEPS.
 *
 * 1. THE SOURCE'S OWN WORDS DECIDE, when they are one-sided. A title is the source speaking
 *    directly about this session — "Sportball Outdoor Soccer (5-7yrs) Rain/Shine" settles the
 *    question, and it outranks anything we merely inferred. This is what lets "Storytime in the
 *    Park" read `outdoor` despite the `storytime` category.
 *
 * 2. OTHERWISE THE DERIVED SIGNALS MUST AGREE. Tags and categories are both pipeline inferences
 *    of comparable, and demonstrably imperfect, reliability — so when they disagree neither is
 *    strong enough to carry a claim on its own, and the answer is `unknown`. Concretely, 42 live
 *    `open_gym` listings at Parkgate Community Centre carry an `outdoor` TAG (almost certainly
 *    read off the venue's name) while their CATEGORY says indoor gym. The old code printed
 *    "Indoor / Rainy-day friendly" for them on the category's say-so alone; picking the tag
 *    instead would just print an equally unearned "Outdoor". Two weak signals in opposition are
 *    not one strong signal, so we say nothing and let the parent check the source.
 *
 * `unknown` therefore covers both "nothing said" and "our own signals contradict each other".
 * Both are the truth, and neither is a licence to publish half of it — the same ruling
 * "Indoor/Outdoor Stroller Fitness with Carey" gets, five of which are live today.
 */
export function readIndoorOutdoor(input: IndoorInput): IndoorReading {
  const fromText = indoorTextVerdict(input.activityName, input.descriptionSnippet);
  if (fromText) return fromText;

  const tags = new Set(input.tags);
  const indoorEvidence =
    tags.has('indoor') || tags.has('rainy_day') || INDOOR_FACILITY_CATEGORY_KEYS.has(input.primaryCategoryKey);
  const outdoorEvidence = tags.has('outdoor') || input.primaryCategoryKey === 'outdoor_park';

  if (indoorEvidence === outdoorEvidence) return 'unknown'; // neither spoke, or they contradict
  return indoorEvidence ? 'indoor' : 'outdoor';
}
