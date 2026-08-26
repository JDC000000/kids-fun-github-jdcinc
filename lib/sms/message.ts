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

/** One line of the weekly message: a pick with its own short link. */
export interface MessagePick {
  /** Activity name, as the catalogue holds it. */
  name: string;
  /** Venue name, printed in brackets. Omitted when the catalogue has none. */
  venue: string | null;
  /** UTC ISO start of the first slot, for the "Sat"/"Sun" prefix. Null for open-hours. */
  startDatetimeUtc: string | null;
  /** The absolute short link for this pick. */
  url: string;
}

export interface WeeklyMessageInput {
  /** Total picks selected — the number in the opener, INCLUDING the ones behind "+N more". */
  totalPicks: number;
  /** Age bands, already humanised ("2-4", "5-9"). Empty when no age was known. */
  ageLabels: readonly string[];
  /** The subscriber's area, e.g. "East Van". */
  areaLabel: string;
  /** The picks that get their own line and their own link (PRD §2.3: top 2-3). */
  directPicks: readonly MessagePick[];
  /** The subscriber's own preferences/hub URL — carries the rest and the CASL controls. */
  preferencesUrl: string;
}

/**
 * The normal weekly send (PRD §2.6).
 *
 *     KIDS FUN: 6 picks this weekend for ages 2-4 & 5-9 near East Van.
 *     Sat: Story Time (VPL Renfrew) https://kidsfun.ca/s/7hK2pQmzN4wT
 *     Sun: PNE Farm Day https://kidsfun.ca/s/xQ2mZ9vLp7Kd
 *     +3 more & settings: https://kidsfun.ca/u/8fJ2q
 *     Reply STOP to end
 *
 * The "+N more" line is present whenever N > 0 and carries the preferences URL; when every pick
 * got a direct link it degrades to a bare settings link, because the preferences URL must appear
 * in EVERY message regardless — it is the unsubscribe path and the access/correction mechanism
 * at once, not a footer.
 */
export function renderWeeklyMessage(input: WeeklyMessageInput): RenderedMessage {
  const ages =
    input.ageLabels.length > 0 ? ` for ages ${input.ageLabels.join(' & ')}` : '';
  const noun = input.totalPicks === 1 ? 'pick' : 'picks';
  const lines: string[] = [
    `${BRAND} ${input.totalPicks} ${noun} this weekend${ages} near ${input.areaLabel}.`,
  ];

  for (const pick of input.directPicks) {
    const day = weekdayLabel(pick.startDatetimeUtc);
    const venue = pick.venue ? ` (${pick.venue})` : '';
    lines.push(`${day ? `${day}: ` : ''}${pick.name}${venue} ${pick.url}`);
  }

  const remaining = input.totalPicks - input.directPicks.length;
  lines.push(
    remaining > 0
      ? `+${remaining} more & settings: ${input.preferencesUrl}`
      : `Settings: ${input.preferencesUrl}`
  );
  lines.push(STOP_LINE);

  return render(lines.join('\n'));
}

/**
 * The confirmation request (PRD §1.4, §2.1, §2.6) — the FIRST message this product ever sends,
 * fired on form submit, to a number that has not yet proved it wants to hear from us.
 *
 *     KIDS FUN: Reply JOIN to confirm weekly kid activity picks for Vancouver. Msg&data rates may apply. Reply STOP to opt out anytime.
 *
 * JOIN, NOT YES. Twilio's Advanced Opt-Out treats YES (with START and UNSTOP) as a carrier-level
 * resubscribe keyword and can intercept the reply before our webhook ever sees it, which would
 * leave a parent who did everything right sitting at `pending` forever. See lib/sms/keywords.ts.
 *
 * ── IT DOES NOT USE `STOP_LINE`, AND THAT IS DELIBERATE ─────────────────────────────────
 * Every other template ends with "Reply STOP to end" on its own line. §2.6 gives this one its own
 * opt-out sentence instead — "Reply STOP to opt out anytime." — inline, alongside the rates
 * disclosure. Not normalised to match the others, for two reasons: it is the approved copy of
 * record, and the wording is better suited to its moment. "Reply STOP to end" addresses a
 * subscriber who has something to end; this message reaches someone who has not confirmed
 * anything yet, and "opt out anytime" is the accurate thing to tell them.
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
      `Msg&data rates may apply. Reply STOP to opt out anytime.`
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
 *     KIDS FUN: You're in! Your first picks for East Van, ages 5, 8, land Friday ~4pm.
 *     Manage anytime: https://kidsfun.ca/u/8fJ2q
 *     Reply STOP to end
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
    `${BRAND} You're in! Your first picks${area}${ages} land Friday ~4pm.\n` +
      `Manage anytime: ${input.preferencesUrl}\n${STOP_LINE}`
  );
}

/**
 * The reply to an inbound text we do not recognise (webhook `unknown` branch).
 *
 *     KIDS FUN: Sorry, we didn't catch that. Reply JOIN to confirm your signup, HELP for info,
 *     or STOP to end. Not signed up? https://kidsfun.ca/sms/signup
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
  const signup = signupUrl ? ` Not signed up? ${signupUrl}` : '';
  return render(
    `${BRAND} Sorry, we didn't catch that. Reply JOIN to confirm your signup, ` +
      `HELP for info, or STOP to end.${signup}`
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
    `${BRAND} We haven't found matches near you for a few weeks, so we've paused your texts. ` +
      `Update your area or interests anytime to restart: ${preferencesUrl}\n${STOP_LINE}`
  );
}
