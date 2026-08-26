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
 * The GSM 03.38 basic character set — every character an SMS can carry at 160 per segment.
 *
 * Transcribed from the standard rather than approximated. The characters in the EXTENSION table
 * (^ { } \ [ ~ ] | €) are deliberately NOT here: they are encodable, but each one costs TWO
 * characters of the budget, which makes them a trap rather than a saving. Nothing in this
 * product's copy needs them.
 */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_SET: ReadonlySet<string> = new Set(GSM7_BASIC.split(''));

/** Characters per segment, single message and concatenated, for each encoding. */
const GSM7_SINGLE = 160;
const GSM7_CONCAT = 153;
const UCS2_SINGLE = 70;
const UCS2_CONCAT = 67;

export type SmsEncoding = 'GSM-7' | 'UCS-2';

/** Every character in this string encodable in GSM-7 at one character each? */
export function isGsm7(text: string): boolean {
  for (const ch of text) if (!GSM7_SET.has(ch)) return false;
  return true;
}

/** The characters in this string that would force the whole message to UCS-2. Diagnostic. */
export function nonGsm7Characters(text: string): string[] {
  const bad = new Set<string>();
  for (const ch of text) if (!GSM7_SET.has(ch)) bad.add(ch);
  return [...bad];
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
  const characters = gsm7 ? body.length : [...body].length;
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
