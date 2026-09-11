// tests/sms/gsm7_hardening.test.ts — the three gaps a fresh read of the shipped GSM-7 work found.
//
// The normaliser and the segment estimator in lib/sms/message.ts shipped today. This file is a
// second pair of eyes on them, and it covers the three places where the shipped version was still
// wrong in a way a real parent or a real invoice would have felt:
//
//   1. THE INVISIBLE TABLE WAS AN ENUMERATION. It named eight characters. Unicode's invisible
//      family is roughly five times that size, and every member it missed converted a whole
//      message to UCS-2 with nothing to see anywhere. U+00AD SOFT HYPHEN is the one that matters
//      most in practice: it is what a scraped municipal page leaves behind for every `&shy;`.
//
//   2. UCS-2 WAS COUNTED IN CODE POINTS. The 70/67 budget is counted in UTF-16 CODE UNITS, and an
//      emoji is two of them. A 70-code-point body holding one emoji was reported as one segment
//      and billed as two.
//
//   3. A VENUE OF PURE ZERO-WIDTH PRINTED EMPTY BRACKETS. `venueLabel`'s `.trim()` does not remove
//      a zero-width space (it is not whitespace by JS's definition), so the name was truthy,
//      normalised to "", and rendered "Story Time () https://...".
//
// EVERY INVISIBLE CHARACTER BELOW IS WRITTEN AS AN ESCAPE OR BUILT FROM A CODEPOINT, never typed,
// per tests/sms/source_hygiene.test.ts — which this file is registered in.
import { describe, expect, it } from 'vitest';
import {
  estimateSegments,
  isGsm7,
  normalizeForGsm7,
  renderWeeklyMessage,
  septetLength,
} from '@/lib/sms/message';

const ch = (cp: number) => String.fromCodePoint(cp);

/**
 * Every invisible character that forced UCS-2 past the shipped eight-entry table.
 *
 * Measured against the shipped normaliser, not guessed: each of these was fed through
 * `normalizeForGsm7('Gym <ch> Court')` and came back still not GSM-7.
 */
const INVISIBLE_SURVIVORS: ReadonlyArray<readonly [number, string]> = [
  [0x2000, 'EN QUAD'],
  [0x2001, 'EM QUAD'],
  [0x2002, 'EN SPACE'],
  [0x2003, 'EM SPACE'],
  [0x2004, 'THREE-PER-EM SPACE'],
  [0x2005, 'FOUR-PER-EM SPACE'],
  [0x2006, 'SIX-PER-EM SPACE'],
  [0x2008, 'PUNCTUATION SPACE'],
  [0x200a, 'HAIR SPACE'],
  [0x205f, 'MEDIUM MATHEMATICAL SPACE'],
  [0x3000, 'IDEOGRAPHIC SPACE'],
  [0x1680, 'OGHAM SPACE MARK'],
  [0x0009, 'TAB'],
  [0x00ad, 'SOFT HYPHEN'],
  [0x2060, 'WORD JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x2028, 'LINE SEPARATOR'],
  [0x2029, 'PARAGRAPH SEPARATOR'],
  [0x061c, 'ARABIC LETTER MARK'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
];

describe('the invisible characters the shipped table did not name', () => {
  // `%s` on a number would print it in decimal — "U+8192" for an EN QUAD is a wrong-looking
  // codepoint in every failure message. The label is built in hex instead.
  const cases = INVISIBLE_SURVIVORS.map(([cp, name]) => [
    `U+${cp.toString(16).toUpperCase().padStart(4, '0')} ${name}`,
    cp,
    name,
  ] as const);

  it.each(cases)('%s no longer forces a whole message to UCS-2', (_label, cp, name) => {
    const poisoned = `Westwind School${ch(cp)}Gymnasium`;
    // The premise: this character really is the thing that breaks the encoding. Asserted rather
    // than assumed, so the test cannot pass because the input was harmless all along.
    expect(isGsm7(poisoned), `${name} was already GSM-7 — wrong fixture`).toBe(false);
    expect(isGsm7(normalizeForGsm7(poisoned)), name).toBe(true);
  });

  it('a soft hyphen in a venue name is removed, and the name reads identically', () => {
    // What a scraper carries off a page that wrote "Gym&shy;nasium". Invisible at phone widths.
    const scraped = `Gym${ch(0x00ad)}nasium Court 1`;
    expect(isGsm7(scraped)).toBe(false);
    expect(normalizeForGsm7(scraped)).toBe('Gymnasium Court 1');
  });

  it('an exotic space becomes the space it was already pretending to be', () => {
    expect(normalizeForGsm7(`Court 1${ch(0x2003)}Adults`)).toBe('Court 1 Adults');
    expect(normalizeForGsm7(`Court 1${ch(0x3000)}Adults`)).toBe('Court 1 Adults');
  });

  it('a line separator inside a name folds to a space, NOT to a newline', () => {
    // One pick per line is the weekly message's structure. A catalogue may not add a line to it.
    const folded = normalizeForGsm7(`Story Time${ch(0x2028)}Renfrew`);
    expect(folded).toBe('Story Time Renfrew');
    expect(folded).not.toContain('\n');
  });

  it('leaves every character GSM-7 can already carry exactly alone', () => {
    // The new layer only ever sees characters that already force UCS-2. This is the proof: the
    // line breaks the weekly message is built from, the tilde PRD 2.6 approved, and the accented
    // letters GSM 03.38 actually carries all survive untouched.
    const safe = 'KIDS FUN: land Friday ~4pm\nCafe Deja Vu (Ecole)\nReply STOP to end';
    expect(normalizeForGsm7(safe)).toBe(safe);
    for (const keep of ['\n', '\r', ' ', '~', 'è', 'é', 'ü', 'ñ', 'à']) {
      expect(normalizeForGsm7(`a${keep}b`), keep).toBe(`a${keep}b`);
    }
  });

  it('LAYER 3 still leaves a visible character it cannot carry alone', () => {
    // The posture has not changed: an unreadable name is worse than an expensive message.
    const emoji = ch(0x1f3aa);
    expect(normalizeForGsm7(`Circus ${emoji}`)).toBe(`Circus ${emoji}`);
    expect(normalizeForGsm7('海洋館')).toBe('海洋館');
    expect(isGsm7(normalizeForGsm7('海洋館'))).toBe(false);
  });
});

describe('UCS-2 is measured in code units, because that is what a carrier bills', () => {
  it('an astral character costs TWO of the 70, not one', () => {
    const body = 'a'.repeat(69) + ch(0x1f3aa);
    // 70 code points, 71 UTF-16 code units. The carrier splits; the estimate must say so.
    expect([...body].length).toBe(70);
    expect(body.length).toBe(71);
    expect(estimateSegments(body)).toEqual({ encoding: 'UCS-2', characters: 71, segments: 2 });
  });

  it('and at the concatenated boundary too', () => {
    const body = 'a'.repeat(133) + ch(0x1f3aa);
    expect(estimateSegments(body)).toEqual({ encoding: 'UCS-2', characters: 135, segments: 3 });
  });

  it('septetLength reports the same unit when it falls back to UCS-2', () => {
    expect(septetLength(ch(0x1f3aa))).toBe(2);
  });

  it('changes nothing for text inside the BMP, which is every message this product sends', () => {
    // The regression guard for the fix itself: an astral character is the only thing that moved.
    for (const body of ['a'.repeat(160), 'a'.repeat(70) + '—', '海'.repeat(71)]) {
      expect(estimateSegments(body).characters).toBe([...body].length);
    }
    // And the extension table still costs two SEPTETS, which is a different unit and unchanged.
    expect(estimateSegments('~'.repeat(80))).toEqual({ encoding: 'GSM-7', characters: 160, segments: 1 });
  });
});

describe('a venue name that is only invisible characters', () => {
  const pick = (venue: string | null) => ({
    totalPicks: 1,
    ageLabels: ['5-9'] as const,
    areaLabel: 'East Van',
    directPicks: [
      {
        name: 'Story Time',
        venue,
        startDatetimeUtc: '2026-09-12T17:00:00.000Z',
        url: 'https://kidsfun.ca/s/7hK2pQmzN4wT',
      },
    ],
    preferencesUrl: 'https://kidsfun.ca/u/8fJ2q',
  });

  it('prints no brackets at all, rather than an empty pair', () => {
    // A zero-width space survives `venueLabel`'s trim() — it is not whitespace by JS's rules — so
    // the renderer is the only place this can be caught.
    const body = renderWeeklyMessage(pick(ch(0x200b))).body;
    expect(body).not.toContain('()');
    // THE LAYOUT LITERAL MOVED, THE ASSERTION DID NOT WEAKEN. This was written against the
    // one-line "name (venue) url" form; on this branch `linkOnOwnLine` puts the URL on its own
    // line, which is the change Jon approved on 2026-09-11. Bounding the name with newlines makes
    // this STRICTER than the original: the headline must be the name and nothing else, so an
    // empty bracket pair, a lone bracket, or even a trailing space now fails it.
    expect(body).toContain('\nStory Time\nhttps://kidsfun.ca/s/7hK2pQmzN4wT');
  });

  it('and for a venue of nothing but exotic spaces', () => {
    const body = renderWeeklyMessage(pick(`${ch(0x2003)}${ch(0xfeff)}${ch(0x00ad)}`)).body;
    expect(body).not.toContain('()');
    expect(body).not.toMatch(/\(\s*\)/);
  });

  it('still prints a real venue, and still prints it normalised', () => {
    const body = renderWeeklyMessage(pick(`VPL${ch(0x00a0)}Renfrew${ch(0x2013)}Room 2`)).body;
    expect(body).toContain('(VPL Renfrew-Room 2)');
    expect(isGsm7(body)).toBe(true);
  });
});

describe('the whole message, end to end', () => {
  it('a week of realistically dirty catalogue names still sends as one GSM-7 send', () => {
    const message = renderWeeklyMessage({
      totalPicks: 4,
      ageLabels: ['2-4', '5-9'],
      areaLabel: 'East Van',
      directPicks: [
        {
          // em space + soft hyphen + en dash: three different invisibles in one real-shaped name
          name: `Gym${ch(0x00ad)}nastics${ch(0x2003)}Drop-In`,
          venue: `Westwind School - Gymnasium ${ch(0x2013)} Court 1`,
          startDatetimeUtc: '2026-09-12T17:00:00.000Z',
          url: 'https://kidsfun.ca/s/7hK2pQmzN4wT',
        },
        {
          name: `BADMINTON${ch(0x2060)} BOOKING`,
          venue: `Richmond${ch(0x00a0)}Oval`,
          startDatetimeUtc: '2026-09-13T17:00:00.000Z',
          url: 'https://kidsfun.ca/s/xQ2mZ9vLp7Kd',
        },
      ],
      preferencesUrl: 'https://kidsfun.ca/u/8fJ2q',
    });

    expect(message.encoding).toBe('GSM-7');
    expect(message.body).toContain('Gymnastics Drop-In');
    expect(message.body).toContain('BADMINTON BOOKING');
    expect(message.body).toContain('(Westwind School - Gymnasium - Court 1)');
    expect(message.body).toContain('(Richmond Oval)');
  });
});
