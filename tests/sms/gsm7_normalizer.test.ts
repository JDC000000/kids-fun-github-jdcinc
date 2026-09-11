// tests/sms/gsm7_normalizer.test.ts — the GSM-7 normaliser, and the proof it changes nothing else.
//
// This suite has two halves and the second one is the important one.
//
// The first half tests `normalizeForGsm7` itself. The second half pins the fact that a message
// built from ALREADY-CLEAN catalogue text comes out BYTE FOR BYTE as it did before this function
// existed — because that is the promise this change was allowed to ship on. A parent must not be
// able to tell that anything happened unless their text contained a character that was costing
// double.
//
// ── THIS FILE DIFFERS BY ONE THING FROM ITS FORM ON fix/kf-sms-gsm7-normalizer ──────────
// There, the flat layout IS the default and these tests call the renderer bare. Here the layout
// work exists, so the same assertions are made with the structural dials explicitly OFF. That is
// not a weakening — it is the stronger statement: main's exact bytes are still reachable, so the
// day-grouping work is genuinely inert rather than merely unreferenced, and the GSM-7 fix can be
// deployed on its own while this branch waits on Jon.
//
// Every number is MEASURED with the production `estimateSegments`, not quoted from a document.
import { describe, expect, it } from 'vitest';
import {
  estimateSegments,
  isGsm7,
  nonGsm7Characters,
  normalizeForGsm7,
  renderWeeklyMessage,
  septetLength,
  type MessagePick,
  type WeeklyMessageFormat,
} from '@/lib/sms/message';

/** The layout exactly as main ships it — every structural dial off. */
const AS_SHIPPED: Partial<WeeklyMessageFormat> = {
  groupByDay: false,
  linkOnOwnLine: false,
  nameUnlinkedPicks: false,
};

const ORIGIN = 'https://kidsfunapp.ca';
const s = (token: string) => `${ORIGIN}/s/${token}`;
/** A REAL-WIDTH preferences URL — `preferences-token.ts` is explicit that it is never shortened. */
const HUB = `${ORIGIN}/u/Xk3pQ7mZ9vLdR2sTfN8hJ4wYc6BgA1eU0oPiKnMxQzE`;

const SAT = '2026-08-29T17:00:00Z';
const SUN = '2026-08-30T17:00:00Z';

/** Jon's live test send — the three picks, with the real 47-character venue name. */
const LIVE: MessagePick[] = [
  {
    name: 'Tai Chi Chuan - Beginners',
    venue: 'Roundhouse Community Arts and Recreation Centre',
    startDatetimeUtc: SAT,
    url: s('000BwcncMGSDw'),
  },
  {
    name: 'Pickleball - 3.0+',
    venue: 'Coal Harbour Community Centre',
    startDatetimeUtc: SUN,
    url: s('000LnWawBjYjj'),
  },
  {
    name: 'Roundhouse Community Dancers',
    venue: 'Roundhouse Community Arts and Recreation Centre',
    startDatetimeUtc: SUN,
    url: s('0003RqII9Rn8h'),
  },
];

const weekly = (picks: readonly MessagePick[], total = 10, area = 'Vancouver') =>
  renderWeeklyMessage({
    totalPicks: total,
    ageLabels: ['2-4', '10-14'],
    areaLabel: area,
    directPicks: picks,
    preferencesUrl: HUB,
    format: AS_SHIPPED,
  });

// ─────────────────────────────────────────────────────────────────────────────
// The function.
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeForGsm7', () => {
  it('maps the six known offenders, and the opening single quote the pinned list omits', () => {
    // The six are the exact set `weekly_send.test.ts` already pins in "detects the punctuation
    // that silently more than halves a segment". U+2018 is NOT in that list; it is handled anyway,
    // because the pair is the unit and handling only the closing quote would be a gap.
    //
    // ── EVERY INPUT IS BUILT FROM A CODEPOINT, AND NON-VACUITY IS ASSERTED FIRST ──────────
    // An escape sequence is NOT sufficient protection here, which this suite learned the hard way
    // from a sibling workstream: an editor or a copy step can RESOLVE `\u2014` back into a raw em
    // dash, at which point the same pipeline that flattens the source map key flattens the test
    // literal with it. Both sides move together and the assertion becomes
    // `expect(normalize('a - b')).toBe('a - b')` -- true, green, and testing nothing.
    //
    // A function call survives an arbitrary text pipeline; a literal does not. So the input is
    // constructed, and every case asserts the input DIFFERS from the expected output before
    // asserting what the normaliser does to it. A vacuous case now fails loudly.
    const ch = (cp: number) => String.fromCodePoint(cp);

    const CASES: ReadonlyArray<readonly [number, string, string]> = [
      [0x2014, 'em dash', '-'],
      [0x2013, 'en dash', '-'],
      [0x2019, 'curly apostrophe', "'"],
      [0x2018, 'left single quote', "'"],
      [0x201c, 'left double quote', '"'],
      [0x201d, 'right double quote', '"'],
      [0x2026, 'ellipsis', '...'],
    ];

    for (const [cp, label, ascii] of CASES) {
      const input = `a${ch(cp)}b`;
      const expected = `a${ascii}b`;
      // The premise: this really is a character that forces UCS-2. If it flattened, this fails.
      expect(isGsm7(ch(cp))).toBe(false);
      // Non-vacuity: the input must not already BE the answer, or the next line proves nothing.
      expect(input).not.toBe(expected);
      expect(normalizeForGsm7(input)).toBe(expected);
      expect(isGsm7(normalizeForGsm7(`Court 1 ${ch(cp)} Gym`))).toBe(true);
      expect(label.length).toBeGreaterThan(0); // label is documentation; keep it referenced
    }
  });

  it('does not add spaces around a dash that already has them', () => {
    // Round 4's comment describes the RESULT (" - "), not the replacement string. Mapping the em
    // dash to " - " would double every space in the real "this week — check back" shape.
    expect(normalizeForGsm7('this week — check back')).toBe('this week - check back');
    expect(normalizeForGsm7('Youth—Teen')).toBe('Youth-Teen');
  });

  it('collapses the INVISIBLE offenders, which are the ones nobody can see in a diff', () => {
    // A no-break space is the commonest artefact of scraping a municipal web page and is
    // indistinguishable from a space on every screen it will ever appear on.
    //
    // CONSTRUCTED, NOT WRITTEN -- not even as an escape. An earlier draft of this test used a raw
    // U+00A0, which was flattened to a plain space and left the assertion inverted and green. The
    // obvious fix was `\u00A0`, and that is still not enough: an escape can be RESOLVED back into
    // the raw character by the next tool that touches the file, which puts it right back where it
    // started. Only a function call survives an arbitrary text pipeline, because `0x00a0` is
    // ASCII and `String.fromCodePoint` cannot be flattened into anything else.
    const ch = (cp: number) => String.fromCodePoint(cp);

    const nbsp = `Trout${ch(0x00a0)}Lake`;
    expect(nbsp).not.toBe('Trout Lake'); // it is really a no-break space, not a space
    expect(isGsm7(nbsp)).toBe(false);
    expect(normalizeForGsm7(nbsp)).toBe('Trout Lake');

    expect(normalizeForGsm7(`Gym${ch(0x200b)}Bugs`)).toBe('GymBugs'); // zero-width space
    expect(normalizeForGsm7(`${ch(0xfeff)}Britannia`)).toBe('Britannia'); // byte-order mark
    expect(normalizeForGsm7(`a${ch(0x2009)}b${ch(0x202f)}c${ch(0x2007)}d`)).toBe('a b c d');

    // Each of the eight really is non-GSM-7 to begin with, or the mapping proves nothing.
    for (const cp of [0x00a0, 0x2007, 0x2009, 0x202f, 0x200b, 0x200c, 0x200d, 0xfeff]) {
      expect(isGsm7(ch(cp))).toBe(false);
    }
  });

  it('strips an accent ONLY when GSM-7 cannot carry the letter', () => {
    // GSM 03.38's accented set is lopsided: e-acute is in it, c-cedilla is not. That is a
    // distinction no reader could predict and no writer intended, so it is the one place a name is
    // allowed to change.
    //
    // CONSTRUCTED, AND NON-VACUITY ASSERTED, for the reason given on the offenders test above: an
    // accent that flattened in BOTH the fixture and the expectation turns "Cafe stays Cafe" into a
    // tautology that passes while proving nothing about accents at all.
    const ch = (cp: number) => String.fromCodePoint(cp);
    const cafe = `Caf${ch(0x00e9)}`; // e-acute, which GSM-7 DOES carry
    const francais = `Fran${ch(0x00e7)}ais`; // c-cedilla, which it does not

    expect(cafe).not.toBe('Cafe'); // the accent is really there
    expect(isGsm7(cafe)).toBe(true);
    expect(normalizeForGsm7(cafe)).toBe(cafe); // untouched -- the accent survives

    expect(francais).not.toBe('Francais'); // the cedilla is really there
    expect(isGsm7(francais)).toBe(false);
    expect(normalizeForGsm7(francais)).toBe('Francais');

    // Combining marks with no precomposed form, same treatment.
    const senakw = `Sen${ch(0x0313)}a${ch(0x0301)}k${ch(0x0331)}w`.normalize('NFC');
    expect(senakw).not.toBe('Senakw'); // the input really does carry marks
    expect(normalizeForGsm7(senakw)).toBe('Senakw');
  });

  it('LEAVES a character it cannot fold, rather than handing a parent mojibake', () => {
    // Layer 3. A CJK venue name still costs UCS-2 — but replacing it would produce a name nobody
    // can read, which is a worse product than an expensive message. The cost stays VISIBLE:
    // `estimateSegments` is reported on every send and `nonGsm7Characters` names the survivor.
    const ch = (cp: number) => String.fromCodePoint(cp);
    const venue = `${ch(0x6d77)}${ch(0x6ffb)}${ch(0x4e2d)}${ch(0x5fc3)} ${ch(0x2013)} Court 1`;
    expect(venue).not.toContain('-'); // the en dash is really an en dash, not a hyphen
    const normalized = normalizeForGsm7(venue);
    expect(normalized).toBe(`${ch(0x6d77)}${ch(0x6ffb)}${ch(0x4e2d)}${ch(0x5fc3)} - Court 1`);
    expect(isGsm7(normalized)).toBe(false);
    expect(nonGsm7Characters(normalized)).toEqual([ch(0x6d77), ch(0x6ffb), ch(0x4e2d), ch(0x5fc3)]);
  });

  it('is idempotent, and leaves clean ASCII exactly alone', () => {
    for (const clean of [
      'Tai Chi Chuan - Beginners',
      'Roundhouse Community Arts and Recreation Centre',
      'Youth (13-18yrs) Open Gym - Tue/ Wed',
      "Kids' Night Out",
      'Art & Craft 50% Off',
      HUB,
    ]) {
      expect(normalizeForGsm7(clean)).toBe(clean);
      expect(normalizeForGsm7(normalizeForGsm7(clean))).toBe(clean);
    }
  });

  it('never introduces a character that is not one septet', () => {
    // Everything the map substitutes IN must be basic-table, or the fix would cost budget of its
    // own. Checked against the real encoder rather than eyeballed against a table.
    for (const introduced of ['-', "'", '"', '.', ' ']) {
      expect(isGsm7(introduced)).toBe(true);
      expect(septetLength(introduced)).toBe(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The defect this shipped for.
// ─────────────────────────────────────────────────────────────────────────────

describe('the live catalogue defect', () => {
  // "Westwind School - Gymnasium – Court 1" is verbatim from
  // worker/adapters/perfectmind/__fixtures__/richmond.classes.registered-visits.json. Eight
  // name-like strings in that one file carry an en dash; nothing on the render path touched them.
  // Constructed for the same reason as the tests above: if this en dash were flattened to a
  // hyphen the fixture would stop being poisoned, and this suite's headline measurement would
  // be measuring a clean message. The assertion below makes that impossible to do quietly.
  const POISONED = `Westwind School - Gymnasium ${String.fromCodePoint(0x2013)} Court 1`;

  it('ONE en dash in ONE venue name doubled the bill for the whole message', () => {
    expect(isGsm7(POISONED)).toBe(false); // the fixture really is poisoned
    const rendered = weekly(LIVE.map((p, i) => (i === 0 ? { ...p, venue: POISONED } : p))).body;

    // What the renderer produced BEFORE this change: the catalogue string, verbatim.
    // Re-injected from a codepoint, not a literal: if THIS en dash flattened, the replace
    // would silently become a no-op and the 'before' message would not be poisoned at all.
    const unfixed = rendered.replace(
      'Gymnasium - Court',
      `Gymnasium ${String.fromCodePoint(0x2013)} Court`
    );
    expect(unfixed).not.toBe(rendered); // the normaliser is what makes these two differ

    const before = estimateSegments(unfixed);
    const after = estimateSegments(rendered);

    expect(before.encoding).toBe('UCS-2');
    expect(before.segments).toBe(8);
    expect(after.encoding).toBe('GSM-7');
    expect(after.segments).toBe(4);
    expect(before.segments / after.segments).toBe(2); // the measured 2.00x, exactly
  });

  it('costs the clean message nothing — still 508 septets, still 4 segments', () => {
    const clean = estimateSegments(weekly(LIVE).body);
    expect(clean.encoding).toBe('GSM-7');
    expect(clean.characters).toBe(508);
    expect(clean.segments).toBe(4);
  });

  it('rescues a poisoned ACTIVITY name and a poisoned AREA label too, not just venues', () => {
    // All three catalogue-sourced fields go through it. The URLs deliberately do not.
    const byName = weekly([{ ...LIVE[0], name: 'BADMINTON BOOKING - COURT 2 – ADULTS' }]).body;
    expect(byName).toContain('BADMINTON BOOKING - COURT 2 - ADULTS');
    expect(isGsm7(byName)).toBe(true);

    const byArea = renderWeeklyMessage({
      totalPicks: 10, ageLabels: [], areaLabel: 'Vancouver – West', directPicks: LIVE,
      preferencesUrl: HUB, format: AS_SHIPPED,
    }).body;
    expect(byArea).toContain('near Vancouver - West.');
    expect(isGsm7(byArea)).toBe(true);
  });

  it('leaves the URLs alone — a mangled link is a dead product', () => {
    const body = weekly(LIVE).body;
    for (const pick of LIVE) expect(body).toContain(pick.url);
    expect(body).toContain(HUB);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PROMISE: today's message is unchanged. This is why this could ship alone.
// ─────────────────────────────────────────────────────────────────────────────

describe('a message built from clean catalogue text is BYTE-IDENTICAL to before', () => {
  // These two bodies were generated by the renderer AS IT STOOD ON MAIN, before the normaliser
  // existed, and pasted here verbatim. If a future change to `normalizeForGsm7` so much as moves a
  // space in the ordinary case, these fail. That is the entire point of pinning whole strings
  // rather than asserting `toContain`.
  it('reproduces main\'s output exactly — two linked picks, one dateless', () => {
    const body = renderWeeklyMessage({
      totalPicks: 4,
      ageLabels: ['5-9'],
      areaLabel: 'East Van',
      directPicks: [
        {
          name: 'Youth (13-18yrs) Open Gym - Saturday',
          venue: 'Trout Lake Rink',
          startDatetimeUtc: null,
          url: s('1000000000399'),
        },
        {
          name: 'Play Palace - 0-12 yrs',
          venue: 'Marpole-Oakridge Community Centre',
          startDatetimeUtc: null,
          url: s('1000000000400'),
        },
      ],
      preferencesUrl: HUB,
      format: AS_SHIPPED,
    });

    expect(body.body).toBe(
      'KIDS FUN: 4 picks this weekend for ages 5-9 near East Van.\n' +
        'Youth (13-18yrs) Open Gym - Saturday (Trout Lake Rink) https://kidsfunapp.ca/s/1000000000399\n' +
        'Play Palace - 0-12 yrs (Marpole-Oakridge Community Centre) https://kidsfunapp.ca/s/1000000000400\n' +
        '+2 more & settings: https://kidsfunapp.ca/u/Xk3pQ7mZ9vLdR2sTfN8hJ4wYc6BgA1eU0oPiKnMxQzE\n' +
        'Reply STOP to end'
    );
    expect(body.characters).toBe(354);
    expect(body.segments).toBe(3);
  });

  it('reproduces main\'s output exactly — with the weekday prefixes', () => {
    const body = renderWeeklyMessage({
      totalPicks: 4,
      ageLabels: ['5-9'],
      areaLabel: 'Vancouver',
      directPicks: [
        {
          name: 'Play Palace - 0-12 yrs',
          venue: 'Marpole-Oakridge Community Centre',
          startDatetimeUtc: SAT,
          url: s('1000000000400'),
        },
        {
          name: 'Gym Bugs Drop In',
          venue: 'Lord Byng Pool',
          startDatetimeUtc: SUN,
          url: s('1000000000401'),
        },
      ],
      preferencesUrl: HUB,
      format: AS_SHIPPED,
    });

    expect(body.body).toBe(
      'KIDS FUN: 4 picks this weekend for ages 5-9 near Vancouver.\n' +
        'Sat: Play Palace - 0-12 yrs (Marpole-Oakridge Community Centre) https://kidsfunapp.ca/s/1000000000400\n' +
        'Sun: Gym Bugs Drop In (Lord Byng Pool) https://kidsfunapp.ca/s/1000000000401\n' +
        '+2 more & settings: https://kidsfunapp.ca/u/Xk3pQ7mZ9vLdR2sTfN8hJ4wYc6BgA1eU0oPiKnMxQzE\n' +
        'Reply STOP to end'
    );
    expect(body.characters).toBe(344);
    expect(body.segments).toBe(3);
  });

  it('with the dials off, the layout is main\'s: one line per pick, link inline, no day headers', () => {
    // The structural work exists on this branch but changes what a parent sees, and Jon has not
    // answered the three wording questions. This asserts it is INERT rather than merely optional:
    // with the dials off the renderer still emits main's exact shape, which is what lets the GSM-7
    // fix deploy ahead of it.
    const lines = weekly(LIVE).body.split('\n');
    expect(lines).toHaveLength(6); // opener + 3 picks + "+N more" + STOP
    expect(lines.filter((l) => l === '')).toHaveLength(0); // no blank separators
    expect(lines.filter((l) => /^[A-Z]{3}$/.test(l))).toHaveLength(0); // no SAT / SUN headers
    for (const line of lines.slice(1, 4)) {
      expect(line).toMatch(/^(Sat|Sun): .+ \(.+\) https:\/\/kidsfunapp\.ca\/s\/[0-9A-Za-z]{13}$/);
    }
    expect(lines[4]).toBe(`+7 more & settings: ${HUB}`); // hub link still inline too
  });

  it('every clean pick renders identically whether or not it goes through the normaliser', () => {
    // The general statement behind the two pinned strings above: for text that is already GSM-7,
    // normalisation is the identity, so the rendered body cannot have moved.
    const names = [
      'Tai Chi Chuan - Beginners', 'Pickleball - 3.0+', 'Roundhouse Community Dancers',
      'Youth (13-18yrs) Open Gym - Saturday', "Kids' Night Out", 'Art & Craft 50% Off',
    ];
    const venues = [
      'Roundhouse Community Arts and Recreation Centre', 'Britannia Pool',
      'West Point Grey Community Centre - Aberthau', 'RayCam Co-operative Centre', null,
    ];
    for (const name of names) {
      for (const venue of venues) {
        expect(normalizeForGsm7(name)).toBe(name);
        if (venue !== null) expect(normalizeForGsm7(venue)).toBe(venue);
        const rendered = weekly([{ name, venue, startDatetimeUtc: SAT, url: s('0000000000001') }]);
        const venuePart = venue ? ` (${venue})` : '';
        expect(rendered.body.split('\n')[1]).toBe(
          `Sat: ${name}${venuePart} https://kidsfunapp.ca/s/0000000000001`
        );
      }
    }
  });
});
