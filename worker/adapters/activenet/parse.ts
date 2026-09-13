// worker/adapters/activenet/parse.ts — G-T7R-3: ActiveCommunities events → StructuredRecord.
//
// Three things in here are load-bearing and were each verified against real captured
// payloads (worker/adapters/activenet/__fixtures__/), not assumed:
//
//  1. TIME. `start_time`/`end_time` are LOCAL WALL-CLOCK with NO OFFSET
//     ("2026-07-30 15:30:00"), in the tenant's IANA zone. Reading them as UTC shifts
//     every listing by 7–8 hours; reading them with a fixed offset breaks by an hour
//     around each DST transition. Conversion goes through worker/core/time.ts, which
//     resolves the offset actually in force at the instant (see its header).
//
//  2. COST. `price.free` is NOT trustworthy on this platform. Measured on the real
//     Vancouver payload: 838 records carry `free: true`, and 101 of them (12%) sit on a
//     description that quotes a price ("Drop-in price is per child $3.00") or names an
//     admission fee. `estimate_price` is frequently the literal string
//     "Check details for fees". Telling a parent something is free when it is not is
//     this product's worst failure mode, so `free` is asserted ONLY on TWO independent
//     corroborating signals and NEVER on the boolean alone — see classifyCost().
//
//  3. IDENTITY. `event_item_id` is the ACTIVITY id and repeats across dates (Vancouver:
//     3,072 distinct ids across 10,146 occurrences; even id+start+centre collides 7
//     times). Occurrence identity is id + start + centre + facility ids, which was
//     measured to be fully distinct on both tenants.
//
// Free-text AGE wording is deliberately NOT resolved here — it is captured into
// `ageText` and left to T13's existing deterministic normaliser (worker/core/age.ts),
// which the ingest pipeline already calls. This adapter does not fork that logic.
import type { StructuredRecord } from '../../core/adapter';
import { zonedLocalToUtcIso } from '../../core/time';
import type { ActiveNetCentreEvents, ActiveNetEvent, CalendarFetchResult } from './client';
import { calendarPageUrl, type ActiveNetTenantConfig } from './config';

/** ActiveNet prefixes centre names with one or more `*` sentinels ("*Hastings Community
 *  Centre"). MEASURED: Vancouver 36/36 centres carry it, Burnaby 0/7 do — it is a
 *  tenant-level display convention, so strip defensively rather than assume either way. */
export function stripCentreSentinel(name: string | undefined | null): string | undefined {
  const cleaned = (name ?? '').replace(/^\**\s*/, '').trim();
  return cleaned || undefined;
}

/** Descriptions arrive as small HTML fragments (`<p>…</p><div>…</div>`). */
export function stripHtml(html: string | undefined | null): string {
  return (html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── cost ────────────────────────────────────────────────────────────────────────────

/** Money is being asked for: an explicit amount, or fee/admission wording. */
const FEE_LANGUAGE_RE =
  /\$\s?\d|\bfees?\s+(?:apply|are|is|per)\b|\badmission\s+(?:fee|rate|price|applies)\b|\bregular\s+admission\b|\bdrop-?in\s+(?:price|rate|fee|cost)\b|\bper\s+child\b|\bpunch\s?card\b|\bpay\s+at\b/i;

/** Wording that positively asserts no cost. */
const FREE_LANGUAGE_RE = /\bfree\b|\bno\s+charge\b|\bno\s+fee\b|\bcomplimentary\b/i;

/** `estimate_price` as a structured-ish free marker: exactly "Free" / "no charge". */
const FREE_PRICE_TOKEN_RE = /^(?:free|no\s+charge|n\/?c)$/i;

/** `estimate_price` as a real amount: "$7.93", "$6.00". */
const NUMERIC_PRICE_RE = /^\$?\s*(\d+(?:\.\d{1,2})?)\s*$/;

export interface CostVerdict {
  costStatus: NonNullable<StructuredRecord['costStatus']>;
  costMinCad?: number;
  costMaxCad?: number;
  /** Why — surfaced in the coverage report so the distribution is explainable. */
  reason: string;
}

/**
 * Honest cost classification.
 *
 * Precedence, and why:
 *   1. A real amount in `estimate_price` is the strongest signal there is → 'known'
 *      ($0.00 → 'free'). It beats prose either way.
 *   2. Fee language ANYWHERE (title, description, price string) → 'check_source'.
 *      This is the rule that catches the measured `free: true` + "Drop-in price is per
 *      child $3.00" contradiction. Fee language can never yield 'free'.
 *   3. 'free' requires TWO independent corroborating signals from
 *      {price.free === true, estimate_price is a free token, free wording in the text}.
 *      One signal alone — including the boolean alone — is 'check_source', because
 *      one signal is exactly what was measured to be wrong 12% of the time.
 *   4. Any other non-empty price string ("Check details for fees") → 'check_source'.
 *      Never coerced to 0 and never dropped.
 *   5. Nothing to go on → 'unknown'.
 */
export function classifyCost(event: ActiveNetEvent): CostVerdict {
  const price = event.price ?? {};
  const estimate = String(price.estimate_price ?? '').trim();
  const text = `${event.title ?? ''} ${stripHtml(event.description)} ${estimate}`;

  const numeric = NUMERIC_PRICE_RE.exec(estimate);
  if (numeric) {
    const amount = Number(numeric[1]);
    if (amount === 0) return { costStatus: 'free', costMinCad: 0, costMaxCad: 0, reason: 'estimate_price $0' };
    return { costStatus: 'known', costMinCad: amount, costMaxCad: amount, reason: 'estimate_price amount' };
  }

  if (FEE_LANGUAGE_RE.test(text)) {
    return { costStatus: 'check_source', reason: 'fee language present — free flag not trusted' };
  }

  const signals = [
    price.free === true,
    FREE_PRICE_TOKEN_RE.test(estimate),
    FREE_LANGUAGE_RE.test(`${event.title ?? ''} ${stripHtml(event.description)}`),
  ].filter(Boolean).length;

  if (signals >= 2) {
    return { costStatus: 'free', costMinCad: 0, costMaxCad: 0, reason: `${signals} corroborating free signals` };
  }
  if (signals === 1) {
    return { costStatus: 'check_source', reason: 'single uncorroborated free signal' };
  }
  if (estimate) {
    return { costStatus: 'check_source', reason: `unparseable price string: ${estimate}` };
  }
  return { costStatus: 'unknown', reason: 'no price signal' };
}

// ── age wording (captured only; T13 resolves it) ────────────────────────────────────

/** A bounded age phrase from prose, so the whole description is not fed to the
 *  normaliser (a full paragraph produces confident nonsense — e.g. "Children 12
 *  months and under are free" would read as an age range).
 *
 *  Split into its two halves because the halves are not equally good evidence, and
 *  statedAgePhrase() below has to be able to tell them apart. THE SPLIT ITSELF was inert:
 *  no alternative was added, removed or reordered by it, and `.source`/`.flags` were
 *  compared against the previous literal to prove it.
 *
 *  That is a claim about the split, NOT about the pattern today. The vocabulary has moved
 *  on since: `preschool(?:ers)?` → `preschool(?:ers?)?` deliberately made the singular
 *  "preschooler" reachable, which this regex previously rejected. Read the union below as
 *  current, not as frozen. */
const AGE_PHRASE_NUMERIC =
  String.raw`ages?\s*\d{1,2}\s*(?:-|–|to)\s*\d{1,2}|\bages?\s*\d{1,2}\s*\+|\b\d{1,2}\s*(?:-|–|to)\s*\d{1,2}\s*(?:yrs?|years)|\b\d{1,2}\s*\+\s*(?:yrs?|years)`;
/**
 * Audience words a DESCRIPTION may state.
 *
 * `all ages` IS DELIBERATELY ABSENT, and its absence is the safety rule of this module.
 * An all-ages claim is the most permissive statement this product can make — it matches every
 * band including under-2 — so it is published ONLY when the source attributes it directly: in
 * the TITLE (see TITLE_STATES_AGE_RE, which still admits it) or in a structured age field.
 * Measured live on the source's own API, 2026-09-12: `Karate - Ku Yu Kai Go-Ju Ryu (Adults)`
 * (age_min_year 19) says "teaches classes for all ages and levels" — a sentence about the
 * INSTRUCTORS; `Wu's Tai Chi` (age_min_year 50) says "for people of all ages and health
 * conditions"; `Bootcamp Circuits` (age_min_year 19) says "This all ages, circuit-based class".
 * In every case the phrase is marketing colloquial for "any level, come along" and the venue
 * states a real numeric bound elsewhere. Prose cannot carry this claim.
 */
const AGE_PHRASE_KEYWORD =
  String.raw`\bpreschool(?:ers?)?\b|\btoddlers?\b|\bbabies\b|\byouth\b|\bteens?\b`;
/** Every age phrase in the text, in order — the scan statedAgePhrase() walks. Numbers and
 *  audience words together, because both are now held to the same evidence bar. */
const AGE_PHRASE_SCAN_RE = new RegExp(`(?:${AGE_PHRASE_NUMERIC}|${AGE_PHRASE_KEYWORD})`, 'gi');
/** Is a matched phrase a bare audience WORD rather than a stated number? */
const AGE_PHRASE_IS_KEYWORD_RE = new RegExp(`^(?:${AGE_PHRASE_KEYWORD})$`, 'i');

/**
 * Wording that makes a nearby number a rule about SOMEONE ELSE, or about money — not a
 * statement of who the programme is for.
 *
 * THIS LIST IS THE WHOLE FIX AND EVERY ENTRY IN IT IS MEASURED. The candidate scan is
 * first-position-wins, and on this platform the vaguer word usually sits earlier in the
 * paragraph than the specific range: "for pre-teens and youth ages 8-18" publishes as
 * 12–18 off `teens`, excluding the 8–11-year-olds the sentence names. Preferring the
 * number is the obvious fix and, done bluntly, it is a much bigger defect than the one it
 * closes: the same `N-N yrs` alternative also matches "children 6-12 years must be
 * accompanied by a participating adult", which would narrow 785 correct all-ages listings
 * (measured, Vancouver + Burnaby, 2026-08-18) to a 6–12 programme. So the number is only
 * promoted over the word when nothing within ±80 characters of it disqualifies it.
 *
 * MEASURED, on all 17,209 live records. 951 records / 34 distinct (title × number) tuples
 * are candidates — i.e. a bare keyword currently wins and a numeric phrase exists elsewhere
 * in the same description. Of those:
 *   • `accompanied` alone catches all 792 records that must NOT change: 785 supervision-rule
 *     records ("children 6-12 years must be accompanied by a participating adult") and,
 *     via `$\d`, the 7 `Play Palace - 0-12yrs` records whose "numeric range" is a row of the
 *     admission fee table ("6-23mos $4.94 2-5yrs $6.35 6-12yrs $7.06").
 *   • it fires on NONE of the other 26 tuples / 159 records, which are the real age claims.
 *     (153 of those 159 go on to change; the "exactly one" rule below holds the other 6.)
 * The window is not a tuned constant holding that split together: every window from ±30 to
 * ±240 produces the byte-identical outcome on all 17,209 records. ±80 is the middle of that
 * plateau — wide enough for "must be accompanied by a participating adult" to sit after the
 * number with room to spare, narrow enough not to reach the next paragraph's boilerplate.
 *
 * THE SCOPE DOC'S OWN SUGGESTED DISQUALIFIER LIST INCLUDED A BARE `free`, AND MEASURING IT
 * IS THE REASON IT IS NOT HERE: "this free basketball drop-in is for youth (ages 13-18)"
 * and "Who: Youth (ages 12–18) Cost: FREE" are ordinary copy here, and a bare `free` term
 * blocks 5 genuine recoveries. Bare `fee`/`admission`, `registration`, `pass`/`visit card`
 * and `staff`/`ratio` were each measured the same way and each block a real recovery too;
 * they appear below only in the precise forms that do not.
 *
 * The last four entries are DEFENSIVE, not measured-firing: no record in this corpus reaches
 * them, because the numbers in waiver / registration-priority / conservatory-grade / staff-
 * ratio copy ("under 19 years", "19yrs+", "grade 5", "between 18 and 22 years old") are not
 * shapes `AGE_PHRASE_NUMERIC` matches at all. They are here because that is an accident of
 * one snapshot's wording, not a property of the pattern, and each is the §2 taxonomy's own
 * evidence phrase quoted narrowly enough to have cost nothing when measured.
 */
const AGE_CLAIM_DISQUALIFIER_RE =
  /must\s+be\s+accompanied|accompanied\s+(?:by|into)|must\s+be\s+supervised|supervised\s+(?:by|on)|\bguardian\b|\bchaperone\b|\$\s*\d|\bwaiver\b|register\s+into\s+this\s+program|\bgrades?\s*\d{1,2}\s*level\b|staff-to-participant|participant\s+ratio/i;

/** How far either side of the number the disqualifier is allowed to sit. */
const AGE_CLAIM_WINDOW = 80;

/**
 * The age phrase this description actually states, preferring a stated NUMBER over a bare
 * audience word — but only when the number is the programme's own age, and only when the
 * description states ONE of them.
 *
 * Deliberately shaped as an exception to the old behaviour rather than a new precedence
 * order, because that makes the blast radius provable rather than argued: the leftmost
 * match is still what this returns unless it is a bare keyword AND exactly one qualified
 * number exists elsewhere. A description that yields nothing today still yields nothing (no
 * pattern was added), and a description whose leftmost match is already a number is
 * untouched (only the keyword branch can be overridden).
 *
 * WHY "EXACTLY ONE", AND WHAT IT COSTS: two different stated ranges in one description is
 * not a precedence problem, it is a description that does not state a single programme age —
 * `Youth Gym Drop-In` runs "Younger youth, aged 11-13 years … 3:30pm - 5pm. Older youth, aged
 * 13-18 years … 5:00pm - 7:45pm", i.e. genuinely 11–18 in two sittings. Taking whichever
 * range came first publishes 11–13 and drops the 14–18s; taking the word publishes 12–18 and
 * drops the 11s. Both are wrong, so this returns the existing answer and leaves the record
 * alone rather than trading one wrong band set for another. Measured: 26 distinct programmes
 * qualify at all and exactly ONE (6 records) states more than one range, so this rule costs
 * no recovery and removes the only change in the set that was not a strict improvement.
 * Resolving that record properly needs a union-of-ranges capability this adapter does not
 * have and should not grow here.
 */
interface AgeCandidate {
  /** The matched phrase, as the source spelled it. */
  text: string;
  index: number;
  /** A bare audience WORD ("youth") rather than a stated NUMBER ("6-12 years"). */
  isKeyword: boolean;
}

/** Every age phrase in the text, in document order, numbers and words together. */
function ageCandidates(description: string): AgeCandidate[] {
  const found: AgeCandidate[] = [];
  AGE_PHRASE_SCAN_RE.lastIndex = 0;
  for (let m = AGE_PHRASE_SCAN_RE.exec(description); m; m = AGE_PHRASE_SCAN_RE.exec(description)) {
    found.push({ text: m[0], index: m.index, isKeyword: AGE_PHRASE_IS_KEYWORD_RE.test(m[0]) });
  }
  return found;
}

/**
 * Is this phrase the programme's own age, or a rule about someone else?
 *
 * THE ASYMMETRY THIS REMOVES WAS THE DEFECT. AGE_CLAIM_DISQUALIFIER_RE used to be consulted
 * only for phrases competing to OVERRIDE a leading keyword — so whatever was returned by the
 * two fallback paths was returned unvetted, and both paths were live in production:
 *
 *   • a bare word: "All ages programs, children 6-12 years must be accompanied by a
 *     participating adult." published [0, infinity) + all five bands on adult Tai Chi, Tae Kwon
 *     Do, bootcamp and 19+/50+ martial-arts listings. The same sentence's own number was
 *     CORRECTLY discarded as a supervision rule while the word four tokens earlier was trusted.
 *   • a bare number: the identical sentence with no audience word in front of it —
 *     "Children 6-12 years must be accompanied by a participating adult." — published ages
 *     6-12 on an adults-only class, because a numeric leftmost match returned immediately.
 *     The disqualifier had simply never run on that path; its protection was incidental on a
 *     keyword happening to sit earlier in the paragraph.
 *
 * One rule for every candidate is the root-cause fix: evidence is evidence regardless of shape.
 */
function isQualifiedClaim(description: string, candidate: AgeCandidate): boolean {
  const window = description.slice(
    Math.max(0, candidate.index - AGE_CLAIM_WINDOW),
    candidate.index + candidate.text.length + AGE_CLAIM_WINDOW
  );
  return !AGE_CLAIM_DISQUALIFIER_RE.test(window);
}

function statedAgePhrase(description: string): string | undefined {
  const qualified = ageCandidates(description).filter((c) => isQualifiedClaim(description, c));
  const first = qualified[0];
  if (!first) return undefined;
  if (!first.isKeyword) return first.text;

  // A stated NUMBER beats the vaguer word that came first — but only when the description
  // states exactly ONE. Two different ranges is not a precedence problem, it is a description
  // that does not state a single programme age ("Younger youth, aged 11-13 ... Older youth,
  // aged 13-18"), and picking either one drops real children. Keyed on the claim rather than
  // the spelling, so one age repeated is still one age.
  const stated = new Map<string, string>();
  for (const c of qualified) {
    if (c.isKeyword) continue;
    stated.set(c.text.toLowerCase().replace(/\s+/g, ''), c.text);
    if (stated.size > 1) return first.text;
  }
  return stated.size === 1 ? [...stated.values()][0] : first.text;
}

/** A number that is plausibly an AGE. The guards are worker/core/age.ts's, and for its
 *  reasons: a clock time ("6:00-8:00"), a decimal skill rating ("3.0-4.0") and a price
 *  ("$5+") are all numbers in rec-centre titles that are not ages, and reading them as ages
 *  is a defect that module already paid for twice. Kept local rather than exported from
 *  there because this copy also excludes a leading `$`; widening the shared guard would
 *  change parseAgeText for every adapter, which is not this change. */
const AGE_NUMBER = /(?<![\d.,:$])\d{1,2}(?![.,:]\d)/.source;

/** The age UNIT this platform writes between the number and its connector: "8yrs+",
 *  "Ball Hockey - Men (40yrs+)", "Parent and Tot Gym (6 mo-5 yrs)", "(18mo-3yrs)". Optional,
 *  because the bare forms ("19+", "13-18") are just as common. */
const AGE_UNIT = '(?:\\s*(?:yrs?|years?|mos?|months?))';

/**
 * Does the TITLE itself state an age?
 *
 * A title is an activity NAME, and a name is not an age claim: "Youth Basketball" says what
 * the drop-in is called, not who may attend. Titles that genuinely assert an age do exist on
 * this platform and are used — "Youth (13-18yrs) Open Gym", "Play Palace - 0-12 yrs",
 * "Adult Open Gym (19+)" — so the disqualifier is the age-adjacent WORD, not the title.
 * Explicit numeric ranges and minimums pass; "Youth"/"Baby"/"Family"/"Preschool" do not.
 *
 * "ALL AGES" NO LONGER PASSES, AND THAT IS THE SECOND HALF OF THE SAME LESSON. It was
 * admitted here on the reasoning that a venue naming the claim in its own activity title is
 * making the claim itself. Measured against the source's own age field, that reasoning failed
 * every time it mattered:
 *   Ukulele - Jam Circle (All ages)           source: 55+        a SENIORS group
 *   Music with Marnie All Ages/Siblings       source: under 6
 *   Reserve In Advance: Table Tennis All Ages source: varies     ONE generic booking-category
 *                                                               title across individually
 *                                                               age-gated sessions (670 rows)
 * Three cases where the title manufactured a false claim; ZERO where it was the only thing
 * producing a correct one — |Public Skate| is genuinely all-ages and its title never said so,
 * it is confirmed by the structured field. So an all-ages claim now requires that structured
 * confirmation, and a failed lookup degrades to NO CLAIM (age-unconfirmed, still reachable in
 * search) rather than to "suitable for a newborn". Making the FALLBACK safe is the fix;
 * making verification more reliable never could be, because verification can always fail.
 *
 * THE UNIT IS OPTIONAL AND THAT IS THE POINT. The first version of this gate required the
 * number to be IMMEDIATELY followed by its `+` or `-`, so a unit token in between defeated it:
 * `8+` passed and `8yrs+` — the reported example — did not. Measured on 17,209 live records
 * (Vancouver + Burnaby, 2026-08-18): 86 records across 16 programmes state an age in the
 * title that the gate rejected, among them "Parent and Tot Gym (6 mo-5 yrs)", published as
 * 1–3 years off the word "Toddlers" in its description while its own name said 6 months to 5.
 */
const TITLE_STATES_AGE_RE = new RegExp(
  `\\bages?\\s*\\d|${AGE_NUMBER}${AGE_UNIT}?\\s*\\+` +
    `|${AGE_NUMBER}${AGE_UNIT}?\\s*(?:-|–|—|to)\\s*${AGE_NUMBER}${AGE_UNIT}?`,
  'i'
);

/** A number range introduced by a month name is a DATE. Anchored on `\b` after the month
 *  specifically: the unanchored draft read "Novice" as "Nov" and threw away
 *  "Wushu Beginner/Novice 15+". */
const TITLE_DATE_RE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?\s*\d/i;

/** A number range introduced by a grade label is a GRADE. Grades are not ages and the shared
 *  normaliser cannot rescue them here — `parseAgeText('grade 4-7')` returns ages 4–8, because
 *  its RANGE_RE reaches the bare `4-7` before its GRADE_RE can convert. Refusing the title is
 *  this adapter's business; that core defect is logged separately and is not fixed by faking a
 *  conversion at the call site. */
const TITLE_GRADE_LABEL_RE = /\b(?:gr\.?|grades?)\s*[k0-9]/i;

/**
 * The gate, plus the two things that look like an age range and are not.
 *
 * MEASURED (same 17,209 records): the gate above, unguarded, publishes
 * "Art of Tennis Summer Camp - Aug 17-21" as ages 17–22 and "Future Bounce Basketball
 * (Gr. 6-7)" as ages 6–8 — 14 records across 3 programmes asserting an age from a date or a
 * school grade. That is the same class of false claim this gate exists to remove, so it is
 * removed here rather than left for the normaliser, which cannot see the difference.
 *
 * The veto is on the WHOLE TITLE, not just the matched span, and that is deliberate: what
 * extractAgeText hands downstream is the whole title (see its note), so one date anywhere in
 * it is live — "Summer Camp Aug 5-9 (6-12yrs)" resolves to ages 5–10 off the DATE even though
 * the real age is right there in the same string. Measured cost of the blunt form: nil. Only
 * 90 of 17,209 records carry a month or grade token at all, and the 14 above are the only ones
 * the gate ever admitted.
 */
function titleStatesAge(title: string): boolean {
  if (!TITLE_STATES_AGE_RE.test(title)) return false;
  return !TITLE_DATE_RE.test(title) && !TITLE_GRADE_LABEL_RE.test(title);
}

/**
 * Capture the age WORDING this event actually states. Both halves must be evidence.
 *
 * THE TITLE USED TO BE INCLUDED UNCONDITIONALLY, which manufactured an age claim out of an
 * activity name whenever the description said nothing about age. Measured on the captured
 * fixtures before this fix: 33 of 33 events emitted `ageText` — every single one, because the
 * title always went in — and 23 of those resolved to CONFIDENT bands downstream. Among them
 * "Play Palace - Baby Time" published as under-2s and "Family Play Time" as all five bands,
 * neither description saying anything about age. That is not a captured claim, it is an
 * inference from a kid-coded title marker — the same inference measured at a 57% band-error
 * rate and removed elsewhere in this system — and `parseAgeText` cannot tell the difference,
 * because by the time the string reaches it the title looks exactly like quoted source
 * wording. It resolves, marks `resolved: true`, writes `occurrence_age` bounds, matches bands
 * and records an `age_min_months` provenance fact pointing at a page that never said it.
 *
 * So the title now has to earn its place the same way the description does.
 */
export function extractAgeText(event: ActiveNetEvent): string | undefined {
  const title = (event.title ?? '').trim();
  const phrase = statedAgePhrase(stripHtml(event.description));
  // Whole title, not just the matched phrase: when a title DOES state an age, the surrounding
  // words are the context parseAgeText's own rules read ("(6-13 with adult)", "0-12 yrs"), and
  // clipping to the bare match would change how those resolve.
  const titleClaim = titleStatesAge(title) ? title : undefined;
  const parts = [titleClaim, phrase].filter(Boolean);
  return parts.length ? parts.join(' — ') : undefined;
}

/** The wording that puts an all-ages claim in play. Intentionally the loose, colloquial form —
 *  this selects what to VERIFY, so a false positive costs one cached request while a false
 *  negative costs a wrong age on a child-facing listing. */
const ALL_AGES_MENTION_RE = /\ball[-\s]?ages?\b/i;

/**
 * Is an all-ages claim IN PLAY for this event — either about to be published, or refused?
 *
 * This gates the source lookup, and it is deliberately wider than "we are about to claim
 * all-ages". Both sides of that line are wrong often enough to be worth one cached request:
 *
 *   • ABOUT TO CLAIM. The title says "all ages", so the attributability carve-out publishes
 *     [0, infinity). Measured wrong on real listings — "Ukulele - Jam Circle (All ages)" is a
 *     55+ seniors group, "Music with Marnie All Ages/Siblings" is under-6s.
 *   • ABOUT TO REFUSE. Only the description says it, so nothing is published. Correct for the
 *     19+ karate class; a needless loss for |Public Skate|, which really is all-ages and is
 *     120 of the 227 affected occurrences.
 *
 * One field settles both, so the gate covers both. Every other event — the overwhelming
 * majority, whose copy never mentions age at all — costs nothing.
 */
export function allAgesInPlay(event: ActiveNetEvent): boolean {
  return ALL_AGES_MENTION_RE.test(`${event.title ?? ''} ${stripHtml(event.description)}`);
}

// ── category ────────────────────────────────────────────────────────────────────────

/** Calendar names are a clean, structured category signal on this platform — far better
 *  than a title keyword scan. Only unambiguous mappings; anything else is left undefined
 *  so worker/core/taxonomy.ts runs its own title rules (deterministic-first, no fork). */
const CALENDAR_CATEGORY_RULES: Array<{ re: RegExp; key: string }> = [
  { re: /public\s+swim|swim/i, key: 'public_swim' },
  { re: /skat(?:e|ing)/i, key: 'skate' },
  { re: /open\s+gym/i, key: 'open_gym' },
  { re: /play\s+palace|parent\s+and\s+tot/i, key: 'indoor_play' },
];

export function categoryHintForCalendar(calendarName: string | undefined): string | undefined {
  if (!calendarName) return undefined;
  return CALENDAR_CATEGORY_RULES.find((r) => r.re.test(calendarName))?.key;
}

// ── occurrence identity ─────────────────────────────────────────────────────────────

export function occurrenceRecordId(event: ActiveNetEvent, centreId: number): string {
  const facilities = (event.facilities ?? [])
    .map((f) => f.facility_id)
    .filter((n): n is number => Number.isFinite(n))
    .sort((a, b) => a - b)
    .join('-');
  const start = (event.start_time ?? '').replace(/[^0-9]/g, '');
  return [event.event_item_id ?? 'noid', start, centreId, facilities || 'nofac'].join(':');
}

// ── the parse ───────────────────────────────────────────────────────────────────────

/** Facility-closure notices are published as events on this platform ("CLOSED - Play
 *  Palace - CLEANING BREAK", 27 in the Vancouver capture). They are not activities and
 *  must not be listed as such. They are COUNTED (skippedClosures) rather than silently
 *  dropped. */
const CLOSURE_TITLE_RE = /^\s*(?:closed|cancell?ed)\b|\bcancell?ed\s*$/i;

export interface ParseOptions {
  /** Client-side date window (inclusive, YYYY-MM-DD LOCAL). Required because the
   *  vendor's own start_date/end_date parameters are ignored server-side. */
  window?: { startDate: string; endDate: string };
}

export interface ParseResult {
  records: StructuredRecord[];
  /** Honest per-run accounting — feeds the coverage report and health check. */
  stats: {
    eventsSeen: number;
    recordsEmitted: number;
    skippedClosures: number;
    skippedOutsideWindow: number;
    skippedNoStartTime: number;
    skippedUnparseableTime: number;
    centreSentinelsStripped: number;
    costStatusCounts: Record<string, number>;
    ageTextPresent: number;
  };
  warnings: string[];
}

function emptyStats(): ParseResult['stats'] {
  return {
    eventsSeen: 0,
    recordsEmitted: 0,
    skippedClosures: 0,
    skippedOutsideWindow: 0,
    skippedNoStartTime: 0,
    skippedUnparseableTime: 0,
    centreSentinelsStripped: 0,
    costStatusCounts: { free: 0, known: 0, check_source: 0, unknown: 0 },
    ageTextPresent: 0,
  };
}

function parseCentreGroup(
  tenant: ActiveNetTenantConfig,
  calendar: Pick<CalendarFetchResult, 'calendarId' | 'calendarName'>,
  group: ActiveNetCentreEvents,
  opts: ParseOptions,
  stats: ParseResult['stats'],
  warnings: string[]
): StructuredRecord[] {
  const records: StructuredRecord[] = [];
  const rawCentreName = group.center_name ?? '';
  const centreName = stripCentreSentinel(rawCentreName);
  if (rawCentreName.startsWith('*')) stats.centreSentinelsStripped += 1;
  const categoryHint = categoryHintForCalendar(calendar.calendarName);

  for (const event of group.events ?? []) {
    stats.eventsSeen += 1;

    if (CLOSURE_TITLE_RE.test(event.title ?? '')) {
      stats.skippedClosures += 1;
      continue;
    }
    const localStart = event.start_time;
    if (!localStart) {
      stats.skippedNoStartTime += 1;
      continue;
    }
    const localDate = localStart.slice(0, 10);
    if (opts.window && (localDate < opts.window.startDate || localDate > opts.window.endDate)) {
      stats.skippedOutsideWindow += 1;
      continue;
    }
    const startDatetimeUtc = zonedLocalToUtcIso(localStart, tenant.timezone);
    if (!startDatetimeUtc) {
      stats.skippedUnparseableTime += 1;
      warnings.push(`calendar ${calendar.calendarId}: unparseable start_time "${localStart}"`);
      continue;
    }
    const endDatetimeUtc = zonedLocalToUtcIso(event.end_time, tenant.timezone);

    const cost = classifyCost(event);
    stats.costStatusCounts[cost.costStatus] = (stats.costStatusCounts[cost.costStatus] ?? 0) + 1;

    const ageText = extractAgeText(event);
    if (ageText) stats.ageTextPresent += 1;

    // Prefer the facility's own centre label (it is per-facility and can differ from the
    // group label); fall back to the group, then to the free-text location description.
    const facilityCentre = stripCentreSentinel(event.facilities?.[0]?.center_name);
    const venueName = facilityCentre ?? centreName ?? stripCentreSentinel(event.activity_location_desc);

    records.push({
      sourceRecordId: occurrenceRecordId(event, group.center_id),
      title: (event.title ?? '').trim() || 'Drop-in activity',
      venueName,
      venueMunicipalityName: venueName ? tenant.municipality : undefined,
      startDatetimeUtc,
      endDatetimeUtc,
      costMinCad: cost.costMinCad,
      costMaxCad: cost.costMaxCad,
      costStatus: cost.costStatus,
      ageText,
      categoryHint,
      sourceUrl: event.activity_detail_url || calendarPageUrl(tenant),
      raw: event,
    });
    stats.recordsEmitted += 1;
  }
  return records;
}

/** Parse one tenant's fetched calendars into canonical records. Venue address/phone are
 *  attached separately by venues.ts (one batched centerdetails call per run). */
export function parseTenantCalendars(
  tenant: ActiveNetTenantConfig,
  calendars: CalendarFetchResult[],
  opts: ParseOptions = {}
): ParseResult {
  const stats = emptyStats();
  const warnings: string[] = [];
  const records: StructuredRecord[] = [];

  for (const calendar of calendars) {
    for (const group of calendar.centreEvents) {
      records.push(...parseCentreGroup(tenant, calendar, group, opts, stats, warnings));
    }
    if (calendar.occurrenceCount === 0) {
      // Reported as data, not absence — a calendar that returns nothing is a finding.
      warnings.push(
        `calendar ${calendar.calendarId} (${calendar.calendarName ?? 'unnamed'}) returned zero occurrences`
      );
    }
  }

  return { records, stats, warnings };
}
