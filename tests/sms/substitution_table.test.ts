// tests/sms/substitution_table.test.ts — the two substitution maps contain exactly what they claim.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────
// When the map keys in lib/sms/message.ts were changed from raw characters to `\uXXXX` escapes,
// the claim made for that change was "behaviour is unchanged" — checked by probing every codepoint
// before and after the edit and comparing the outputs. That check was real and it passed, and then
// it evaporated, because it lived in a scratch file that was deleted.
//
// That is the second time on this branch that the strongest evidence for a change was a number
// nobody could re-derive. Once is a mistake; twice is a habit, and the fix for a habit is a test.
//
// ── WHAT IT ACTUALLY PROVES, WHICH IS MORE THAN THE PROBE DID ───────────────────────────
// A one-off before/after probe can only say "these two moments agreed". This says something
// stronger and permanent: the source maps contain EXACTLY the codepoints in `TABLE` below, each
// maps to exactly its replacement, and none of them has degenerated into an identity mapping.
//
// NOTE THAT THIS PARAGRAPH NAMES NO COUNT. It used to say "seventeen", which was wrong -- there are
// fifteen -- and review caught it. A number restated in prose is a second source of truth that
// nothing checks, which is the exact failure this file was written to end. The count now lives in
// one asserted place below and nowhere else.
//
// That last point is the specific failure mode the escaping was defending against. A key flattened
// from U+00A0 to a plain space turns its entry into `[' ', ' ']` — which still compiles, still
// looks plausible, and silently stops normalising the character it was written for. Here it fails.
//
// The table is read out of the source file as well as exercised through the function, so a key
// that vanished from the map entirely cannot hide behind a passing behavioural assertion.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isGsm7, normalizeForGsm7 } from '@/lib/sms/message';

/**
 * Every codepoint the normaliser's two tables claim, with what it must become.
 *
 * Codepoints, never characters — for the reason documented at length in gsm7_normalizer.test.ts.
 */
const TABLE: ReadonlyArray<readonly [number, string, string]> = [
  // GSM7_SUBSTITUTIONS — the visible offenders. Six are the set the repo already pinned; U+2018
  // is the opening quote that list omits.
  [0x2014, 'em dash', '-'],
  [0x2013, 'en dash', '-'],
  [0x2019, 'curly apostrophe / right single quote', "'"],
  [0x2018, 'left single quote', "'"],
  [0x201c, 'left double quote', '"'],
  [0x201d, 'right double quote', '"'],
  [0x2026, 'ellipsis', '...'],
  // GSM7_INVISIBLE_SUBSTITUTIONS — the ones nobody can see in a diff.
  [0x00a0, 'no-break space', ' '],
  [0x2007, 'figure space', ' '],
  [0x2009, 'thin space', ' '],
  [0x202f, 'narrow no-break space', ' '],
  [0x200b, 'zero-width space', ''],
  [0x200c, 'zero-width non-joiner', ''],
  [0x200d, 'zero-width joiner', ''],
  [0xfeff, 'byte-order mark', ''],
];

const ch = (cp: number) => String.fromCodePoint(cp);

/**
 * The other half of a mutual anchor with `source_hygiene.test.ts`.
 *
 * That file's manifest lists THIS one, so deleting this file fails it. This assertion points back,
 * so deleting THAT file fails here. Neither can now vanish quietly on its own -- which matters
 * because both are the kind of test whose absence changes no behaviour and so breaks nothing else.
 *
 * Credit where due: an earlier version of this pair concluded that a file cannot detect its own
 * deletion and that the anchor therefore had to live outside the repo. That is true of SELF-
 * detection and false of the problem, which a sibling solves for the cost of three lines. The
 * external anchor -- branch and review SHAs -- is still the honest backstop for the case where both
 * files go at once, but it is no longer the first line of defence.
 */
const SIBLING_GUARD = 'tests/sms/source_hygiene.test.ts';

describe('the substitution tables', () => {
  it(`is mutually anchored with ${SIBLING_GUARD}`, () => {
    expect(existsSync(join(process.cwd(), SIBLING_GUARD))).toBe(true);
  });

  // Rows are objects so the title can name the codepoint in HEX. With positional `%s`, vitest
  // prints the number in decimal ("U+160" for a no-break space), which sends whoever reads the
  // failure looking for the wrong character.
  const ROWS = TABLE.map(([cp, name, replacement]) => ({
    codepoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
    name,
    cp,
    replacement,
  }));

  it.each(ROWS)('$codepoint ($name) is mapped, and really needed to be', ({ cp, replacement }) => {
    const input = ch(cp);

    // THE PREMISE. If this character were GSM-7 all along, mapping it would be pointless — and if
    // the key had flattened to an ASCII lookalike, this is where that shows up first.
    expect(isGsm7(input)).toBe(false);

    // THE MAPPING, on its own and in context, so a whitespace bug at the edges cannot hide.
    expect(normalizeForGsm7(input)).toBe(replacement);
    expect(normalizeForGsm7(`a${input}b`)).toBe(`a${replacement}b`);

    // NOT AN IDENTITY MAPPING. This is the exact degeneration the escaped keys defend against: a
    // collapsed key leaves the character untouched while every other assertion still looks fine.
    expect(normalizeForGsm7(input)).not.toBe(input);

    // And the result is actually sendable, which is the entire point of the exercise.
    expect(isGsm7(normalizeForGsm7(`Court 1 ${input} Gym`))).toBe(true);
  });

  it('the SOURCE maps contain exactly these codepoints — no more, no fewer', () => {
    // Behaviour alone cannot prove this. An entry deleted from a map and an entry that was never
    // there look identical from the outside, and a NEW entry nobody documented would pass every
    // assertion above by simply not being tested. So the source is read.
    const source = readFileSync(join(process.cwd(), 'lib/sms/message.ts'), 'utf8');

    const keysOf = (mapName: string): number[] => {
      const start = source.indexOf(`const ${mapName}`);
      expect(start).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf(']);', start));
      return [...body.matchAll(/\['\\u([0-9A-Fa-f]{4})'/g)].map((m) => parseInt(m[1], 16));
    };

    // The count, stated ONCE and checked, rather than in a comment where it silently rots.
    expect(TABLE).toHaveLength(15);

    const visible = keysOf('GSM7_SUBSTITUTIONS');
    const invisible = keysOf('GSM7_INVISIBLE_SUBSTITUTIONS');

    expect(visible).toEqual([0x2014, 0x2013, 0x2019, 0x2018, 0x201c, 0x201d, 0x2026]);
    expect(invisible).toEqual([0x00a0, 0x2007, 0x2009, 0x202f, 0x200b, 0x200c, 0x200d, 0xfeff]);

    // And the two together are exactly the table above, so this file cannot drift from the source.
    expect([...visible, ...invisible].sort((a, b) => a - b)).toEqual(
      TABLE.map(([cp]) => cp).sort((a, b) => a - b)
    );
  });

  it('every key in the source is written as an escape, never as the character', () => {
    // The regex above only matches `['\uXXXX'`. If a key were ever committed as a raw character it
    // would not be counted, the list would come back short, and the previous test would fail —
    // but that failure would read as "an entry went missing", which is the wrong diagnosis. This
    // says the real thing directly.
    const source = readFileSync(join(process.cwd(), 'lib/sms/message.ts'), 'utf8');
    for (const mapName of ['GSM7_SUBSTITUTIONS', 'GSM7_INVISIBLE_SUBSTITUTIONS']) {
      const start = source.indexOf(`const ${mapName}`);
      const body = source.slice(start, source.indexOf(']);', start));
      const entries = [...body.matchAll(/^\s*\[/gm)];
      const escaped = [...body.matchAll(/\['\\u[0-9A-Fa-f]{4}'/g)];
      expect(`${mapName}: ${escaped.length} of ${entries.length} keys escaped`).toBe(
        `${mapName}: ${entries.length} of ${entries.length} keys escaped`
      );
    }
  });
});
