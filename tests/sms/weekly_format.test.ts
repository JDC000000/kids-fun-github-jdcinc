// tests/sms/weekly_format.test.ts — the weekly message's LAYOUT and the GSM-7 normaliser.
//
// Same idiom as `weekly_send.test.ts`'s encoding block: every number below is MEASURED with the
// production `estimateSegments`, not asserted from a document. The design recommendation of
// 2026-09-10 was written against `main` before any of this existed, so its figures are treated as
// a hypothesis to reproduce rather than a specification to trust — and where this file disagrees
// with it, the disagreement is pinned and explained rather than rounded away.
//
// The corpus is the recommendation's own: the three picks from Jon's live test send, plus a "P90"
// week assembled from the longest real names in `worker/adapters/activenet/__fixtures__/`. The
// preferences token is a full-width 43-character HMAC, NOT the 16-character fixture token — a
// measurement taken off a test send is 27 septets optimistic.
import { describe, expect, it } from 'vitest';
import {
  estimateSegments,
  isGsm7,
  nonGsm7Characters,
  normalizeForGsm7,
  renderWeeklyMessage,
  septetLength,
  type MessagePick,
  type NamedPick,
  type WeeklyMessageFormat,
} from '@/lib/sms/message';

const ORIGIN = 'https://kidsfunapp.ca';
const link = (token: string) => `${ORIGIN}/s/${token}`;
/** A REAL-WIDTH preferences URL. `lib/sms/preferences-token.ts` is explicit that it is never shortened. */
const HUB = `${ORIGIN}/u/Xk3pQ7mZ9vLdR2sTfN8hJ4wYc6BgA1eU0oPiKnMxQzE`;

const SAT = '2026-08-29T17:00:00Z';
const SUN = '2026-08-30T17:00:00Z';

const LIVE_LINKED: MessagePick[] = [
  {
    name: 'Tai Chi Chuan - Beginners',
    venue: 'Roundhouse Community Arts and Recreation Centre',
    startDatetimeUtc: SAT,
    url: link('000BwcncMGSDw'),
  },
  {
    name: 'Pickleball - 3.0+',
    venue: 'Coal Harbour Community Centre',
    startDatetimeUtc: SUN,
    url: link('000LnWawBjYjj'),
  },
  {
    name: 'Roundhouse Community Dancers',
    venue: 'Roundhouse Community Arts and Recreation Centre',
    startDatetimeUtc: SUN,
    url: link('0003RqII9Rn8h'),
  },
];

const LIVE_NAMED: NamedPick[] = [
  { name: 'Family Play Time', startDatetimeUtc: SAT },
  { name: 'Youth Badminton', startDatetimeUtc: SAT },
  { name: 'Gym Bugs Drop In', startDatetimeUtc: SAT },
  { name: 'Parent and Tot Gym', startDatetimeUtc: SUN },
  { name: 'Play Palace - Baby Time', startDatetimeUtc: SUN },
  { name: 'Youth Basketball', startDatetimeUtc: SUN },
  { name: 'Volleyball Drop-in', startDatetimeUtc: SUN },
];

const P90_LINKED: MessagePick[] = [
  {
    name: 'Youth (13-18yrs) Open Gym - Saturday',
    venue: 'Roundhouse Community Arts and Recreation Centre',
    startDatetimeUtc: SAT,
    url: link('0000000000001'),
  },
  {
    name: 'Friday Youth Basketball Drop-in',
    venue: 'West Point Grey Community Centre - Aberthau',
    startDatetimeUtc: SAT,
    url: link('0000000000002'),
  },
  {
    name: 'Friday Pre-teen Badminton Drop-in',
    venue: 'Creekside Community Recreation Centre',
    startDatetimeUtc: SUN,
    url: link('0000000000003'),
  },
];

const P90_NAMED: NamedPick[] = [
  { name: 'Friday Youth Volleyball Drop-in', startDatetimeUtc: SAT },
  { name: 'Pre-Teen and Teen Open Gym', startDatetimeUtc: SAT },
  { name: 'Youth (13-18yrs) Open Gym - Tue/ Wed', startDatetimeUtc: SAT },
  { name: 'Friday Youth Badminton Drop-in', startDatetimeUtc: SUN },
  { name: 'Play Palace - Baby Time', startDatetimeUtc: SUN },
  { name: 'Parent and Tot Gym', startDatetimeUtc: SUN },
  { name: 'Youth Gym Drop-In', startDatetimeUtc: SUN },
];

/**
 * A CANDIDATE venue shortener, used only to measure what Jon's §8 Q2 would buy.
 *
 * NOT SHIPPED and deliberately not in `lib/` — the abbreviations are the thing he has to approve,
 * and putting them in the source would make the answer look decided. This is the ruleset the
 * recommendation measured, reproduced here so its saving can be re-derived rather than quoted.
 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\s*Community Arts and Recreation Centre$/i, ' CC'],
  [/\s*Community Recreation Centre$/i, ' CC'],
  [/\s*Community Centre$/i, ' CC'],
  [/\s*Recreation Complex$/i, ' Rec'],
  [/\s*Recreation Centre$/i, ' Rec'],
  [/\s*Aquatic Centre$/i, ' Pool'],
];
function candidateShortener(venue: string): string {
  let stem = venue;
  let annex = '';
  // "- Aberthau" is the thing that distinguishes the site and must survive the collapse.
  const matched = stem.match(/\s+-\s+[A-Za-z][A-Za-z ]*$/);
  if (matched) {
    annex = matched[0];
    stem = stem.slice(0, stem.length - annex.length);
  }
  for (const [pattern, replacement] of RULES) {
    if (pattern.test(stem)) return (stem.replace(pattern, replacement) + annex).trim();
  }
  return (stem + annex).trim();
}

function weekly(
  linked: readonly MessagePick[],
  named: readonly NamedPick[],
  format: Partial<WeeklyMessageFormat> = {}
) {
  return renderWeeklyMessage({
    totalPicks: 10,
    ageLabels: ['2-4', '10-14'],
    areaLabel: 'Vancouver',
    directPicks: linked,
    namedPickCandidates: named,
    preferencesUrl: HUB,
    format,
  });
}

/** The longest LOGICAL line — the best available proxy for how many times a bubble wraps. */
const longestLine = (body: string) => Math.max(...body.split('\n').map((l) => l.length));
/** How many of the ten picks a parent can actually read: the linked ones plus the "Also:" runs. */
const namedCount = (body: string) =>
  3 +
  body
    .split('\n')
    .filter((l) => l.startsWith('Also: '))
    .reduce((n, l) => n + l.slice(6).split(', ').length, 0);

/** The format as it stood before any of this — B0 in the recommendation's table. */
const AS_SHIPPED: Partial<WeeklyMessageFormat> = {
  groupByDay: false,
  linkOnOwnLine: false,
  nameUnlinkedPicks: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// The normaliser. A live defect, independent of any format decision.
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeForGsm7', () => {
  it('maps the six known offenders, and the opening single quote the pinned list omits', () => {
    // The six are the exact set `weekly_send.test.ts` already pins in "detects the punctuation
    // that silently more than halves a segment".
    expect(normalizeForGsm7('a — b')).toBe('a - b');
    expect(normalizeForGsm7('a – b')).toBe('a - b');
    expect(normalizeForGsm7('don’t')).toBe("don't");
    expect(normalizeForGsm7('“quoted”')).toBe('"quoted"');
    expect(normalizeForGsm7('wait…')).toBe('wait...');
    // U+2018 is NOT in that list of six. It is handled anyway — the pair is the unit.
    expect(normalizeForGsm7('‘quoted’')).toBe("'quoted'");
    for (const offender of ['—', '–', '’', '‘', '“', '”', '…']) {
      expect(isGsm7(offender)).toBe(false); // the premise, checked rather than assumed
      expect(isGsm7(normalizeForGsm7(`Court 1 ${offender} Gym`))).toBe(true);
    }
  });

  it('does not add spaces around a dash that already has them', () => {
    // Round 4's comment describes the RESULT (" - "), not the replacement string. Mapping the em
    // dash to " - " would double every space in the real "this week — check back" shape.
    expect(normalizeForGsm7('this week — check back')).toBe('this week - check back');
    expect(normalizeForGsm7('Youth—Teen')).toBe('Youth-Teen');
  });

  it('collapses the INVISIBLE offenders, which are the ones nobody can see in a diff', () => {
    // Escapes, not the characters themselves: a literal U+00A0 here would be invisible to every
    // reviewer of this file, and it does not survive being copied between editors.
    expect(isGsm7('Trout\u00A0Lake')).toBe(false); // a scraped no-break space
    expect(normalizeForGsm7('Trout\u00A0Lake')).toBe('Trout Lake');
    expect(normalizeForGsm7('Gym\u200BBugs')).toBe('GymBugs');
    expect(normalizeForGsm7('\uFEFFBritannia')).toBe('Britannia');
  });

  it('strips an accent ONLY when GSM-7 cannot carry the letter', () => {
    // GSM 03.38's accented set is lopsided. "Café" is already free; "Français" is not.
    expect(isGsm7('Café')).toBe(true);
    expect(normalizeForGsm7('Café')).toBe('Café'); // untouched — the accent survives
    expect(isGsm7('Français')).toBe(false);
    expect(normalizeForGsm7('Français')).toBe('Francais');
    expect(normalizeForGsm7('Sen̓áḵw')).toBe('Senakw');
  });

  it('LEAVES a character it cannot fold, rather than handing a parent mojibake', () => {
    // Layer 3. A CJK venue name still costs UCS-2 — but replacing it would produce a name nobody
    // can read, which is a worse product than an expensive message. The cost stays VISIBLE:
    // `estimateSegments` is reported on every send and `nonGsm7Characters` names the survivor.
    const name = '海濱中心 – Court 1';
    const normalized = normalizeForGsm7(name);
    expect(normalized).toBe('海濱中心 - Court 1'); // the dash still got fixed
    expect(isGsm7(normalized)).toBe(false);
    expect(nonGsm7Characters(normalized)).toEqual(['海', '濱', '中', '心']);
  });

  it('is idempotent and leaves clean ASCII exactly alone', () => {
    for (const clean of [
      'Tai Chi Chuan - Beginners',
      'Roundhouse Community Arts and Recreation Centre',
      HUB,
      'Youth (13-18yrs) Open Gym - Tue/ Wed',
    ]) {
      expect(normalizeForGsm7(clean)).toBe(clean);
      expect(normalizeForGsm7(normalizeForGsm7(clean))).toBe(normalizeForGsm7(clean));
    }
  });
});

describe('the live catalogue defect the normaliser closes', () => {
  // "Westwind School - Gymnasium – Court 1" is verbatim from
  // worker/adapters/perfectmind/__fixtures__/richmond.classes.registered-visits.json. Eight
  // name-like strings in that one file carry an en dash; nothing on the render path touched them.
  const POISONED = 'Westwind School - Gymnasium – Court 1';

  it('ONE en dash in ONE venue name doubled the bill for the whole message', () => {
    const clean = weekly(LIVE_LINKED, [], AS_SHIPPED).body;
    const rendered = weekly(
      LIVE_LINKED.map((p, i) => (i === 0 ? { ...p, venue: POISONED } : p)),
      [],
      AS_SHIPPED
    ).body;

    // What the renderer produced BEFORE this change: the catalogue string, verbatim.
    const unfixed = rendered.replace('Gymnasium - Court', 'Gymnasium – Court');
    expect(unfixed).not.toBe(rendered); // the normaliser is what makes these two differ

    const before = estimateSegments(unfixed);
    const after = estimateSegments(rendered);

    expect(before.encoding).toBe('UCS-2');
    expect(before.segments).toBe(8);
    expect(after.encoding).toBe('GSM-7');
    expect(after.segments).toBe(4);
    expect(before.segments / after.segments).toBe(2); // the measured 2.00x, exactly

    // And it costs the clean message nothing: same 4 segments it always was.
    expect(estimateSegments(clean).segments).toBe(4);
    expect(estimateSegments(clean).characters).toBe(508);
  });

  it('the risk RISES with the format change, which is why they ship together', () => {
    // The recommendation's note: naming ten picks puts ten catalogue names in the body where
    // three used to be. Three chances to poison a send become ten.
    const poisonedTail = LIVE_NAMED.map((p, i) =>
      i === 6 ? { ...p, name: 'Volleyball Drop-in – Teens' } : p
    );
    const body = weekly(LIVE_LINKED, poisonedTail, {
      nameUnlinkedPicks: true,
      maxSegments: 4,
      shortenVenue: candidateShortener,
    }).body;
    expect(body).toContain('Volleyball Drop-in - Teens');
    expect(isGsm7(body)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Every character the new layout introduces.
// ─────────────────────────────────────────────────────────────────────────────

describe('GSM-7 safety of the layout itself', () => {
  it('every character this format introduces is in the basic table, at one septet', () => {
    // Checked against the real encoder rather than eyeballed against a table in a document.
    for (const ch of ['\n', ':', '-', '(', ')', '+', '&', ',', '*', '/', '>']) {
      expect(isGsm7(ch)).toBe(true);
      expect(septetLength(ch)).toBe(1);
    }
    // And the list markers that were considered and rejected. A single one of these converts the
    // entire message — which is why this format groups with capitalised day headers and line
    // breaks instead of a marker glyph.
    for (const ch of ['•', '–', '—', '→', '✓', '★', '…']) expect(isGsm7(ch)).toBe(false);
    // The extension table is GSM-7 but DOUBLE width — encodable, and a trap. Not used here.
    for (const ch of ['~', '[', ']', '|', '{', '}', '\\', '^', '€']) {
      expect(isGsm7(ch)).toBe(true);
      expect(septetLength(ch)).toBe(2);
    }
  });

  it('no line begins with whitespace — indentation is unreliable across receiving clients', () => {
    for (const format of [
      {},
      AS_SHIPPED,
      { nameUnlinkedPicks: true, maxSegments: 4, shortenVenue: candidateShortener },
    ]) {
      const body = weekly(LIVE_LINKED, LIVE_NAMED, format).body;
      expect(body.split('\n').filter((l) => /^[^\S\n]/.test(l))).toEqual([]);
    }
  });

  it('every shape of this message stays GSM-7', () => {
    for (const groupByDay of [true, false])
      for (const linkOnOwnLine of [true, false])
        for (const nameUnlinkedPicks of [true, false])
          for (const week of [
            [LIVE_LINKED, LIVE_NAMED] as const,
            [P90_LINKED, P90_NAMED] as const,
          ]) {
            const rendered = weekly(week[0], week[1], {
              groupByDay,
              linkOnOwnLine,
              nameUnlinkedPicks,
            });
            expect(rendered.encoding).toBe('GSM-7');
          }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The structure: what each move costs, measured one at a time.
// ─────────────────────────────────────────────────────────────────────────────

describe('the four moves, and what each one actually costs', () => {
  it('1. a link on its own line is EXACTLY free, and drops the longest line by 38 characters', () => {
    const inline = weekly(LIVE_LINKED, [], AS_SHIPPED);
    const broken = weekly(LIVE_LINKED, [], { ...AS_SHIPPED, linkOnOwnLine: true });
    // A newline and a space are one septet each. Not "about the same" — the same.
    expect(broken.characters).toBe(inline.characters);
    expect(broken.segments).toBe(inline.segments);
    expect(longestLine(inline.body)).toBe(121);
    expect(longestLine(broken.body)).toBe(83);
  });

  it('2. day headers pay for themselves — they REPLACE a "Sat: " prefix on every pick beneath', () => {
    const flat = weekly(LIVE_LINKED, [], { ...AS_SHIPPED, linkOnOwnLine: true });
    const grouped = weekly(LIVE_LINKED, [], { linkOnOwnLine: true, groupByDay: true });
    // Two headers and a blank line, minus three "Sat: "/"Sun: " prefixes. Net: 6 septets saved,
    // on a week with only three linked picks. It improves as more picks share a day.
    expect(flat.characters - grouped.characters).toBe(6);
    expect(grouped.segments).toBe(flat.segments);
  });

  it('3. the blank line between day groups costs ONE septet — and that is not always free', () => {
    const withBlank = weekly(LIVE_LINKED, [], { groupByDay: true, linkOnOwnLine: true });
    const withoutBlank = withBlank.body.replace(/\n\n/g, '\n');
    expect(withBlank.characters - estimateSegments(withoutBlank).characters).toBe(1);

    // ── WHERE THE RECOMMENDATION IS TOO GENEROUS TO ITSELF ────────────────────────────
    // It calls the blank line "+1 septet, basically free". One septet is free everywhere except
    // at a segment boundary, where it is worth a whole named pick: under a 3-segment cap the live
    // week fits FOUR named picks with the blank line and FIVE without it. Pinned so that the
    // tradeoff is a decision rather than a surprise.
    const capped = (blank: boolean) => {
      const body = weekly(LIVE_LINKED, LIVE_NAMED, {
        groupByDay: true,
        nameUnlinkedPicks: true,
        maxSegments: 3,
        shortenVenue: candidateShortener,
      }).body;
      return blank ? body : body.replace(/\n\n/g, '\n');
    };
    expect(estimateSegments(capped(true)).segments).toBe(3);
    expect(namedCount(capped(true))).toBe(4);
  });

  it('4. the named-pick fill spends the headroom rather than a second constant', () => {
    const budgeted = weekly(LIVE_LINKED, LIVE_NAMED, {
      nameUnlinkedPicks: true,
      maxSegments: 4,
      shortenVenue: candidateShortener,
    });
    expect(budgeted.segments).toBe(4);
    expect(namedCount(budgeted.body)).toBe(10); // all ten, at the segment count it already cost
    expect(budgeted.body).not.toContain('more & settings'); // nothing is left behind to count
    expect(budgeted.body).toContain('Settings:');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The measured before/after. These numbers are the deliverable.
// ─────────────────────────────────────────────────────────────────────────────

describe('measured: the LIVE week (Jon\'s test send) and the P90 week', () => {
  const rows = [
    // week, label, linked, named, format, septets, segments, named/10, longest line
    ['LIVE', 'B0 as shipped', LIVE_LINKED, LIVE_NAMED, AS_SHIPPED, 508, 4, 3, 121],
    ['LIVE', 'SHIPPED DEFAULT (day + own line)', LIVE_LINKED, LIVE_NAMED, {}, 502, 4, 3, 78],
    ['P90', 'B0 as shipped', P90_LINKED, P90_NAMED, AS_SHIPPED, 542, 4, 3, 129],
    ['P90', 'SHIPPED DEFAULT (day + own line)', P90_LINKED, P90_NAMED, {}, 536, 4, 3, 86],
  ] as const;

  it.each(rows)(
    '%s %s: %d septets, %d segments',
    (_week, _label, linked, named, format, septets, segments, visible, maxLine) => {
      const rendered = weekly(linked, named, format);
      expect(rendered.encoding).toBe('GSM-7');
      expect(rendered.characters).toBe(septets);
      expect(rendered.segments).toBe(segments);
      expect(namedCount(rendered.body)).toBe(visible);
      expect(longestLine(rendered.body)).toBe(maxLine);
    }
  );

  it('THE DEFAULT SHIPS AT NO COST: structure alone is 6 septets cheaper on both weeks', () => {
    for (const [linked, named] of [
      [LIVE_LINKED, LIVE_NAMED],
      [P90_LINKED, P90_NAMED],
    ] as const) {
      const before = weekly(linked, named, AS_SHIPPED);
      const after = weekly(linked, named, {});
      expect(after.segments).toBe(before.segments);
      expect(after.characters).toBe(before.characters - 6);
      expect(longestLine(after.body)).toBeLessThan(longestLine(before.body) - 40);
    }
  });

  it('with Jon\'s three answers switched on, the LIVE week names 10/10 for the same 4 segments', () => {
    const before = weekly(LIVE_LINKED, LIVE_NAMED, AS_SHIPPED);
    const after = weekly(LIVE_LINKED, LIVE_NAMED, {
      nameUnlinkedPicks: true,
      maxSegments: 4,
      shortenVenue: candidateShortener,
    });
    expect([before.characters, before.segments, namedCount(before.body)]).toEqual([508, 4, 3]);
    expect([after.characters, after.segments, namedCount(after.body)]).toEqual([556, 4, 10]);
    expect(longestLine(after.body)).toBe(87);
  });

  it('and the P90 week fills to the budget and then stops honestly, at 7/10', () => {
    const after = weekly(P90_LINKED, P90_NAMED, {
      nameUnlinkedPicks: true,
      maxSegments: 4,
      shortenVenue: candidateShortener,
    });
    expect([after.characters, after.segments, namedCount(after.body)]).toEqual([604, 4, 7]);
    expect(after.body).toContain('+3 more & settings:'); // the remainder is counted, not dropped
  });

  it('VENUE SHORTENING IS NOT LOAD-BEARING — 8/10 and 5/10 without it, same 4 segments', () => {
    // Worth knowing before Jon answers Q2: the naming win survives a "no" on the abbreviations.
    const live = weekly(LIVE_LINKED, LIVE_NAMED, { nameUnlinkedPicks: true, maxSegments: 4 });
    expect([live.characters, live.segments, namedCount(live.body)]).toEqual([610, 4, 8]);
    const p90 = weekly(P90_LINKED, P90_NAMED, { nameUnlinkedPicks: true, maxSegments: 4 });
    expect([p90.characters, p90.segments, namedCount(p90.body)]).toEqual([602, 4, 5]);
  });

  it('a 3-segment cap is NOT reachable on a long-name week, and says so rather than truncating', () => {
    // The recommendation's own honest limit. At P90 the message is over 459 septets with ZERO
    // extra picks named, purely from three long titles, three long venues and four URLs. The cap
    // governs the DISCRETIONARY part; it never drops a linked pick to hit a number.
    const p90 = weekly(P90_LINKED, P90_NAMED, {
      nameUnlinkedPicks: true,
      maxSegments: 3,
      shortenVenue: candidateShortener,
    });
    expect(p90.segments).toBe(4);
    expect(namedCount(p90.body)).toBe(3); // nothing discretionary was spent
    expect(p90.body.split('\n').filter((l) => l.startsWith(ORIGIN))).toHaveLength(4); // all 3 links + hub
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Grouping behaviour that no character count would catch.
// ─────────────────────────────────────────────────────────────────────────────

describe('day grouping', () => {
  it('orders the days CHRONOLOGICALLY, not by the rank of the first pick in each', () => {
    // The top-ranked pick here is on Sunday. A parent reading SUN above SAT is reading a bug.
    const sundayFirst = [LIVE_LINKED[1], LIVE_LINKED[0], LIVE_LINKED[2]];
    const headers = weekly(sundayFirst, [], {})
      .body.split('\n')
      .filter((l) => l === 'SAT' || l === 'SUN');
    expect(headers).toEqual(['SAT', 'SUN']);
  });

  it('puts a dateless open-hours pick LAST, under no header at all', () => {
    // `weekdayLabel` returns null for an aquarium. Printing "SAT" over it would invent a fact,
    // and inventing a word for the bucket ("ANYTIME") would be new consumer-facing copy.
    const openHours: MessagePick = {
      name: 'Vancouver Aquarium',
      venue: 'Stanley Park',
      startDatetimeUtc: null,
      url: link('0000000000009'),
    };
    const lines = weekly([LIVE_LINKED[0], openHours, LIVE_LINKED[1]], [], {}).body.split('\n');
    expect(lines.filter((l) => /^[A-Z]{3}$/.test(l))).toEqual(['SAT', 'SUN']);
    const aquarium = lines.findIndex((l) => l.startsWith('Vancouver Aquarium'));
    const sunday = lines.indexOf('SUN');
    expect(aquarium).toBeGreaterThan(sunday);
    expect(lines[aquarium - 1]).not.toMatch(/^[A-Z]{3}$/); // no header was invented for it
  });

  it('files a NAMED pick under its own day, not under the last linked pick\'s day', () => {
    const body = weekly([LIVE_LINKED[0]], LIVE_NAMED, {
      nameUnlinkedPicks: true,
      maxSegments: 4,
    }).body;
    const lines = body.split('\n');
    const satAlso = lines[lines.indexOf('SAT') + 3];
    expect(satAlso).toBe('Also: Family Play Time, Youth Badminton, Gym Bugs Drop In');
    expect(lines[lines.indexOf('SUN') + 1]).toMatch(/^Also: Parent and Tot Gym/);
  });

  it('does not emit an empty group, a trailing blank line, or a leading one', () => {
    const body = weekly(LIVE_LINKED, LIVE_NAMED, { nameUnlinkedPicks: true, maxSegments: 4 }).body;
    expect(body.startsWith('KIDS FUN:')).toBe(true);
    expect(body.endsWith('Reply STOP to end')).toBe(true);
    expect(body).not.toMatch(/\n\n\n/);
    expect(body.split('\n')[1]).not.toBe(''); // no blank before the first group
  });
});

describe('the budget fill', () => {
  it('"+N more" counts picks that are NOT IN THE TEXT, so naming one takes it out of the count', () => {
    // It was only ever equal to "picks without a link" because those used to be the same set.
    const capped = weekly(LIVE_LINKED, LIVE_NAMED, {
      nameUnlinkedPicks: true,
      maxSegments: 3,
      shortenVenue: candidateShortener,
    });
    expect(namedCount(capped.body)).toBe(4);
    expect(capped.body).toContain('+6 more & settings:'); // 10 total - 3 linked - 1 named
  });

  it('does NOT stop at the first overrun — the last named pick makes the body SHORTER', () => {
    // "+1 more & settings:" collapses to "Settings:" at exactly that step, so cost is not
    // monotonic and an early `break` would silently refuse to name the tenth pick of a week that
    // fits. This week is that week.
    const all = weekly(LIVE_LINKED, LIVE_NAMED, {
      nameUnlinkedPicks: true,
      maxSegments: 4,
      shortenVenue: candidateShortener,
    });
    const nine = weekly(LIVE_LINKED, LIVE_NAMED.slice(0, 6), {
      nameUnlinkedPicks: true,
      maxSegments: 4,
      shortenVenue: candidateShortener,
    });
    expect(namedCount(all.body)).toBe(10);
    expect(namedCount(nine.body)).toBe(9);
    expect(all.characters).toBeLessThan(nine.characters + 'Volleyball Drop-in, '.length);
  });

  it('is completely inert while nameUnlinkedPicks is off — today\'s behaviour, exactly', () => {
    const off = weekly(LIVE_LINKED, LIVE_NAMED, { nameUnlinkedPicks: false });
    const noCandidates = weekly(LIVE_LINKED, [], { nameUnlinkedPicks: true });
    expect(off.body).toBe(noCandidates.body);
    expect(off.body).toContain('+7 more & settings:');
  });

  it('never drops a linked pick to hit the cap, however small the cap', () => {
    const starved = weekly(LIVE_LINKED, LIVE_NAMED, {
      nameUnlinkedPicks: true,
      maxSegments: 1,
      shortenVenue: candidateShortener,
    });
    expect(starved.segments).toBeGreaterThan(1); // over budget, honestly
    for (const pick of LIVE_LINKED) expect(starved.body).toContain(pick.url);
    expect(starved.body).toContain('Reply STOP to end');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Where this file disagrees with the document it implements.
// ─────────────────────────────────────────────────────────────────────────────

describe('reconciliation with the 2026-09-10 recommendation', () => {
  // Its R1/R2 rows were measured with TWO copy choices this branch did not adopt, because both
  // are still with Jon: the reworded opener ("..., ages 2-4 & 10-14, near ...", 2 septets shorter)
  // and the hub label "All 10 + settings:" (9 septets longer than "Settings:"). Its §4 table also
  // predates its own blank line (+1). Every delta is one of those three — pinned here so a future
  // reader does not "fix" a number that was never wrong.
  const docOpener = (b: string) =>
    b.replace(
      'KIDS FUN: 10 picks this weekend for ages 2-4 & 10-14 near Vancouver.',
      'KIDS FUN: 10 picks this weekend, ages 2-4 & 10-14, near Vancouver.'
    );
  const docHub = (b: string) => b.replace('Settings:\n', 'All 10 + settings:\n');
  const noBlank = (b: string) => b.replace(/\n\n/g, '\n');

  it('reproduces the document EXACTLY once its two pending copy choices are applied', () => {
    const r1live = weekly(LIVE_LINKED, LIVE_NAMED, {
      nameUnlinkedPicks: true,
      maxSegments: 4,
      shortenVenue: candidateShortener,
    }).body;
    expect(estimateSegments(r1live).characters).toBe(556); // ours
    expect(estimateSegments(noBlank(docHub(docOpener(r1live)))).characters).toBe(562); // its §4 row
    expect(estimateSegments(docHub(docOpener(r1live))).characters).toBe(563); // its §4 sample

    const r1p90 = weekly(P90_LINKED, P90_NAMED, {
      nameUnlinkedPicks: true,
      maxSegments: 4,
      shortenVenue: candidateShortener,
    }).body;
    expect(estimateSegments(r1p90).characters).toBe(604); // ours
    expect(estimateSegments(noBlank(docOpener(r1p90))).characters).toBe(601); // its §4 row
  });

  it('R2 at cap 3 loses a named pick to the blank line and the un-reworded opener', () => {
    // Its row: 457 septets, 3 segments, 5/10 named. Ours: 443, 3 segments, 4/10. The three
    // septets of difference are the whole story, and they cross a segment boundary.
    let docEquivalent = { septets: 0, named: 0 };
    for (let n = 0; n <= LIVE_NAMED.length; n += 1) {
      const body = noBlank(
        docOpener(
          weekly(LIVE_LINKED, LIVE_NAMED.slice(0, n), {
            nameUnlinkedPicks: true,
            maxSegments: 99,
            shortenVenue: candidateShortener,
          }).body
        )
      );
      const measured = estimateSegments(body);
      if (measured.segments <= 3) docEquivalent = { septets: measured.characters, named: n + 3 };
    }
    expect(docEquivalent).toEqual({ septets: 457, named: 5 });
  });

  it('its P90 F2 row (483) predates its own annex-handling correction', () => {
    // 483 is what F2 measures when "West Point Grey Community Centre - Aberthau" is left whole;
    // the corrected shortener in the same document's R1 sample renders it "West Point Grey CC -
    // Aberthau" and the row should read 469. Its "max line 82" is the uncorrected one too.
    const stale = weekly(P90_LINKED, [], {
      ...AS_SHIPPED,
      linkOnOwnLine: true,
      shortenVenue: (v) =>
        v === 'West Point Grey Community Centre - Aberthau' ? v : candidateShortener(v),
    }).body;
    expect(estimateSegments(stale).characters).toBe(483);
    expect(longestLine(stale)).toBe(82);

    const corrected = weekly(P90_LINKED, [], {
      ...AS_SHIPPED,
      linkOnOwnLine: true,
      shortenVenue: candidateShortener,
    });
    expect(corrected.characters).toBe(469);
  });

  it('its F1 row (max line 87) left the HUB link inline; this format breaks before every URL', () => {
    // Applying the rule to the pick links but not the preferences link was an inconsistency, not
    // a measurement — moving it is free and takes the longest line from 87 to 83.
    const broken = weekly(LIVE_LINKED, [], { ...AS_SHIPPED, linkOnOwnLine: true });
    expect(longestLine(broken.body)).toBe(83);
    const hubInline = broken.body.replace('+7 more & settings:\n', '+7 more & settings: ');
    expect(longestLine(hubInline)).toBe(87);
    expect(estimateSegments(hubInline).characters).toBe(broken.characters); // free, either way
  });
});
