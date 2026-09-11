// lib/sms/message.ts — turn a decided outcome into the actual text a parent receives.
//
// DRAFT (SMS pivot). Pure: strings in, strings out. The counterpart of lib/email/render.ts, and
// pure for the same reason — the exact wording of a commercial electronic message is the thing a
// CASL complaint is about, so it has to be assertable in a test without a network.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE FINDING THAT SHAPED THIS FILE: PUNCTUATION IS A COST CONTROL
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// An SMS is encoded in GSM-7 (160 characters per segment, 153 each when concatenated) if every
// character is in the GSM 03.38 alphabet, and in UCS-2 (**70** per segment, 67 concatenated) if
// even ONE character is not. There is no middle setting and no partial penalty: one curly
// apostrophe more than halves the payload of every segment in the message.
//
// The characters that do this are exactly the ones a careful writer reaches for:
//     —  em dash          ’  curly apostrophe        “ ”  curly quotes
//     –  en dash          …  ellipsis                 ' '  curly single quotes
//
// PRD §2.6's empty-week example contained an EM DASH. That one character is the whole finding —
// rendered verbatim the message is 143 characters, which is one GSM-7 segment or **THREE** UCS-2
// ones. Same words, three times the per-subscriber cost, every week, forever.
//
// (Precision, because an earlier draft of this comment overstated it: the copy contained an em
// dash and NOT curly apostrophes — its apostrophes were already straight. The em dash alone is
// sufficient; a single character outside the alphabet converts the entire message. The PRD's
// message examples have since adopted the ASCII form, so the copy of record is now safe and this
// file is what keeps it that way.)
//
// SO THE TEMPLATES BELOW ARE WRITTEN IN GSM-7-SAFE ASCII. The substitutions are mechanical and
// semantically identical: em dash becomes " - ", curly apostrophes and quotes become straight
// ones, ellipsis becomes "...". Nothing else about §2.6's wording is changed.
//
//   !! THIS IS A DEVIATION FROM THE PRD'S LITERAL COPY, MADE BY THE IMPLEMENTER, AND IT NEEDS
//   !! CONFIRMATION. It is a typographic change, not an editorial one — but it is still a change
//   !! to approved consumer-facing copy, and it should be a decision rather than something that
//   !! happened. `assertGsm7Safe` and the segment counts below are how it stays true afterwards.
//
// `estimateSegments` is exported and reported on every send so the cost is observable rather
// than inferred: if a future copy edit reintroduces a curly quote, the segment count in the send
// log triples on the same day and somebody can see it.

import { toVancouverParts } from '@/lib/search/time/vancouver';

/**
 * The GSM 03.38 basic character set — one septet each.
 *
 * Transcribed from the standard rather than approximated.
 */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_SET: ReadonlySet<string> = new Set(GSM7_BASIC.split(''));

/**
 * The GSM 03.38 EXTENSION table — still GSM-7, but TWO septets each (an ESC prefix).
 *
 * ── A CORRECTION TO THIS FILE'S OWN EARLIER IMPLEMENTATION ──────────────────────────────
 * Round 4 deliberately left these out of the set entirely, with a comment saying they "are
 * encodable, but each one costs TWO characters of the budget, which makes them a trap rather than
 * a saving." The reasoning about cost was right; leaving them out of the SET was not, because it
 * made `isGsm7` conflate two different things — "not in the basic table" and "forces UCS-2". A
 * message containing `~` is GSM-7 with one double-width character, NOT a UCS-2 message, and the
 * old code reported it as UCS-2 at 70 characters per segment and would have had `assertGsm7Safe`
 * reject perfectly sendable copy.
 *
 * That surfaced the moment PRD §2.6's approved welcome text — "land Friday ~4pm" — was
 * implemented: the guard rejected Jon's own wording for a reason that was not true.
 *
 * The round-4 FINDING is unaffected: an em dash is in NEITHER table, so UCS-2 was and is the
 * correct verdict for it, and the 3-segments-vs-1 measurement stands. Only these nine characters
 * were misclassified.
 */
const GSM7_EXTENDED_SET: ReadonlySet<string> = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€']);

/** Septets this character costs, or 0 if it is not GSM-7 encodable at all. */
function septetCost(ch: string): number {
  if (GSM7_SET.has(ch)) return 1;
  if (GSM7_EXTENDED_SET.has(ch)) return 2;
  return 0;
}

/** Characters per segment, single message and concatenated, for each encoding. */
const GSM7_SINGLE = 160;
const GSM7_CONCAT = 153;
const UCS2_SINGLE = 70;
const UCS2_CONCAT = 67;

export type SmsEncoding = 'GSM-7' | 'UCS-2';

/**
 * Is every character in this string GSM-7 encodable at all — basic table OR extension table?
 *
 * TRUE does not mean "one septet each": see `septetLength`. It means the message does not have to
 * fall back to UCS-2, which is the expensive cliff.
 */
export function isGsm7(text: string): boolean {
  for (const ch of text) if (septetCost(ch) === 0) return false;
  return true;
}

/** The characters in this string that would force the whole message to UCS-2. Diagnostic. */
export function nonGsm7Characters(text: string): string[] {
  const bad = new Set<string>();
  for (const ch of text) if (septetCost(ch) === 0) bad.add(ch);
  return [...bad];
}

/**
 * The GSM-7 length in SEPTETS, which is what the segment budget is actually measured in — an
 * extension-table character occupies two of them. Returns the plain character count for text that
 * is not GSM-7 at all, where septets are not the unit anyway.
 */
export function septetLength(text: string): number {
  let total = 0;
  for (const ch of text) {
    const cost = septetCost(ch);
    if (cost === 0) return [...text].length;
    total += cost;
  }
  return total;
}

export interface SegmentEstimate {
  encoding: SmsEncoding;
  characters: number;
  segments: number;
}

/**
 * How many segments this body costs, and why.
 *
 * An ESTIMATE, and named one: the carrier is the authority, and Twilio's own segmentation can
 * differ at the margin (national language shift tables, for instance). It is exact for the ASCII
 * copy this product actually sends, and its job is to make a regression VISIBLE — a message that
 * silently went from 1 segment to 3 is the failure mode worth catching.
 */
export function estimateSegments(body: string): SegmentEstimate {
  const gsm7 = isGsm7(body);
  // SEPTETS, not characters, for GSM-7 — an extension-table character such as `~` occupies two of
  // them, so a message can exceed the segment budget while looking short.
  const characters = gsm7 ? septetLength(body) : [...body].length;
  const single = gsm7 ? GSM7_SINGLE : UCS2_SINGLE;
  const concat = gsm7 ? GSM7_CONCAT : UCS2_CONCAT;
  const segments = characters <= single ? 1 : Math.ceil(characters / concat);
  return { encoding: gsm7 ? 'GSM-7' : 'UCS-2', characters, segments };
}

/**
 * Throw if a body would be sent as UCS-2.
 *
 * Used by the tests rather than by the send path, deliberately: a real send must not fail
 * because someone typed a nicer dash, it must merely be visible that they did. The test is where
 * this becomes a wall.
 */
export function assertGsm7Safe(body: string): void {
  if (isGsm7(body)) return;
  throw new Error(
    `message would be sent as UCS-2 (70 chars/segment instead of 160) because of: ${nonGsm7Characters(body).join(' ')}`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// NORMALISING THIRD-PARTY TEXT — the same substitution the templates got, applied at render time
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// The round-4 finding at the top of this file was acted on by rewriting THIS FILE'S OWN TEMPLATES
// in ASCII. That fixed every string somebody in this repo types, and none of the strings a
// municipality types.
//
// Activity and venue names arrive from third-party catalogues and are printed verbatim into the
// weekly message. The real Richmond PerfectMind fixture carries EN DASHES in eight name-like
// strings — "Westwind School - Gymnasium – Court 1", "BADMINTON BOOKING - COURT 2 – ADULTS" — and
// ONE of those in ONE pick converts the ENTIRE message to UCS-2. Measured against the live test
// send, with the production encoder below: 508 septets / 4 segments clean, 535 characters /
// 8 segments with one poisoned venue name substituted in. Exactly double the bill, for a character
// nobody in this product chose and no parent can see.
//
// `assertGsm7Safe` does not catch this and was never meant to: it is a TEST-time wall over copy
// THIS REPO AUTHORS. A catalogue name is not copy this repo authors, and it changes without a
// commit.
//
// ── IT NORMALISES, IT DOES NOT REJECT ───────────────────────────────────────────────────
// That is the posture `assertGsm7Safe`'s own comment already takes: *"a real send must not fail
// because someone typed a nicer dash, it must merely be visible that they did."* A rejecter here
// would drop a real activity out of a real parent's Friday text because a Richmond scheduler
// pressed a nicer hyphen — spending the product to enforce a typography rule. The substitutions
// below are the SAME mechanical, semantically-identical ones round 4 applied to §2.6 by hand.
//
//   !! LAYER 2 (the diacritic fold) AND LAYER 3 (leave it) ARE IMPLEMENTER DECISIONS AND ARE
//   !! FLAGGED AS SUCH, in the same posture as the round-4 ASCII substitution. See each below.

/**
 * LAYER 1 — the six known offenders, mapped to the ASCII round 4 already chose.
 *
 * These six are not a guess: they are the exact set `tests/sms/weekly_send.test.ts` already pins
 * in *"detects the punctuation that silently more than halves a segment"*, and the exact set this
 * file's own header names as *"the characters a careful writer reaches for"*. U+2018 is added to
 * them because the header names curly single quotes as a PAIR and handling only the closing one
 * would be a gap rather than a decision.
 *
 * The em dash maps to a BARE hyphen, not to " - ": in every real occurrence the dash already
 * carries its own surrounding spaces ("this week — check back"), so adding more would double
 * them. Round 4's comment describes the RESULT (" - "), not the replacement string.
 */
const GSM7_SUBSTITUTIONS: ReadonlyMap<string, string> = new Map([
  ['\u2014', '-'], // U+2014 em dash
  ['\u2013', '-'], // U+2013 en dash            ← the one that is actually in the live catalogue
  ['\u2019', "'"], // U+2019 curly apostrophe / right single quote
  ['\u2018', "'"], // U+2018 left single quote
  ['\u201C', '"'], // U+201C left double quote
  ['\u201D', '"'], // U+201D right double quote
  ['\u2026', '...'], // U+2026 ellipsis
]);

/**
 * Invisible characters, which are worse than the visible ones.
 *
 * A non-breaking space is the single most common artefact of scraping a municipal web page, it is
 * NOT in GSM 03.38, and it is indistinguishable from a space on every screen it will ever appear
 * on — so it can double the cost of a send with literally nothing to see in the diff. Mapping it
 * to the space it is already pretending to be involves no judgement at all. Zero-width characters
 * go to nothing for the same reason: they say nothing and cost everything.
 *
 * -- THE KEYS ARE ESCAPES, AND THAT IS NOT A STYLE CHOICE ------------------------------
 * Written as the characters themselves, four of these eight entries read as `[' ', ' ']` on
 * every screen: identical to each other and to a plain space. Nobody can review that, they
 * can only trust the trailing comment. Worse, a key flattened to a plain space in transit
 * would turn its entry into a harmless-looking identity mapping, and THAT character would
 * silently stop being normalised with every test still green.
 *
 * That is the very failure this map exists to prevent, so it may not be committed in the
 * form it warns about. `tests/sms/source_hygiene.test.ts` enforces it for the whole file.
 */
const GSM7_INVISIBLE_SUBSTITUTIONS: ReadonlyMap<string, string> = new Map([
  ['\u00A0', ' '], // no-break space
  ['\u2007', ' '], // figure space
  ['\u2009', ' '], // thin space
  ['\u202F', ' '], // narrow no-break space
  ['\u200B', ''], // zero-width space
  ['\u200C', ''], // zero-width non-joiner
  ['\u200D', ''], // zero-width joiner
  ['\uFEFF', ''], // byte-order mark / zero-width no-break space
]);

/**
 * LAYER 2 — strip the accent from a letter GSM-7 cannot carry, and ONLY then.
 *
 * GSM 03.38 carries a specific and lopsided set of accented letters: è é ù ì ò Ç Å å Ä Ö Ñ Ü ä ö
 * ñ ü à are in it, and â ê î ô û á í ó ú ç ō are not. So "Café" is already free and "Français"
 * costs 2.28× — a distinction no reader could predict and no writer intended.
 *
 * This decomposes such a letter and drops its combining marks: c-cedilla to c, â → a, Senáḵw → Senakw.
 *
 *   !! THIS IS A CHANGE TO HOW A NAME IS SHOWN TO A PARENT, not a typographic tidy, and it wants
 *   !! the same confirmation the round-4 substitution wanted. It fires ONLY where the alternative
 *   !! is more than doubling the cost of that subscriber's message, and it is deliberately last
 *   !! rather than a blanket ASCII fold — a letter GSM-7 can carry keeps its accent exactly.
 */
function foldUnsupportedDiacritic(ch: string): string {
  const folded = ch.normalize('NFD').replace(/\p{M}+/gu, '');
  // `folded` is EMPTY when `ch` was itself a lone combining mark — the tail of a cluster whose
  // base letter GSM-7 could carry and has already been emitted, as in "Senáḵw", where no
  // precomposed form exists to normalise to. Dropping it is the whole point, and `isGsm7('')` is
  // true, so the guard below already says so; it must not be special-cased back into the string.
  return isGsm7(folded) ? folded : ch;
}

/**
 * The GSM-7-safe form of a string that this product did not write.
 *
 * Apply to CATALOGUE-SOURCED text — activity names, venue names, area labels — not to URLs, which
 * are ASCII by construction and which a substitution could only break.
 *
 * LAYER 3 IS "LEAVE IT". A character that survives all three layers — a CJK venue name, an emoji
 * in an activity title — is returned untouched, and the message goes out as UCS-2 exactly as it
 * does today. That is deliberate: replacing it would hand a parent an unreadable name, which is a
 * worse product than an expensive message, and `estimateSegments` is reported on every send so
 * the cost stays visible rather than silent. `nonGsm7Characters` names the survivor for whoever
 * looks. A caller that would rather drop such a pick than pay for it can ask `isGsm7` after this
 * and decide — this function does not decide for them.
 */
export function normalizeForGsm7(text: string): string {
  let out = '';
  // NFC FIRST, so a DECOMPOSED letter is judged as the letter it is. GSM 03.38 carries é, and a
  // catalogue that spells it "e" + U+0301 would otherwise lose the accent to layer 2 for no
  // reason. NFC is the identity on ASCII, so nothing this product writes is touched.
  for (const ch of text.normalize('NFC')) {
    const substitution = GSM7_SUBSTITUTIONS.get(ch) ?? GSM7_INVISIBLE_SUBSTITUTIONS.get(ch);
    if (substitution !== undefined) {
      out += substitution;
      continue;
    }
    out += septetCost(ch) === 0 ? foldUnsupportedDiacritic(ch) : ch;
  }
  return out;
}

export interface RenderedMessage {
  body: string;
  encoding: SmsEncoding;
  characters: number;
  segments: number;
}

function render(body: string): RenderedMessage {
  const estimate = estimateSegments(body);
  return { body, ...estimate };
}

/** Brand tag opening every outbound message (PRD §1.4 sender identification). */
const BRAND = 'KIDS FUN:';
/** Free-of-charge opt-out instruction, required on every commercial message (PRD §1.4). */
const STOP_LINE = 'Reply STOP to end';

/**
 * The one clause that points somebody with no subscription at the form.
 *
 * Shared by the unknown-keyword reply and the START invite rather than written twice: they are
 * the two messages that can reach a number with no `sms_consent` row, and "where do I sign up"
 * must not have two different answers depending on which word the person happened to text.
 */
function signupClause(signupUrl: string): string {
  return `Not signed up? ${signupUrl}`;
}

const SHORT_WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * "Sat" — the Vancouver-local weekday a pick falls on, or null for a dateless open-hours
 * listing (an aquarium is on every day, and printing a day for it would invent one).
 */
export function weekdayLabel(startDatetimeUtc: string | null | undefined): string | null {
  if (!startDatetimeUtc) return null;
  const parsed = new Date(startDatetimeUtc);
  if (Number.isNaN(parsed.getTime())) return null;
  return SHORT_WEEKDAY[toVancouverParts(parsed).weekday];
}

/** A pick that is NAMED in the body but carries no link of its own. */
export interface NamedPick {
  /** Activity name, as the catalogue holds it. */
  name: string;
  /** UTC ISO start of the first slot, for the day grouping. Null for open-hours. */
  startDatetimeUtc: string | null;
}

/** One line of the weekly message: a pick with its own short link. */
export interface MessagePick extends NamedPick {
  /** Venue name, printed in brackets. Omitted when the catalogue has none. */
  venue: string | null;
  /** The absolute short link for this pick. */
  url: string;
}

/**
 * The dials this renderer's LAYOUT has, separated from its COPY.
 *
 * ── WHY THIS IS A PARAMETER OBJECT AND NOT SIX CONSTANTS ────────────────────────────────
 * The 2026-09-10 format recommendation splits cleanly into changes that alter no word of PRD
 * §2.6 and changes that write new consumer-facing copy. The first kind is an implementer's call;
 * the second kind is Jon's, and three of them were with him when this was written. Rather than
 * building half the mechanism and leaving the other half as a redesign, every one of them is a
 * dial here — so answering a question is a one-line change to `WEEKLY_MESSAGE_FORMAT` and not a
 * change to the renderer.
 *
 * Each dial below records which of the two kinds it is.
 */
export interface WeeklyMessageFormat {
  /**
   * Print a day header (SAT / SUN) with a blank line between groups, instead of a "Sat: " prefix
   * on every pick. STRUCTURE — it re-arranges the day label that is already in the message.
   *
   * NOT BY VENUE, and that was a deliberate rejection rather than an option nobody weighed: venue
   * grouping only pays off for as long as the venue repetition exists, which is precisely what a
   * separate workstream is trying to eliminate. If that work lands, venue grouping degrades to ten
   * headers for ten venues. Day is orthogonal to selection and stays correct whatever the
   * selection algorithm does. See §7 of the recommendation.
   */
  groupByDay: boolean;
  /**
   * Break before every URL instead of leaving it at the end of the pick's sentence. STRUCTURE,
   * and measured at exactly zero cost — a newline and a space are one septet each. It is also the
   * rule this file already applies to every other template ("a link sitting mid-sentence is a
   * link that gets mis-tapped"); the weekly message was the one that did not follow it.
   */
  linkOnOwnLine: boolean;
  /**
   * Name the picks that did not get a link, in a comma run after "Also:".
   *
   * COPY — PENDING JON (recommendation §8 Q3: "are unlinked named picks acceptable?"). A parent
   * who spots one has to open the hub link to reach it; the alternative is today's behaviour,
   * where seven of ten picks have no day, no name and no venue at all. Off until he answers, and
   * the whole budget mechanism below is inert while it is off.
   */
  nameUnlinkedPicks: boolean;
  /**
   * The segment ceiling the named-pick fill may not cross.
   *
   * COST — PENDING JON (§8 Q1: spend the freed headroom on more visible picks at today's
   * 4-segment cost, or bank it as a ~25% cheaper 3-segment send). 4 keeps the current bill.
   *
   * A CEILING ON THE DISCRETIONARY PART ONLY. It never drops a linked pick and never truncates
   * the opener, the hub line or the STOP line — if those alone exceed it the message is sent over
   * budget and the send log says so, which is the honest failure. Naming is the thing that gives
   * way, because naming is the thing that was optional.
   */
  maxSegments: number;
  /**
   * Shorten a venue name for display.
   *
   * COPY — PENDING JON (§8 Q2: is "Roundhouse CC" acceptable in place of "Roundhouse Community
   * Arts and Recreation Centre"?). The recommendation measures a mean saving of 10.7 characters
   * per venue across the real ActiveNet corpus and a maximum of 34, which is the single largest
   * character saving available anywhere in the message.
   *
   * IT IS A HOOK AND NOT A RULESET ON PURPOSE. The abbreviations themselves are the thing Jon has
   * to approve, so inventing them here would be answering his question on his behalf. Identity
   * until he answers; a real shortener drops in without touching this file.
   */
  shortenVenue: (venue: string) => string;
}

/**
 * The live dial settings. STRUCTURE ON, COPY OFF — see each field above.
 *
 * The two `true`s change no word of §2.6. The three defaults below them are Jon's three open
 * questions, parked at today's behaviour so that this file cannot answer them by accident.
 */
export const WEEKLY_MESSAGE_FORMAT: WeeklyMessageFormat = {
  groupByDay: true,
  linkOnOwnLine: true,
  // JON'S Q1 ANSWER, 2026-09-11: spend the freed headroom on showing MORE picks rather than
  // banking it as a cheaper send. Naming the unlinked picks is the only mechanism that shows more
  // than the three that get direct links, so answering Q1 that way decides this one with it.
  nameUnlinkedPicks: true,
  // The FULL budget, not the cheaper 3-segment cap -- which is what "more picks" means in
  // practice. Jon explicitly ruled out banking it.
  maxSegments: 4,
  // Q2 (venue abbreviation) is still genuinely open, so this stays identity. It costs named picks
  // -- see the measurements in weekly_format.test.ts -- but it does not block: the fill simply
  // names as many as fit. A later "yes" is this one line.
  shortenVenue: (venue) => venue,
};

export interface WeeklyMessageInput {
  /** Total picks selected — the number in the opener, INCLUDING the ones behind "+N more". */
  totalPicks: number;
  /** Age bands, already humanised ("2-4", "5-9"). Empty when no age was known. */
  ageLabels: readonly string[];
  /** The subscriber's area, e.g. "East Van". */
  areaLabel: string;
  /** The picks that get their own line and their own link (PRD §2.3: top 2-3). */
  directPicks: readonly MessagePick[];
  /**
   * The remaining picks, in rank order, as candidates to be NAMED without a link.
   *
   * A CANDIDATE LIST, NOT A DECISION: how many of them actually appear is computed from the
   * character budget, not passed in. The caller supplies everything it has and this renderer
   * spends what fits. Ignored entirely while `nameUnlinkedPicks` is off.
   */
  namedPickCandidates?: readonly NamedPick[];
  /** The subscriber's own preferences/hub URL — carries the rest and the CASL controls. */
  preferencesUrl: string;
  /** Layout overrides, merged over `WEEKLY_MESSAGE_FORMAT`. Tests and callers, not production. */
  format?: Partial<WeeklyMessageFormat>;
}

/** A day's worth of picks, in the order they will be printed. */
interface DayGroup {
  /** "SAT", or null for the dateless bucket — see `groupPicksByDay`. */
  header: string | null;
  /** Earliest start in the group, in ms. Sorts the groups. Infinity for the dateless bucket. */
  earliest: number;
  linked: MessagePick[];
  named: NamedPick[];
}

/**
 * Split picks into day groups, earliest day first.
 *
 * ── THE DATELESS BUCKET HAS NO HEADER, DELIBERATELY ─────────────────────────────────────
 * `weekdayLabel` returns null for an open-hours listing — an aquarium is on every day, and
 * printing "SAT" over it would invent a fact. Those picks are printed last, under no header at
 * all, which is exactly what they do today (they get no "Sat: " prefix either). A LABEL for that
 * bucket ("ANYTIME", "ALL WEEKEND") would be new consumer-facing copy and therefore Jon's, so
 * this renders the honest nothing rather than choosing a word for him.
 *
 * GROUPS ARE ORDERED CHRONOLOGICALLY, not by the rank of the first pick in each. A parent reading
 * SUN above SAT would be reading a bug. Rank still decides which picks are in the message and
 * which get links; it just stops deciding what order the DAYS come in. The rank itself is
 * untouched and is what `sms_send_log.picks_snapshot` records.
 */
function groupPicksByDay(linked: readonly MessagePick[], named: readonly NamedPick[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();

  const groupFor = (pick: NamedPick): DayGroup => {
    const header = weekdayLabel(pick.startDatetimeUtc)?.toUpperCase() ?? null;
    // A space cannot occur in a weekday label, so this key can never collide with a real day.
    const key = header ?? ' dateless';
    let group = groups.get(key);
    if (!group) {
      group = { header, earliest: Infinity, linked: [], named: [] };
      groups.set(key, group);
    }
    const started = pick.startDatetimeUtc ? Date.parse(pick.startDatetimeUtc) : NaN;
    if (!Number.isNaN(started)) group.earliest = Math.min(group.earliest, started);
    return group;
  };

  for (const pick of linked) groupFor(pick).linked.push(pick);
  for (const pick of named) groupFor(pick).named.push(pick);

  return [...groups.values()].sort((a, b) => a.earliest - b.earliest);
}

/** The opener, which every shape of this message shares. */
function weeklyOpener(input: WeeklyMessageInput): string {
  const ages = input.ageLabels.length > 0 ? ` for ages ${input.ageLabels.join(' & ')}` : '';
  const noun = input.totalPicks === 1 ? 'pick' : 'picks';
  const area = normalizeForGsm7(input.areaLabel);
  return `${BRAND} ${input.totalPicks} ${noun} this weekend${ages} near ${area}.`;
}

/** "Tai Chi Chuan - Beginners (Roundhouse CC)" — a linked pick's own line, without its URL. */
function pickHeadline(pick: MessagePick, format: WeeklyMessageFormat): string {
  const venue = pick.venue ? ` (${format.shortenVenue(normalizeForGsm7(pick.venue))})` : '';
  return `${normalizeForGsm7(pick.name)}${venue}`;
}

/**
 * One candidate body, with exactly `namedCount` of the unlinked picks named.
 *
 * Pure and cheap, because `renderWeeklyMessage` calls it once per candidate count and MEASURES
 * the result rather than predicting it — see there for why.
 *
 * EVERY CATALOGUE-SOURCED STRING GOES THROUGH `normalizeForGsm7` ON ITS WAY IN, and the URLs do
 * not: a short link and a preferences link are ASCII by construction, and a substitution applied
 * to one could only break a link that a parent then cannot tap.
 */
function composeWeeklyBody(
  input: WeeklyMessageInput,
  format: WeeklyMessageFormat,
  namedCount: number
): string {
  const named = (input.namedPickCandidates ?? []).slice(0, namedCount);
  const lines: string[] = [weeklyOpener(input)];

  if (format.groupByDay) {
    for (const group of groupPicksByDay(input.directPicks, named)) {
      // A blank line between groups — measured at +1 septet for the one the live week needs,
      // which makes it the cheapest structural separation on the list.
      if (lines.length > 1) lines.push('');
      if (group.header) lines.push(group.header);
      for (const pick of group.linked) {
        const headline = pickHeadline(pick, format);
        if (format.linkOnOwnLine) lines.push(headline, pick.url);
        else lines.push(`${headline} ${pick.url}`);
      }
      if (group.named.length > 0) {
        lines.push(`Also: ${group.named.map((p) => normalizeForGsm7(p.name)).join(', ')}`);
      }
    }
  } else {
    for (const pick of input.directPicks) {
      const day = weekdayLabel(pick.startDatetimeUtc);
      const headline = `${day ? `${day}: ` : ''}${pickHeadline(pick, format)}`;
      if (format.linkOnOwnLine) lines.push(headline, pick.url);
      else lines.push(`${headline} ${pick.url}`);
    }
    if (named.length > 0) {
      lines.push(`Also: ${named.map((p) => normalizeForGsm7(p.name)).join(', ')}`);
    }
  }

  // "+N more" counts the picks that are NOT IN THE TEXT — so naming one takes it out of the
  // count. It was only ever equal to "picks without a link" because those were the same set.
  const remaining = input.totalPicks - input.directPicks.length - named.length;
  const hubLabel = remaining > 0 ? `+${remaining} more & settings:` : 'Settings:';
  lines.push(
    format.linkOnOwnLine
      ? `${hubLabel}\n${input.preferencesUrl}`
      : `${hubLabel} ${input.preferencesUrl}`
  );
  lines.push(STOP_LINE);

  return lines.join('\n');
}

/**
 * The normal weekly send (PRD §2.6).
 *
 *     KIDS FUN: 6 picks this weekend for ages 2-4 & 5-9 near East Van.
 *     SAT
 *     Story Time (VPL Renfrew)
 *     https://kidsfun.ca/s/7hK2pQmzN4wT
 *
 *     SUN
 *     PNE Farm Day
 *     https://kidsfun.ca/s/xQ2mZ9vLp7Kd
 *     +3 more & settings:
 *     https://kidsfun.ca/u/8fJ2q
 *     Reply STOP to end
 *
 * The "+N more" line is present whenever N > 0 and carries the preferences URL; when every pick
 * is in the text it degrades to a bare settings link, because the preferences URL must appear in
 * EVERY message regardless — it is the unsubscribe path and the access/correction mechanism at
 * once, not a footer.
 *
 * ═══ HOW MANY PICKS ARE LINKED AND HOW MANY ARE NAMED ARE TWO DIFFERENT NUMBERS ═══
 * They used to be one number. `DIRECT_LINK_PICKS = 3` decided both how many picks get an
 * attributable click AND how many picks a parent can read — so seven of ten picks reached the
 * message as a bare integer in "+7 more", with no day, no name and no venue.
 *
 * Those two things have nothing in common. A link costs ~37 characters and carries the
 * per-(occurrence, subscriber) attribution `click-through.ts` depends on; a name in an "Also:"
 * run costs ~21 and carries most of the scanning value. So the LINK count stays a product
 * constant and stays in `weekly-picks.ts`, and the NAMED count is computed here, out of whatever
 * character headroom the linked picks leave behind.
 *
 * ── IT MEASURES EACH CANDIDATE RATHER THAN COMPUTING A BUDGET ───────────────────────────
 * The fill renders the body once per candidate count and asks `estimateSegments`, which is the
 * same function the send log reports. Predicting the cost arithmetically would be wrong rather
 * than merely approximate: naming a pick adds a day header AND a blank line if it is the first
 * pick on its day, adds two characters and a name if its day is already open, and the "+N more"
 * label collapses to "Settings:" at the moment the last one is named. Eleven renders of a
 * ten-item list is far cheaper than a delta calculation that has to know all of that.
 *
 * AND IT DOES NOT STOP AT THE FIRST OVERRUN. Cost is monotonic in the named count everywhere
 * except that final step, where the body gets SHORTER. Breaking early would silently refuse to
 * name the last pick of a week that fits.
 */
export function renderWeeklyMessage(input: WeeklyMessageInput): RenderedMessage {
  const format = { ...WEEKLY_MESSAGE_FORMAT, ...input.format };
  const candidates = format.nameUnlinkedPicks ? (input.namedPickCandidates ?? []).length : 0;

  // n = 0 is the floor and is used even when it does not fit: the linked picks, the opener, the
  // hub link and the STOP line are not discretionary. See `maxSegments`.
  let body = composeWeeklyBody(input, format, 0);
  for (let n = 1; n <= candidates; n += 1) {
    const candidate = composeWeeklyBody(input, format, n);
    if (estimateSegments(candidate).segments <= format.maxSegments) body = candidate;
  }

  return render(body);
}

/**
 * The confirmation request (PRD §1.4, §2.1, §2.6) — the FIRST message this product ever sends,
 * fired on form submit, to a number that has not yet proved it wants to hear from us.
 *
 *     KIDS FUN: Reply JOIN to confirm weekly kid activity picks for Vancouver. Msg&data rates may apply. Reply STOP to opt out anytime, or HELP for info.
 *
 * JOIN, NOT YES. Twilio's Advanced Opt-Out treats YES (with START and UNSTOP) as a carrier-level
 * resubscribe keyword and can intercept the reply before our webhook ever sees it, which would
 * leave a parent who did everything right sitting at `pending` forever. See lib/sms/keywords.ts.
 *
 * ── IT DOES NOT USE `STOP_LINE`, AND THAT IS DELIBERATE ─────────────────────────────────
 * Every other template ends with "Reply STOP to end" on its own line. §2.6 gives this one its own
 * opt-out sentence instead — inline, alongside the rates disclosure. Not normalised to match the
 * others, for two reasons: it is the approved copy of record, and the wording is better suited to
 * its moment. "Reply STOP to end" addresses a subscriber who has something to end; this message
 * reaches someone who has not confirmed anything yet, and "opt out anytime" is the accurate thing
 * to tell them.
 *
 * ── THE HELP CLAUSE (Jon-approved, relayed by the Operator) ─────────────────────────────
 * Round 12 flagged that this message named STOP but not HELP, while CTIA's Messaging Principles
 * expect an opt-in confirmation to carry both, and measured 25 septets of headroom against the
 * longest covered municipality. Jon's ruling extends the existing sentence rather than adding a
 * new one: "Reply STOP to opt out anytime, or HELP for info."
 *
 * "HELP for info" IS THE EXACT PHRASE already used by `renderUnknownKeywordMessage` and quoted in
 * the START invite's sibling copy — deliberately, so a parent meets one wording for the same
 * instruction wherever they meet it. Not extracted into a shared constant: three occurrences of a
 * four-word phrase inside three different sentences is copy, not a rule, and hoisting it would
 * make each sentence unreadable at its own call site to enforce a consistency a test can assert
 * more cheaply. tests/sms/confirm_request.test.ts does assert it.
 *
 * THE MEASUREMENT IS IN THE TEST, not in this comment — see `stays inside ONE segment`.
 *
 * ── AND IT IS ONE LINE, WHERE THE OTHERS ARE SEVERAL ────────────────────────────────────
 * The weekly, welcome, empty-week and pause templates all break before a URL, because a link
 * sitting mid-sentence is a link that gets mis-tapped. This message contains no URL and no list,
 * so it is rendered exactly as §2.6 writes it: one line, no invented breaks.
 *
 * THE AREA CLAUSE DEGRADES rather than printing a placeholder, matching the welcome text. In
 * practice it cannot fire on the signup path — `parseProfileFields` rejects any postal code that
 * does not resolve to a covered municipality, so a validated `SmsSignup` always has an area — but
 * the renderer is pure and must not depend on its one caller's guarantees to avoid emitting
 * "picks for null".
 */
export function renderConfirmRequestMessage(areaLabel: string | null): RenderedMessage {
  const area = areaLabel ? ` for ${areaLabel}` : '';
  return render(
    `${BRAND} Reply JOIN to confirm weekly kid activity picks${area}. ` +
      `Msg&data rates may apply. Reply STOP to opt out anytime, or HELP for info.`
  );
}

export interface WelcomeMessageInput {
  /** The subscriber's area, e.g. "East Van". Omitted from the copy when it cannot be resolved. */
  areaLabel: string | null;
  /** Their children's ages, recomputed from the stored birth years at this moment. */
  childAges: readonly number[];
  /** Their own no-login preferences/hub URL. */
  preferencesUrl: string;
}

/**
 * The welcome text (PRD §2.1, §2.6) — sent once, immediately after a JOIN confirms a subscription.
 *
 *     KIDS FUN: You're in! Your weekly picks for East Van, ages 5, 8, start Friday ~4pm.
 *     Manage anytime: https://kidsfun.ca/u/8fJ2q
 *     Reply STOP to end
 *
 * ── IT SAYS "WEEKLY", ADDED IN ROUND 21 ─────────────────────────────────────────────────
 * V1 testing found that this was the only message in the lifecycle that never restated the
 * cadence: the confirmation request says "weekly kid activity picks", and then the very next text
 * a subscriber receives — the one confirming what they just signed up for — said only "your first
 * picks... Friday". A parent could reasonably read that as a one-off. "first" became "weekly", and
 * "land" became "start", which is what makes the sentence say a series is beginning rather than
 * that one thing is arriving. Same length to the character, so the segment count is unchanged.
 *
 * STATIC BY DESIGN. §2.1 is explicit: "one static welcome text (no live matching logic — just
 * confirms signup and sets expectations for Friday)." It runs no search and touches no engine.
 * That is not an optimisation, it is the product decision: a live preview at this moment would
 * either promise picks that may not exist by Friday, or spend a search on a subscriber who has
 * not yet had a weekly send. §2.7 lists the "live/dynamic welcome preview" as explicitly OUT of
 * MVP, gated on real confirm-to-first-click data.
 *
 * IT ECHOES BACK WHAT THEY GAVE US — their area and their children's ages — because that is the
 * cheapest possible confirmation that we recorded it correctly, at the one moment they are paying
 * attention. A wrong postal code or a mistyped age is trivially fixable now and invisible later.
 *
 * BOTH DETAILS DEGRADE INDEPENDENTLY. An unresolvable postal code drops the area clause and an
 * empty age list drops the ages clause, rather than either printing a placeholder. A welcome text
 * reading "for null, ages" would be a worse first impression than a shorter sentence.
 */
export function renderWelcomeMessage(input: WelcomeMessageInput): RenderedMessage {
  const area = input.areaLabel ? ` for ${input.areaLabel}` : '';
  const ages = input.childAges.length > 0 ? `, ages ${input.childAges.join(', ')},` : '';
  return render(
    `${BRAND} You're in! Your weekly picks${area}${ages} start Friday ~4pm.\n` +
      `Manage anytime: ${input.preferencesUrl}\n${STOP_LINE}`
  );
}

/**
 * The reply to an inbound text we do not recognise (webhook `unknown` branch).
 *
 *     KIDS FUN: We text weekly kid activity picks. Reply JOIN to confirm, HELP for info, or STOP
 *     to end. Not signed up? kidsfun.ca/sms/start
 *
 * ── IT SAYS WHAT WE ARE, ADDED IN ROUND 21 — AND SOMETHING HAD TO GO ────────────────────
 * V1 testing found the reply told a stranger what to TYPE without ever saying what they would be
 * signing up FOR. This is the message most likely to reach somebody with no idea who we are — a
 * wrong number, a forwarded text, a poster half-remembered — and "KIDS FUN" alone does not tell
 * them. The clause is lifted verbatim from `renderStartSignupInviteMessage`, which already had to
 * solve exactly this for the other cold-contact message, so a stranger meets one description of
 * the product however they reach us.
 *
 * 🔴 THE ACKNOWLEDGEMENT WAS THE CASUALTY, AND THAT WAS A MEASURED CHOICE, NOT AN OVERSIGHT.
 * The message used to open "Sorry, we didn't catch that." Keeping BOTH that and the product clause
 * measures 163 septets against the production signup URL — three over one GSM-7 segment, and every
 * variant tried landed 161-185. Measured, not estimated; the candidates are in the round-21 notes.
 * So this reply no longer says it failed to understand, which is a real loss: the apology is what
 * made it read as a REPLY rather than a broadcast. It was traded for the product clause because a
 * stranger who does not know who is texting them cannot act on either sentence, and doubling the
 * cost of the one message that fires on arbitrary inbound text is the alternative.
 * Now 143 septets, one segment, 17 to spare — MORE headroom than before the edit (11).
 *
 * ── ⚠ THIS COPY IS A SUGGESTION, NOT APPROVED WORDING ───────────────────────────────────
 * PRD §2.6 specifies five messages and this is not one of them; §1.4 and §2.1 both assume an
 * unrecognised reply gets "a human-readable nudge" without saying what it says. So the wording
 * below was originated here and needs Jon's review like any other consumer-facing copy — the same
 * posture the round-4 ASCII substitution and the round-9 sender identification took. What is NOT
 * a matter of taste is which keywords it names; see below.
 *
 * ── WHY IT NAMES JOIN, HELP AND STOP — AND DELIBERATELY NOT START ───────────────────────
 * JOIN is ours end to end and is the single most valuable thing to say: `classifyInboundKeyword`
 * refuses to fuzzy-match, on purpose, because promoting "JOIM" into an express-consent record is
 * how you fabricate consent. That decision is only safe if the near-miss gets told what the
 * actual word is — this message is the other half of that design, and until now it did not exist.
 * STOP is the free opt-out and belongs on anything we send. HELP routes to Twilio's own canned
 * response, which is where CTIA expects support contact to come from.
 *
 * START is left out even though the webhook handles it. PRD §1.4 records that Twilio's behaviour
 * toward a previously-unknown or previously-stopped number "may be a canned carrier-level
 * auto-reply rather than a route into our app", and that START must be explicitly configured and
 * verified against a real Canadian toll-free number before launch. Printing a keyword whose
 * behaviour is not yet verified would be telling a parent to do something we cannot promise works.
 *
 * ── WHY IT CARRIES THE SIGNUP LINK ──────────────────────────────────────────────────────
 * Not decoration, and not up-sell. Somebody who texts our number cold — PRD §2.1's door 2 — has
 * no `sms_consent` row, so if they follow "reply JOIN" the transition answers `no_such_subscriber`
 * and the webhook says nothing. A nudge whose advice leads to a SECOND silence is worse than no
 * nudge. The link is the only thing in this message that works for someone who has never signed
 * up, and it is the door §2.1 already wants that reply to open.
 *
 * The clause degrades rather than printing a placeholder, matching the welcome text: the
 * keyword half of the sentence stands on its own for an existing subscriber.
 */
export function renderUnknownKeywordMessage(signupUrl: string | null): RenderedMessage {
  const signup = signupUrl ? ` ${signupClause(signupUrl)}` : '';
  return render(
    // PRD v3.11, "Approved verbatim". The ACKNOWLEDGEMENT CLAUSE IS LOAD-BEARING and had drifted
    // out: this reply answers someone whose message we did not understand, and opening with what
    // we do ("We text weekly kid activity picks") answers a question they did not ask. "Sorry, we
    // didn't catch that" tells them what happened first, which is the difference between a reply
    // and a broadcast. Restored 2026-08-28 after live testing found the drift.
    // STRAIGHT apostrophe in "didn't" — U+0027 is in GSM-7, U+2019 is not and would double the
    // segment cost of every one of these.
    `${BRAND} Sorry, we didn't catch that. Reply JOIN to confirm your signup, HELP for info, ` +
      `or STOP to end.${signup}`
  );
}

/**
 * The reply to START from a number we have no signup for (PRD §2.1 door 2).
 *
 * ── ⚠ SUGGESTED COPY, NOT APPROVED WORDING ──────────────────────────────────────────────
 * §2.1 specifies the BEHAVIOUR — *"Text START to [number]" — our webhook replies with a link to
 * the form* — and the v2.7 changelog specifies WHICH outcome gets it ("here's the signup link"),
 * but no document gives the sentence. Originated here, needs Jon like the round-13 unknown-keyword
 * reply and the round-9 sender identification did.
 *
 * IT SAYS WHAT THE PRODUCT IS BEFORE IT ASKS FOR ANYTHING. This is the one message on the branch
 * that can reach somebody with NO record of us at all: a QR code on a noticeboard, a number
 * copied off a poster. "Not signed up? {link}" alone would assume they know what they nearly
 * signed up for. One clause of context is the difference between a link and a link worth tapping.
 *
 * IT CARRIES THE STOP LINE even though it is answering their own text. This number has no
 * `sms_consent` row, so it has no recorded consent of any kind — and after the confirmation
 * request it is the highest-exposure message this product sends. The brand tag and a free opt-out
 * are exactly what CASL's identification rules want on it.
 */
export function renderStartSignupInviteMessage(signupUrl: string): RenderedMessage {
  return render(
    `${BRAND} We send weekly kid activity picks for Metro Vancouver by SMS. ` +
      `${signupClause(signupUrl)}\n${STOP_LINE}`
  );
}

/**
 * The empty week (PRD §2.6) — below the floor even after both degradation retries.
 *
 * It says so plainly rather than padding the list, which is the same posture /search's honest
 * empty state takes. The preferences link is not consolation: an empty week is the single most
 * likely moment for a subscriber to want to widen their area or interests, and this is the only
 * lever they have until V1 ships reply-based edits.
 */
export function renderEmptyWeekMessage(preferencesUrl: string): RenderedMessage {
  return render(
    `${BRAND} Nothing new matches your area this week - check back Friday, or update what ` +
      `you're into: ${preferencesUrl}\n${STOP_LINE}`
  );
}

/**
 * The pause notice (PRD §2.6) — the third consecutive empty week.
 *
 * Sent INSTEAD of a third empty-week text, not in addition to one. Three "nothing this week"
 * messages in a row is the product failing and then continuing to text about it; pausing is the
 * honest end of that sequence, and it is reversible from the same link.
 */
export function renderPauseNoticeMessage(preferencesUrl: string): RenderedMessage {
  return render(
    `${BRAND} We haven't found matches near you for a few weeks, so we've paused your SMS updates. ` +
      `Update your area or interests anytime to restart: ${preferencesUrl}\n${STOP_LINE}`
  );
}
