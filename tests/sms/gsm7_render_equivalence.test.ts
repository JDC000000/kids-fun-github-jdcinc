// tests/sms/gsm7_render_equivalence.test.ts — the normaliser changes NOTHING for clean catalogue
// text, proved against a frozen copy of the renderer as it stood before it existed.
//
// ── WHY THIS FILE EXISTS, AND WHY IT IS COMMITTED RATHER THAN RUN ONCE ──────────────────
// The claim this change ships on is "a parent cannot tell anything happened unless their text
// contained a character that was costing double". That claim was originally checked with a
// throwaway script that rendered a corpus from this branch and from `main`, diffed the two dumps,
// and was then deleted. The check was real and it passed — but a number in a report that nobody
// can re-derive is not evidence, it is a claim about evidence. So it lives here instead, where it
// runs on every commit and fails loudly.
//
// ── THE REFERENCE IS A FROZEN SNAPSHOT, ON PURPOSE ──────────────────────────────────────
// `referenceRenderWeeklyMessage` below is `renderWeeklyMessage` copied VERBATIM from main at
// 4a6e9ba — the commit this branch is based on — with nothing removed and nothing tidied. It is
// deliberately NOT refactored to share code with the real one, because a reference implementation
// that shares code with the thing it is checking proves nothing.
//
// It inlines the BRAND and STOP_LINE literals rather than importing them. That is intentional: if
// somebody edits either, this test fails, and it SHOULD — both are consumer-facing copy of record
// (PRD §1.4), and changing them is a decision, not a refactor. The failure message says so.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { renderWeeklyMessage, weekdayLabel, type MessagePick } from '@/lib/sms/message';

/**
 * `renderWeeklyMessage` exactly as main/4a6e9ba renders it — before `normalizeForGsm7` existed.
 *
 * Frozen. Do not "fix" this to match a future change to the real renderer; if the two diverge for
 * clean input, that divergence is the finding.
 */
function referenceRenderWeeklyMessage(input: {
  totalPicks: number;
  ageLabels: readonly string[];
  areaLabel: string;
  directPicks: readonly MessagePick[];
  preferencesUrl: string;
}): string {
  const ages = input.ageLabels.length > 0 ? ` for ages ${input.ageLabels.join(' & ')}` : '';
  const noun = input.totalPicks === 1 ? 'pick' : 'picks';
  const lines: string[] = [
    `KIDS FUN: ${input.totalPicks} ${noun} this weekend${ages} near ${input.areaLabel}.`,
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
  lines.push('Reply STOP to end');

  return lines.join('\n');
}

// ── The corpus. Real names from the real catalogue, every one already GSM-7 clean. ──────

const SAT = '2026-08-29T17:00:00Z';
const SUN = '2026-08-30T17:00:00Z';
const HUB = 'https://kidsfunapp.ca/u/Xk3pQ7mZ9vLdR2sTfN8hJ4wYc6BgA1eU0oPiKnMxQzE';

/** Real ActiveNet Vancouver venues, including the longest in the corpus and a null. */
const VENUES: ReadonlyArray<string | null> = [
  'Roundhouse Community Arts and Recreation Centre',
  'Coal Harbour Community Centre',
  'Britannia Community Centre',
  'Britannia Pool',
  'Hillcrest Aquatic Centre',
  'West Point Grey Community Centre - Aberthau',
  'RayCam Co-operative Centre',
  'Bonsor Recreation Complex',
  'Creekside Community Recreation Centre',
  'Trout Lake Rink',
  'Marpole-Oakridge Community Centre',
  'Lord Byng Pool',
  null, // the catalogue has no venue for this listing
];

/** Real activity titles, including ones carrying every GSM-7-safe punctuation mark we emit. */
const NAMES: readonly string[] = [
  'Tai Chi Chuan - Beginners',
  'Pickleball - 3.0+',
  'Roundhouse Community Dancers',
  'Youth (13-18yrs) Open Gym - Saturday',
  'Play Palace - 0-12 yrs',
  'Gym Bugs Drop In',
  'Parent and Tot Gym',
  'Friday Pre-teen Badminton Drop-in',
  'Volleyball Drop-in',
  "Kids' Night Out",
  'Art & Craft 50% Off',
  'Swim/Gym Combo',
];

interface Case {
  totalPicks: number;
  ageLabels: readonly string[];
  areaLabel: string;
  directPicks: MessagePick[];
  preferencesUrl: string;
}

/**
 * Every combination worth rendering: pick count, link count, age-label shape, area, and the
 * weekday patterns including all-dateless (which is the branch `weekdayLabel` returns null on).
 *
 * DEDUPLICATED. An earlier throwaway version of this generator emitted 864 cases, but 180 of them
 * were repeats — with zero linked picks the weekday pattern cannot affect the output, so the same
 * body was rendered four times. Counting those as separate evidence would be inflating the number,
 * so the generator drops them and the count below is bodies, not loops.
 */
function corpus(): Case[] {
  const cases: Case[] = [];
  const seen = new Set<string>();
  let n = 0;

  for (const totalPicks of [1, 3, 4, 6, 10]) {
    for (const linked of [0, 1, 2, 3]) {
      if (linked > totalPicks) continue;
      for (const ageLabels of [[], ['5-9'], ['2-4', '10-14'], ['2-4', '5-9', '10-14']]) {
        for (const areaLabel of ['East Van', 'Vancouver', 'North Vancouver']) {
          for (const days of [
            [SAT, SUN, SAT],
            [SUN, SUN, SUN],
            [null, SAT, SUN],
            [null, null, null],
          ]) {
            const directPicks: MessagePick[] = Array.from({ length: linked }, (_, i) => ({
              name: NAMES[(n + i) % NAMES.length],
              venue: VENUES[(n + i) % VENUES.length],
              startDatetimeUtc: days[i % 3],
              url: `https://kidsfunapp.ca/s/${String(1000000000000 + n + i).slice(0, 13)}`,
            }));
            n += 1;
            const c: Case = { totalPicks, ageLabels, areaLabel, directPicks, preferencesUrl: HUB };
            const key = referenceRenderWeeklyMessage(c);
            if (seen.has(key)) continue; // see the note above — a repeat is not extra evidence
            seen.add(key);
            cases.push(c);
          }
        }
      }
    }
  }
  return cases;
}

describe('the normaliser is invisible for clean catalogue text', () => {
  const CASES = corpus();

  it('renders 684 distinct messages, so the corpus is actually exercising the renderer', () => {
    // Pinned so the corpus cannot silently shrink to nothing and keep passing. If a future edit
    // changes the generator, this number changes deliberately and visibly.
    expect(CASES).toHaveLength(684);
    // Every shape that matters is present, not just the easy ones.
    expect(CASES.some((c) => c.directPicks.length === 0)).toBe(true); // "+N more" only
    expect(CASES.some((c) => c.totalPicks === c.directPicks.length)).toBe(true); // "Settings:"
    expect(CASES.some((c) => c.directPicks.some((p) => p.venue === null))).toBe(true);
    expect(CASES.some((c) => c.directPicks.some((p) => p.startDatetimeUtc === null))).toBe(true);
    expect(CASES.some((c) => c.ageLabels.length === 0)).toBe(true);
    expect(CASES.some((c) => c.totalPicks === 1)).toBe(true); // "1 pick", not "1 picks"
  });

  it('every one of them is BYTE-IDENTICAL to the renderer as it stood on main/4a6e9ba', () => {
    // This is the whole promise. Per-case rather than one hash, so a failure names the case.
    const divergent: string[] = [];
    for (const c of CASES) {
      const actual = renderWeeklyMessage(c).body;
      const expected = referenceRenderWeeklyMessage(c);
      if (actual !== expected) {
        divergent.push(
          `total=${c.totalPicks} linked=${c.directPicks.length} ages=[${c.ageLabels.join(',')}] ` +
            `area=${c.areaLabel}\n  main: ${JSON.stringify(expected)}\n  ours: ${JSON.stringify(actual)}`
        );
      }
    }
    expect(divergent).toEqual([]);
  });

  it('and the corpus checksum is pinned, so any report quoting it can be re-derived', () => {
    // The number a human repeats in a status update should be reproducible by running the suite,
    // not taken on trust from whoever ran it once.
    const digest = createHash('sha256')
            // NUL separator, written as an ESCAPE and never as the byte itself: a rendered body
      // contains newlines, so joining on one could in principle let two different corpora
      // hash alike. NUL cannot occur in a GSM-7 message. (An earlier draft of this line put
      // a real NUL in the source and turned the file binary -- the same mistake the
      // no-break-space test in gsm7_normalizer.test.ts documents. Escapes, always.)
      .update(CASES.map((c) => renderWeeklyMessage(c).body).join('\u0000'))
      .digest('hex');
    expect(digest).toBe('77e406d810c745fdb4fe31af9a226f047fe04ddf19c3e370e57ed4a4bc0c0aea');
  });
});
