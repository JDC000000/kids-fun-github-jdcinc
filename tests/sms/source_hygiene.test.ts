// tests/sms/source_hygiene.test.ts — no invisible characters in the SMS source, ever.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────
// An invisible character in a source literal is unreviewable and it rots silently. Both halves
// of that matter, and this repo has now been bitten by both:
//
//   * UNREVIEWABLE. `GSM7_INVISIBLE_SUBSTITUTIONS` in lib/sms/message.ts shipped with its eight
//     keys written as the raw characters. Four of them rendered as `[' ', ' ']` — identical to
//     each other and to a plain space on every screen. The map whose whole job is handling
//     invisible characters could not itself be read.
//
//   * ROTS SILENTLY. A U+00A0 in a test literal was flattened to a plain space while the file was
//     being edited. The assertion inverted and the test went green while checking nothing. A
//     combining-mark literal had the same defect: strip the marks and the input already equals the
//     expected output, so it passes for the wrong reason.
//
// Neither is caught by a compiler, a linter, a type check or a passing suite. Careful review does
// not catch them either, because the whole problem is that there is nothing to see. So it is a
// test, and it covers the source rather than the behaviour.
//
// THE RULE: any character that cannot be SEEN must be written as a `\uXXXX` escape. Visible
// non-ASCII is fine and is not the target here — an em dash, a curly quote and a CJK venue name
// are all legible, and those are the fixtures these suites are made of.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Files this workstream owns. Cheap to extend; deliberately not a whole-repo walk.
 *
 * ── THIS LIST IS ALSO THE MANIFEST, AND THAT IS NOW ON PURPOSE ──────────────────────────
 * It began as a scan list and turned out to do a second job by accident: the scan reads each file,
 * so DELETING one made this suite fail with ENOENT. That accident is the only reason a
 * silently-vanished test file would ever have been noticed here.
 *
 * Most of the files listed above are the kind whose disappearance nothing else would catch. A test
 * that hardens an assertion, or guards against a situation that does not currently arise, adds a
 * FAILURE MODE rather than changing a behaviour — and CI only exercises situations that DO arise.
 * So if such a file vanished, every remaining test would pass and the loss would be invisible.
 * `substitution_table.test.ts` was exactly that: added after this list, never added TO it, and
 * therefore deletable without a trace until now.
 *
 * The existence check below makes the manifest role explicit instead of leaving it as a side
 * effect of `readFileSync`, so nobody later "fixes" the ENOENT with a try/catch and quietly
 * removes the anchor.
 *
 * AND THE LAST TURTLE IS CLOSED BY A SIBLING, not by leaving the repo. This file cannot detect its
 * own deletion — the detector goes with it — but `substitution_table.test.ts` asserts this file
 * exists, and this manifest lists that one, so the two anchor each other. An earlier version of
 * this comment concluded the anchor had to be external; that was true of SELF-detection and wrong
 * about the problem, and review caught it. The external anchor (branch and review SHAs) remains
 * the honest backstop for both files disappearing at once, which is a far less likely accident.
 */
const FILES = [
  'lib/sms/message.ts',
  'lib/sms/weekly-send.ts',
  'tests/sms/gsm7_normalizer.test.ts',
  'tests/sms/gsm7_render_equivalence.test.ts',
  'tests/sms/substitution_table.test.ts',
  'tests/sms/source_hygiene.test.ts',
];

/**
 * Is this character invisible — present in the bytes, absent from the screen?
 *
 * Tab and newline are structure and are excluded. Everything else here is either a control, a
 * format character, an exotic space, or a combining mark that attaches to whatever precedes it.
 */
function isInvisible(ch: string): boolean {
  const cp = ch.codePointAt(0) as number;
  if (ch === '\t' || ch === '\n' || ch === '\r') return false;
  if (ch === ' ') return false;
  if (cp < 0x20 || cp === 0x7f) return true; // C0 controls, including a literal NUL
  if (cp >= 0x80 && cp <= 0x9f) return true; // C1 controls
  return (
    /\p{Cf}/u.test(ch) || // format: zero-widths, BOM, bidi overrides
    /\p{Zs}/u.test(ch) || // any space that is not U+0020
    /\p{Zl}|\p{Zp}/u.test(ch) || // line/paragraph separators
    /\p{M}/u.test(ch) // combining marks
  );
}

describe('SMS source files carry no invisible characters', () => {
  it('every file in the manifest still exists', () => {
    // The anchor, stated outright. A file whose absence nothing else would notice is exactly the
    // kind that goes missing quietly -- to a bad merge, a stray revert, a restore race.
    const missing = FILES.filter((relative) => !existsSync(join(process.cwd(), relative)));
    expect(missing).toEqual([]);
  });

  it.each(FILES)('%s', (relative) => {
    const text = readFileSync(join(process.cwd(), relative), 'utf8');
    const offences: string[] = [];

    text.split('\n').forEach((line, index) => {
      [...line].forEach((ch, column) => {
        if (!isInvisible(ch)) return;
        const cp = (ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0');
        offences.push(
          `${relative}:${index + 1}:${column + 1} contains U+${cp} as a literal. ` +
            `Write it as '\\u${cp}' instead — see this file's header.`
        );
      });
    });

    expect(offences).toEqual([]);
  });

  it('detects a literal it is meant to detect, so a green result means something', () => {
    // The guard is only worth having if it can fail. Checked directly rather than trusted.
    //
    // EVERY PROBE IS BUILT FROM A CODEPOINT, not typed. This file is in FILES above and is held to
    // its own rule — a detector for invisible characters that had to smuggle invisible characters
    // into itself to be tested would be self-refuting, and exempting it would be worse.
    const ch = (cp: number) => String.fromCodePoint(cp);
    for (const cp of [
      0x00a0, // no-break space
      0x200b, // zero-width space
      0xfeff, // byte-order mark
      0x0000, // NUL, which turns a file binary
      0x0313, // lone combining mark
      0x202e, // right-to-left override
      0x2007, // figure space
    ]) {
      expect(isInvisible(ch(cp))).toBe(true);
    }

    // And that it does NOT fire on legible text, including the non-ASCII these suites depend on.
    // An em dash and a curly quote are the whole subject of the normaliser; they must stay readable.
    for (const visible of [' ', '\n', '\t', 'a', '-', '\u2014', '\u2019', '\u00E9', '\u6D77']) {
      expect(isInvisible(visible)).toBe(false);
    }
  });
});
