// tests/compliance/cost-exhaustiveness-guard.test.ts — pins the U4 cost exhaustiveness guard.
//
// THE GUARANTEE, STATED NARROWLY ON PURPOSE: the two formatters that turn a `CostRead` into words
// a parent reads — app/preview/_data/format.ts and lib/email/format.ts — keep the U4 exhaustiveness
// guard both PRESENT and IN FORCE inside `formatCost`'s own body. Four ways to undo it fail this
// file by name:
//   • the `never` assignment is DELETED;
//   • the value it is fed is SHADOWED, so the assignment survives and proves nothing;
//   • a `@ts-ignore` / `@ts-expect-error` switches it OFF while leaving it in place;
//   • `case 'unstated':` is RE-FUSED with `default:` — either order, either spelling.
//
// WHAT IT DOES NOT, AND CANNOT, ENFORCE. The first draft of this header claimed the broader
// property — "the guard that makes a NEW `CostRead` arm a BUILD failure" — and independent QA
// measured a third exit from that claim which no assertion here was watching (`// @ts-ignore` above
// the guard: this file green, eslint exit 0, and with a fifth arm BOTH TS2322 errors gone). The two
// bypasses QA measured are now watched, and the claim is narrowed to match, because a header that
// outruns its file is the exact defect this repo has already been bitten by twice.
//
// This is a SOURCE-TEXT scanner. It pins the guard's SHAPE and its SETTING; it cannot prove the
// type-level consequence, because no test can add a fifth `CostRead` arm without editing production
// code. A file-level `// @ts-nocheck`, a loosened tsconfig, or a CI job that stops running `tsc`
// each defeat the guarantee without touching `formatCost`'s body, and NONE of them are watched
// here. That is deliberate and it is where this file stops: the target is the benign author making
// an unfamiliar compiler error go away, not a determined one. A scanner can always lose that second
// argument, and chasing it would trade real coverage for theatre.
//
// WHY THIS FILE EXISTS. Nothing else in the repo notices if the guard goes. Measured, not
// argued (U4 QA verdict): delete both `never` assignments and `tsc --noEmit`, `eslint .` and the
// whole suite stay green; fully revert the split and the suite's output is BYTE-IDENTICAL to the
// unreverted commit — not one of 2491 passing tests notices the unit was undone. The suite is
// not asleep: tampering with a single cost LABEL still produces 18 named failures in
// tests/cost-honesty-matrix.test.tsx. It simply had nothing pointed at the guard itself.
// eslint structurally cannot cover it either — the resolved config for these two files is
// `next/core-web-vitals` and nothing else, which carries no rule in the `no-unused-vars` family.
// (Which is also why the `void unhandledArm;` line beside the guard is inert today, and why this
// file deliberately does NOT pin it: removing it regresses nothing, so failing on it would be a
// nuisance. The load-bearing half is the `never` assignment, and that is what is pinned.)
//
// AND THE REGRESSION LOOKS BENIGN, WHICH IS WHY IT IS LIKELY. The next queued cost change IS a
// new `CostRead` arm. Whoever adds it meets `TS2322: Type '...' is not assignable to type
// 'never'`, does not recognise the idiom, deletes the assignment to make the build pass — and
// lands back in exactly the fused behaviour that already shipped one Free-mislabel through the
// weekly digest. Both surfaces are semi-irreversible: the digest is an email, and the card
// formatter reaches the public activity page's <title> / description / OpenGraph tags via
// app/preview/_data/detail-metadata.ts, so a wrong cost label has left the app the moment a
// parent shares the URL or a crawler caches the preview.
//
// >>> COMMENTS ARE MASKED, AND THAT IS THE WHOLE DIFFICULTY OF WRITING THIS FILE. <<<
// Both guarded files contain the literal text `case 'unstated': default:` INSIDE the comment
// that explains why the two must not be fused (app/preview/_data/format.ts:93,
// lib/email/format.ts:76). A scanner that reads raw text therefore fires on a PRISTINE tree —
// loud, and fixed in a minute. The tempting fix is the dangerous one: narrowing the pattern to
// require both on the SAME LINE stops the noise and quietly stops catching a real re-fusion,
// because the natural formatting a reverting author writes is two lines:
//
//     case 'unstated':
//     default:
//
// So the pattern stays wide and the COMMENTS are removed instead. (C) proves that decision by
// feeding a two-line re-fusion of each real file's OWN source back through the scanner.
//
// SHAPE — the same shape as tests/compliance/venue-geo-authority-declared.test.ts, deliberately:
//
//   (A) THE GUARD IS PRESENT AND IN FORCE, per surface, located inside `formatCost`'s own body
//       rather than anywhere in the file, and matched by SHAPE (a `never`-typed binding fed from
//       the value the switch discriminates on) rather than by the variable's name — so renaming
//       `unhandledArm` or `read` is not a false alarm, while a guard fed from something other
//       than the switched value does not count. Two things make "present" mean "in force":
//       the subject must be bound exactly ONCE and from `readCost()` (a rebinding shadows the
//       CostRead, and a guard fed from `undefined as never` type-checks while proving nothing),
//       and no TS suppression directive may sit in the body (it silences the guard in place).
//
//   (B) THE SPLIT SHAPE IS INTACT — the `unstated` arm still exists and is NOT fused onto
//       `default:`, in the one-line spelling, the two-line spelling, or the reversed order
//       (`default:` written ABOVE the arm, which falls through identically).
//
//   (C) TRIPWIRE SELF-CHECK. Both scanners are run against mutated copies of the REAL sources
//       (guard deleted; arms re-fused across two lines) and against synthetic snippets for the
//       comment / string / wrong-subject cases. A scanner nobody has watched fail is a scanner
//       nobody should trust — and one that has only ever been watched fail on toy snippets has
//       not been watched fail on the file it actually polices.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

/** The two surfaces that turn a `CostRead` into words a parent reads. */
const GUARDED_SURFACES = ['app/preview/_data/format.ts', 'lib/email/format.ts'];

/**
 * Blank out comment content — and optionally string-literal content — preserving length and
 * delimiters, so byte offsets stay valid across both copies. Copied in shape from
 * tests/compliance/venue-geo-authority-declared.test.ts, which needs the same two views:
 *
 *   • comment-masked — string content survives, so `case 'unstated':` is still READABLE.
 *   • string-masked  — string content is blanked, so prose that merely QUOTES a pattern is not
 *     mistaken for the code doing it, and a `{` or `}` inside a string cannot move a brace walk.
 *
 * Masking rather than deleting is load-bearing: the two copies are cross-referenced by offset
 * (see `codeMatches`), which only works while both are the same length as the source.
 */
function maskRegions(src: string, opts: { strings: boolean }): string {
  const out = src.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    const q = src[i];
    if (q === "'" || q === '"' || q === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === q) break;
        j += 1;
      }
      if (opts.strings) blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** The value a `switch (X.kind)` discriminates on — the only thing a real guard may be fed. */
const SWITCH_SUBJECT = /switch\s*\(\s*([A-Za-z_$][\w$]*)\s*\.\s*kind\s*\)/;

/**
 * `formatCost`'s BODY, read two ways. Scoping to the body matters: both files legitimately fuse
 * a `default:` onto some OTHER label elsewhere (`case 'unknown':` in lib/email/format.ts's
 * `unstatedCostLabel`; `case 'none':` and `case 'candidate':` in the preview formatter's
 * `bookingTag` / `confidenceMeta`), and a file-wide scan would have to be blunted to tolerate
 * them — blunting the scanner is the one thing this file must not do.
 */
interface FormatCostBody {
  /** Untouched source. The ONLY view in which a comment — and so a TS directive — is visible. */
  readonly raw: string;
  /** Comment-masked; string content intact, so `case 'unstated':` is readable. */
  readonly keys: string;
  /** Comment- AND string-masked; only real code survives. Same length as `keys`. */
  readonly code: string;
  /** The identifier the switch discriminates on (`read` in both files today), or null. */
  readonly subject: string | null;
}

/**
 * Locate `formatCost`'s body, or return null. Null rather than an empty string on purpose: every
 * check in this file is an ABSENCE claim about that slice, so a rename or a restructure has to
 * fail LOUDLY instead of quietly making all of them vacuous. (A)'s first test asserts on it.
 */
function formatCostBody(src: string): FormatCostBody | null {
  const keys = maskRegions(src, { strings: false });
  const code = maskRegions(src, { strings: true });
  const declaration = /export\s+function\s+formatCost\s*\(/.exec(code);
  if (!declaration) return null;
  // Braces are walked over the STRING-MASKED copy so a brace inside a string literal cannot move
  // the window (the F2a lesson from the venue-geo scanner, borrowed rather than re-learnt).
  const start = code.indexOf('{', declaration.index + declaration[0].length - 1);
  if (start === -1) return null;
  let end = start;
  let depth = 0;
  for (; end < code.length; end += 1) {
    if (code[end] === '{') depth += 1;
    else if (code[end] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (end >= code.length) return null; // unbalanced — better to fail than to scan half a body
  return {
    raw: src.slice(start, end + 1),
    keys: keys.slice(start, end + 1),
    code: code.slice(start, end + 1),
    subject: SWITCH_SUBJECT.exec(code.slice(start, end + 1))?.[1] ?? null,
  };
}

/**
 * Matches of `pattern` inside the body that are REAL CODE rather than string content.
 *
 * Patterns are located in the comment-masked copy (string content survives, so a quoted `case`
 * LABEL is still readable) and then filtered by the model file's discriminator: the match's last
 * character is a `:`, which survives masking when it is code and is blanked to a space when it
 * sits inside a string literal. ALL matches are walked, not just the first — otherwise a string
 * that merely mentions the fused form, sitting above a real re-fusion, would hide it.
 */
function codeMatches(body: FormatCostBody, pattern: RegExp): number[] {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const hits: number[] = [];
  for (let m = re.exec(body.keys); m; m = re.exec(body.keys)) {
    if (body.code[m.index + m[0].length - 1] === ':') hits.push(m.index);
  }
  return hits;
}

/**
 * `case 'unstated':` fused onto `default:` — ANY spelling: same line, across lines, and in EITHER
 * ORDER. The reversed form (`default:` written above the arm) falls through identically, compiles
 * clean and is a real shippable revert; it was reported by QA as a gap in the first version, which
 * only looked for the arm-then-default order.
 */
const FUSED_ARMS = /case\s*(['"`])unstated\1\s*:\s*default\s*:|default\s*:\s*case\s*(['"`])unstated\2\s*:/;
/** The `unstated` arm itself — deleting it outright is a third way to undo the split. */
const UNSTATED_ARM = /case\s*(['"`])unstated\1\s*:/;

/**
 * True when the body still carries the exhaustiveness guard: a `never`-typed binding fed from
 * the value the switch discriminates on. Tested against the fully-masked copy, so neither a
 * commented-out guard nor one quoted in a string can satisfy it.
 */
function hasNeverGuard(body: FormatCostBody): boolean {
  if (!body.subject) return false;
  return new RegExp(`const\\s+[A-Za-z_$][\\w$]*\\s*:\\s*never\\s*=\\s*${body.subject}\\s*;`).test(body.code);
}

function fusedArms(body: FormatCostBody): boolean {
  return codeMatches(body, FUSED_ARMS).length > 0;
}

function hasUnstatedArm(body: FormatCostBody): boolean {
  return codeMatches(body, UNSTATED_ARM).length > 0;
}

/**
 * TypeScript suppression directives sitting in a COMMENT inside the body — the third exit from the
 * guarantee, measured by QA on the real files: `// @ts-ignore` above the guard leaves this file
 * green, `eslint` exit 0 (no `@typescript-eslint/ban-ts-comment` resolves for these files), and
 * with a fifth `CostRead` arm BOTH TS2322 errors simply do not appear. The guard is still there and
 * no longer does anything, which is worse than deleting it: it reads as protection.
 *
 * "In a comment" is required, not merely "in the body", using the third view: masking preserves
 * length, so a directive that was blanked in `keys` was comment content, while one that survived is
 * a string or an identifier and cannot suppress anything. A tripwire that fires on a doc string
 * mentioning `@ts-ignore` is a tripwire people start disabling.
 *
 * `@ts-nocheck` is deliberately NOT included: it only takes effect at the top of a file, so
 * matching it inside a body would be theatre. It is named in this file's header as unwatched.
 */
function suppressionDirectives(body: FormatCostBody): string[] {
  const re = /@ts-(?:ignore|expect-error)/g;
  const found: string[] = [];
  for (let m = re.exec(body.raw); m; m = re.exec(body.raw)) {
    if (body.keys[m.index] === ' ') found.push(m[0]);
  }
  return found;
}

/**
 * Every initialiser the switch subject is bound from, inside the body. There must be exactly ONE,
 * and it must be `readCost(...)`.
 *
 * Why counting matters (QA finding 2): `hasNeverGuard` proves a `never` binding is fed from the
 * IDENTIFIER the switch reads, which is not the same as proving it is fed from the CostRead. Drop
 * `const read = undefined as never;` into the default block and the guard type-checks forever,
 * both TS2322 errors vanish with a fifth arm, and the shape check still says yes — because the name
 * it checks now refers to the shadow. The decoy test covers a differently-NAMED source; this covers
 * the same name rebound, which is the half that was missing.
 */
function subjectBindings(body: FormatCostBody): string[] {
  if (!body.subject) return [];
  const re = new RegExp(`(?:const|let|var)\\s+${body.subject}\\b[^=;{]*=\\s*([^;\\n]*)`, 'g');
  const initialisers: string[] = [];
  for (let m = re.exec(body.code); m; m = re.exec(body.code)) initialisers.push(m[1].trim());
  return initialisers;
}

function readSurface(file: string): string {
  return readFileSync(resolve(ROOT, file), 'utf8');
}

function bodyOf(file: string): FormatCostBody {
  const body = formatCostBody(readSurface(file));
  if (!body) throw new Error(`${file}: formatCost's body could not be located — this test is now blind to it`);
  return body;
}

describe('(A) both cost surfaces still carry the exhaustiveness guard', () => {
  it('the guarded files exist and formatCost is where this test thinks it is', () => {
    // Anti-vacuity. Every assertion below is an absence claim about a slice of text; if the
    // slice were empty, or the wrong function, they would all pass while measuring nothing.
    for (const file of GUARDED_SURFACES) {
      expect(existsSync(resolve(ROOT, file)), `${file} is gone or has moved — repoint this test`).toBe(true);
      const body = formatCostBody(readSurface(file));
      expect(body, `${file}: could not locate formatCost's body`).not.toBeNull();
      expect(body?.keys.length ?? 0, `${file}: formatCost's body is implausibly short`).toBeGreaterThan(200);
      expect(body?.keys, `${file}: formatCost no longer delegates to readCost()`).toMatch(/readCost\s*\(/);
      expect(body?.keys, `${file}: formatCost no longer switches on the CostRead`).toMatch(/switch\s*\(/);
      expect(body?.subject, `${file}: no \`switch (x.kind)\` — the guard's subject is unknown`).not.toBeNull();
    }
  });

  it('formatCost assigns the CostRead to `never` in its default arm, on BOTH surfaces', () => {
    const missing: string[] = [];
    for (const file of GUARDED_SURFACES) {
      const body = bodyOf(file);
      if (!hasNeverGuard(body)) {
        missing.push(
          `${file} — formatCost no longer assigns \`${body.subject ?? 'the CostRead'}\` to \`never\`: ` +
            'the exhaustiveness guard is GONE, and a new CostRead arm will now compile into a silent mislabel'
        );
      }
    }
    expect(
      missing,
      'the U4 exhaustiveness guard has been deleted. If you hit `TS2322: not assignable to type never`, ' +
        'that IS the guard working: the switch is missing an arm — add words for the new CostRead kind, ' +
        'do not delete the assignment.'
    ).toEqual([]);
  });

  it('the guard is fed by the real CostRead — the subject is bound ONCE, from readCost()', () => {
    // "Present" is not "in force". A guard fed from a shadow compiles forever and protects nothing.
    const shadowed: string[] = [];
    for (const file of GUARDED_SURFACES) {
      const body = bodyOf(file);
      const bindings = subjectBindings(body);
      if (bindings.length !== 1) {
        shadowed.push(
          `${file} — \`${body.subject}\` is bound ${bindings.length} time(s) inside formatCost ` +
            `(${bindings.join(' | ') || 'none'}): a rebinding SHADOWS the CostRead, so the guard below it ` +
            'type-checks against the shadow and stops proving the switch is exhaustive'
        );
      } else if (!/^readCost\s*\(/.test(bindings[0])) {
        shadowed.push(
          `${file} — \`${body.subject}\` is no longer bound from readCost(); it is bound from ` +
            `\`${bindings[0]}\`, so the guard no longer says anything about the real CostRead union`
        );
      }
    }
    expect(shadowed, 'the value the exhaustiveness guard is fed is no longer the CostRead').toEqual([]);
  });

  it('no TypeScript suppression directive sits inside either formatCost body', () => {
    // The bypass that leaves the guard visibly in place and silently switched off.
    const suppressed: string[] = [];
    for (const file of GUARDED_SURFACES) {
      const body = bodyOf(file);
      for (const directive of suppressionDirectives(body)) {
        suppressed.push(
          `${file} — \`${directive}\` inside formatCost: it switches the exhaustiveness guard OFF while ` +
            'leaving it in place, so a new CostRead arm produces NO error on this surface at all'
        );
      }
    }
    expect(
      suppressed,
      'a TS suppression directive is disarming the guard. If you reached for it because of ' +
        '`TS2322: not assignable to type never`, that error IS the guard working — the switch is missing ' +
        'an arm. Give the new CostRead kind words instead of silencing the check.'
    ).toEqual([]);
  });
});

describe("(B) `case 'unstated':` is not re-fused with `default:`", () => {
  it('the unstated arm still exists and still returns before the default arm', () => {
    const broken: string[] = [];
    for (const file of GUARDED_SURFACES) {
      const body = bodyOf(file);
      if (!hasUnstatedArm(body)) {
        broken.push(`${file} — formatCost has no \`case 'unstated':\` arm at all; it now falls through to default`);
      } else if (fusedArms(body)) {
        broken.push(
          `${file} — \`case 'unstated':\` has been FUSED onto \`default:\`, which is the U4 revert: ` +
            'a new CostRead arm is swallowed as "we hold no price" and the surface silently mislabels it'
        );
      }
    }
    expect(broken, 'the split between the unstated arm and the default arm has been undone').toEqual([]);
  });

  it('the fused phrase IS present in each file as prose — and the scanner is not fooled by it', () => {
    // The positive control for the check above, which is otherwise an empty-grep claim. Both
    // files quote `case 'unstated': default:` inside the comment explaining why the two must not
    // be fused, so a scanner that did not mask comments would fire on a pristine tree. Asserting
    // the phrase is really there proves the green above is EARNED by the masking rather than by
    // the phrase happening to be absent.
    for (const file of GUARDED_SURFACES) {
      expect(
        readSurface(file),
        `${file} no longer quotes the fused form anywhere. Either the guard's explanatory comment was ` +
          'rewritten (fine — move this control to a synthetic snippet in (C)) or the whole guard block was ' +
          'deleted (not fine — see the failures above).'
      ).toMatch(/case 'unstated': default:/);
      expect(fusedArms(bodyOf(file)), `${file}: a COMMENT must not count as a re-fusion`).toBe(false);
    }
  });
});

describe('(C) tripwire self-check — the scanners actually catch what they claim to', () => {
  // ── against the REAL sources, mutated in memory ─────────────────────────────────────

  /** Scenario (A): the realistic regression — the assignment deleted to make TS2322 stop. */
  function deleteGuard(src: string): string {
    return src
      .replace(/^[ \t]*const\s+[A-Za-z_$][\w$]*\s*:\s*never\s*=\s*[A-Za-z_$][\w$]*\s*;[ \t]*\r?\n/m, '')
      .replace(/^[ \t]*void\s+[A-Za-z_$][\w$]*\s*;[ \t]*\r?\n/m, '');
  }

  /** Scenario (B): the full revert, written the way a reverting author writes it — two lines. */
  function refuseArms(src: string): string {
    return src.replace(/(case\s*'unstated'\s*:)[\s\S]*?(?=\n[ \t]*default\s*:)/, '$1');
  }

  it('(A) deleting the guard from the REAL file is caught, on both surfaces', () => {
    for (const file of GUARDED_SURFACES) {
      const raw = readSurface(file);
      const mutated = deleteGuard(raw);
      expect(
        mutated,
        `${file}: the guard-deletion mutation changed nothing, so this tripwire proves nothing — either its ` +
          'pattern has drifted from the guard\'s shape, or the guard is ALREADY gone (see (A) above)'
      ).not.toBe(raw);
      const body = formatCostBody(mutated);
      expect(body, `${file}: the mutated file must still HAVE a formatCost body`).not.toBeNull();
      expect(body ? hasNeverGuard(body) : true, `${file}: guard deletion went UNDETECTED`).toBe(false);
      // …and the pristine file is the control: the same scanner says yes to it.
      expect(hasNeverGuard(bodyOf(file)), `${file}: the scanner says no to the PRISTINE file`).toBe(true);
    }
  });

  it('(B) re-fusing the REAL file across TWO LINES is caught, on both surfaces', () => {
    // THE TRAP THIS FILE WAS WRITTEN AROUND. A scanner narrowed to same-line matching — the
    // obvious way to dodge the comment — passes this mutation happily. This is the mutation an
    // actual revert produces, taken from the real file rather than from a snippet, so the
    // scanner is watched failing on the exact text it polices.
    for (const file of GUARDED_SURFACES) {
      const raw = readSurface(file);
      const mutated = refuseArms(raw);
      expect(
        mutated,
        `${file}: the re-fusion mutation changed nothing, so this tripwire proves nothing — either its pattern ` +
          'has drifted, or the arms are ALREADY fused (see (B) above)'
      ).not.toBe(raw);
      expect(mutated, `${file}: the mutation must produce the TWO-LINE fused form`).toMatch(
        /case 'unstated':\n[ \t]*default\s*:/
      );
      const body = formatCostBody(mutated);
      expect(body, `${file}: the mutated file must still HAVE a formatCost body`).not.toBeNull();
      expect(body ? fusedArms(body) : false, `${file}: a two-line re-fusion went UNDETECTED`).toBe(true);
      expect(fusedArms(bodyOf(file)), `${file}: the scanner fires on the PRISTINE file`).toBe(false);
    }
  });

  // ── against synthetic snippets, for the cases the real files cannot demonstrate ─────

  const SPLIT = `
export function formatCost(listing: ListingRecord): string {
  const read = readCost(listing);
  switch (read.kind) {
    case 'free':
      return 'Free';
    case 'unstated':
      return 'Cost not listed';
    default: {
      const unhandledArm: never = read;
      void unhandledArm;
      return 'Cost not listed';
    }
  }
}`;

  /**
   * Apply edits to the snippet, asserting each one LANDED. A replacement whose pattern quietly
   * stopped matching would leave the pristine snippet behind and turn its test green for the
   * wrong reason — the synthetic half of the same vacuity hole `formatCostBody` guards.
   */
  const mutate = (edits: [RegExp, string][]): string =>
    edits.reduce((src, [from, to]) => {
      const next = src.replace(from, to);
      expect(next, `snippet mutation did not apply: ${String(from)}`).not.toBe(src);
      return next;
    }, SPLIT);

  const inspect = (src: string): FormatCostBody => {
    const body = formatCostBody(src);
    expect(body, 'the snippet must parse — a null body would make the assertion vacuous').not.toBeNull();
    if (!body) throw new Error('unreachable');
    return body;
  };

  it('accepts the split shape, including renamed bindings', () => {
    expect(hasNeverGuard(inspect(SPLIT))).toBe(true);
    expect(fusedArms(inspect(SPLIT))).toBe(false);
    expect(hasUnstatedArm(inspect(SPLIT))).toBe(true);
    // The guard is matched by SHAPE, not by name: `unhandledArm` and `read` may both be renamed
    // without this file needing an edit.
    const renamed = mutate([
      [/const read = readCost\(listing\);/, 'const costRead = readCost(listing);'],
      [/switch \(read\.kind\)/, 'switch (costRead.kind)'],
      [/const unhandledArm: never = read;/, 'const exhaustive: never = costRead;'],
      [/void unhandledArm;/, 'void exhaustive;'],
    ]);
    expect(hasNeverGuard(inspect(renamed)), 'a renamed guard is still a guard').toBe(true);
  });

  it('rejects a `never` assignment fed by something OTHER than the switched value', () => {
    // A guard fed from the wrong value proves nothing about the switch's exhaustiveness — it is
    // a decoy that would hold this test green while the real protection was gone.
    const decoy = mutate([[/const unhandledArm: never = read;/, 'const unhandledArm: never = other;']]);
    expect(hasNeverGuard(inspect(decoy))).toBe(false);
  });

  it('catches the guard being deleted, and is not satisfied by a COMMENT or a STRING', () => {
    const deleted = mutate([[/const unhandledArm: never = read;\n\s*void unhandledArm;\n/, '']]);
    expect(hasNeverGuard(inspect(deleted))).toBe(false);
    const commented = mutate([[/const unhandledArm: never = read;/, '// const unhandledArm: never = read;']]);
    expect(hasNeverGuard(inspect(commented)), 'a commented-out guard is not a guard').toBe(false);
    const stringified = mutate([
      [/const unhandledArm: never = read;/, "const note = 'const unhandledArm: never = read;';"],
    ]);
    expect(hasNeverGuard(inspect(stringified)), 'a guard quoted in a string is not a guard').toBe(false);
  });

  it('catches the fused arms in BOTH spellings — one line and two', () => {
    const oneLine = mutate([
      [/case 'unstated':\n\s*return 'Cost not listed';\n\s*default: \{/, "case 'unstated': default: {"],
    ]);
    expect(fusedArms(inspect(oneLine)), 'the one-line spelling').toBe(true);
    const twoLine = mutate([[/case 'unstated':\n\s*return 'Cost not listed';/, "case 'unstated':"]]);
    expect(fusedArms(inspect(twoLine)), 'the two-line spelling is the one a revert produces').toBe(true);
  });

  it('is not tripped by prose that merely MENTIONS the fused form', () => {
    const inComment = mutate([
      [/case 'unstated':/, "// fused (`case 'unstated': default:`) swallows a new arm\n    case 'unstated':"],
    ]);
    expect(fusedArms(inspect(inComment)), 'a comment quoting the fused form is not a fusion').toBe(false);
    const inString = mutate([
      [
        /const read = readCost\(listing\);/,
        'const why = "never write case \'unstated\': default: here";\n  const read = readCost(listing);',
      ],
    ]);
    expect(fusedArms(inspect(inString)), 'a string quoting the fused form is not a fusion').toBe(false);
  });

  it('a prose mention does not HIDE a real re-fusion further down', () => {
    // Why `codeMatches` walks every match instead of judging the first one: the string mention
    // above appears BEFORE the real fusion in source order, so a first-match-wins scanner would
    // look at the string, decide "not code", and return green with the revert sitting under it.
    const both = mutate([
      [
        /const read = readCost\(listing\);/,
        'const why = "never write case \'unstated\': default: here";\n  const read = readCost(listing);',
      ],
      [/case 'unstated':\n\s*return 'Cost not listed';/, "case 'unstated':"],
    ]);
    expect(fusedArms(inspect(both))).toBe(true);
  });

  it("is specific to the `unstated` label, so the files' other fused defaults are not false alarms", () => {
    // Both real files fuse a default onto some OTHER label (`case 'unknown':`, `case 'none':`,
    // `case 'candidate':`). Those are ordinary and must stay silent. The fixture is a nested
    // switch inside the body because that is the real shape: pre-U4 lib/email/format.ts carried
    // `unstatedCostLabel`'s `case 'unknown': default:` switch INSIDE formatCost.
    //
    // The first version of this fixture fused `default:` onto `case 'free':` immediately above the
    // unstated arm, which — once FUSED_ARMS gained the reversed alternation — became a genuine
    // `default:` / `case 'unstated':` fusion and was correctly caught. The fixture was wrong, not
    // the scanner: kept as a note because "my control fixture accidentally built the defect" is
    // easy to mistake for a false positive.
    const otherLabel = mutate([
      [
        /void unhandledArm;\n      return 'Cost not listed';/,
        "void unhandledArm;\n      switch (listing.costStatus) {\n        case 'unknown':\n        default:\n          return 'Cost not listed';\n      }",
      ],
    ]);
    expect(fusedArms(inspect(otherLabel))).toBe(false);
    expect(hasUnstatedArm(inspect(otherLabel)), 'and the unstated arm is still seen').toBe(true);
  });

  it('a body it cannot locate is a FAILURE, not a silent pass', () => {
    expect(formatCostBody('export function somethingElse(): string { return "x"; }')).toBeNull();
    expect(formatCostBody('export function formatCost(l: L): string { return "x";')).toBeNull();
  });

  // ── the three bypasses independent QA measured against the shipped file (findings 1–3) ──

  /** Plant `text` on its own line immediately above the guard, at the guard's indentation. */
  function plantAboveGuard(src: string, text: string): string {
    return src.replace(/^([ \t]*)(const\s+[A-Za-z_$][\w$]*\s*:\s*never\s*=)/m, `$1${text}\n$1$2`);
  }

  it('catches a TS suppression directive planted above the guard in the REAL file', () => {
    for (const file of GUARDED_SURFACES) {
      const raw = readSurface(file);
      expect(suppressionDirectives(bodyOf(file)), `${file}: the PRISTINE file must carry none`).toEqual([]);
      for (const directive of ['// @ts-ignore', '// @ts-expect-error']) {
        const mutated = plantAboveGuard(raw, directive);
        expect(
          mutated,
          `${file}: planting ${directive} changed nothing, so this tripwire proves nothing — there is no ` +
            'guard line to plant it above, which means the guard is ALREADY gone (see (A) above)'
        ).not.toBe(raw);
        const body = formatCostBody(mutated);
        expect(body, `${file}: the mutated file must still HAVE a formatCost body`).not.toBeNull();
        expect(body ? suppressionDirectives(body) : [], `${file}: ${directive} went UNDETECTED`).toEqual([
          directive.replace('// ', ''),
        ]);
        // …and the guard is still textually present, which is exactly why this check had to exist:
        // every other assertion in this file stays green while the guarantee is gone.
        expect(body ? hasNeverGuard(body) : false, `${file}: the guard is still there, just disarmed`).toBe(true);
      }
    }
  });

  it('is not tripped by a STRING that merely names a directive', () => {
    const inString = mutate([
      [/const read = readCost\(listing\);/, "const doc = 'never write @ts-ignore in here';\n  const read = readCost(listing);"],
    ]);
    expect(suppressionDirectives(inspect(inString))).toEqual([]);
    const inComment = mutate([[/const unhandledArm: never = read;/, '// @ts-expect-error\n      const unhandledArm: never = read;']]);
    expect(suppressionDirectives(inspect(inComment))).toEqual(['@ts-expect-error']);
  });

  it('catches a SHADOWED subject planted above the guard in the REAL file', () => {
    for (const file of GUARDED_SURFACES) {
      const raw = readSurface(file);
      const subject = bodyOf(file).subject;
      const pristine = subjectBindings(bodyOf(file));
      expect(pristine.length, `${file}: the PRISTINE file must bind the subject exactly once`).toBe(1);
      expect(pristine[0], `${file}: and bind it from readCost()`).toMatch(/^readCost\s*\(/);
      const mutated = plantAboveGuard(raw, `const ${subject} = undefined as never;`);
      expect(
        mutated,
        `${file}: planting the shadow changed nothing, so this tripwire proves nothing — there is no guard ` +
          'line to plant it above, which means the guard is ALREADY gone (see (A) above)'
      ).not.toBe(raw);
      const body = formatCostBody(mutated);
      expect(body, `${file}: the mutated file must still HAVE a formatCost body`).not.toBeNull();
      expect(body ? subjectBindings(body).length : 0, `${file}: the shadow went UNDETECTED`).toBe(2);
      // The honest half: the SHAPE check cannot see this, which is the whole reason for the
      // binding count. Asserted rather than assumed, so the division of labour stays visible.
      expect(body ? hasNeverGuard(body) : false, `${file}: the shape check alone still says yes`).toBe(true);
    }
  });

  it("catches the REVERSED order — `default:` written ABOVE the unstated arm", () => {
    // Identical fall-through, compiles clean, a real shippable revert. The first version of
    // FUSED_ARMS only looked for arm-then-default and missed it (QA finding 3).
    const snippet = mutate([
      [/case 'unstated':\n\s*return 'Cost not listed';\n\s*default: \{/, "default:\n    case 'unstated': {"],
    ]);
    expect(fusedArms(inspect(snippet)), 'the reversed spelling in a snippet').toBe(true);
    for (const file of GUARDED_SURFACES) {
      const reversed = refuseArms(readSurface(file)).replace(/(case 'unstated':)(\n[ \t]*)(default\s*:)/, '$3$2$1');
      expect(reversed, `${file}: the reversal did not produce default-above-arm`).toMatch(
        /default:\n[ \t]*case 'unstated':/
      );
      const body = formatCostBody(reversed);
      expect(body, `${file}: the mutated file must still HAVE a formatCost body`).not.toBeNull();
      expect(body ? fusedArms(body) : false, `${file}: the reversed re-fusion went UNDETECTED`).toBe(true);
    }
  });
});
