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
// A SECOND, NARROWER GUARANTEE RIDES ALONG, added by the F5 addendum as section (D): the DIGEST's
// `group_range` arm keeps wording a parent cannot mistake for the `range` arm's single-session span,
// nor for the `'Cost varies'` that `unstatedCostLabel` returns for a `known` status. It is stated
// separately from the four above because it is a different guarantee about the same two files, and
// this header has already been bitten once for letting one claim absorb another.
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
// code. Two unwatched exits, both MEASURED rather than assumed: a file-level `// @ts-nocheck` (with
// a fifth arm, both TS2322 errors vanish), and anything that stops `tsc` running over these files
// at all. Re-homing the guard into a nested function whose PARAMETER is named `read` also defeats
// it — measured, both TS2322 errors gone with a fifth arm — and it passes every check here THAT IS
// ABOUT THE GUARD: (A) and (B) all stay green, which is the half that matters. The tree does still
// go red (measured on this commit: 4 failed | 17 passed), but ONLY through (C)'s self-checks, and
// only because they can no longer find a line-leading `const … : never = …;` to mutate — so their
// messages misdescribe what happened, and a maintainer would not learn from them that the guard had
// been re-homed. A known, accepted gap: the fix for that class is a CI-integrity check that `tsc`
// runs and neither file is exempt, not a sixth assertion in a formatter pin. Two things that sound
// like exits and are NOT, so nobody re-asserts them: with a
// fifth arm, `"strict": false` still errors on both surfaces, and adding both files to tsconfig's
// `exclude` still errors on both surfaces (the import graph pulls them in regardless).
//
// Where this file stops is deliberate: the target is the benign author making an unfamiliar
// compiler error go away, not a determined one. A scanner always loses that second argument, and
// chasing it would trade real coverage for theatre.
//
// WHY THIS FILE EXISTS. Nothing else in the repo notices if the guard goes. Measured, not
// argued (U4 QA verdict): delete both `never` assignments and `tsc --noEmit`, `eslint .` and the
// whole suite stay green; fully revert the split and the suite's output is BYTE-IDENTICAL to the
// unreverted commit — not one of 2491 passing tests notices the unit was undone. The suite is
// not asleep: tampering the `'Cost varies'` label produces 18 named failures in
// tests/cost-honesty-matrix.test.tsx (U4 QA verdict — and reproduced here: 18 of 110, against a
// 110-passed control). THE COUNT IS LABEL-SPECIFIC AND 18 IS NOT A GENERAL FIGURE: on my own
// probes `'Free'` gives 29 and `COST_UNKNOWN` gives 69. Said explicitly because a number you
// cannot reproduce invites the wrong correction — probe a different label, fail to get 18, and
// the tempting "fix" is to overwrite a real measurement or delete this sentence, which is the
// anti-vacuity argument for the whole file. It simply had nothing pointed at the guard itself.
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
// >>> THE AUTHORITY IS NOW TWO FUNCTIONS, AND THE WIDENING IS EARNED RATHER THAN ASSUMED. <<<
// (F5, 2026-08-12.) A collapsed search card stands for several occurrences that can disagree about
// price, so the card formatter binds its CostRead from `readGroupCost()` — the group authority in
// the same pinned module — while the digest still binds from `readCost()`. (A) therefore admits
// EITHER, at all three sites that name the authority, and the widening rests on exactly one fact:
//
//     readGroupCost's DECLARED RETURN TYPE IS `CostRead`.
//
// That is what keeps the guard biting: the subject is still the real union, so it still narrows to
// `never` only while every arm is covered. Nothing else in the repo pinned that fact, which would
// have left a later signature change (`: CostRead | string`, or an inferred return) free to hollow
// the guard out on BOTH surfaces silently — so (A) now pins the signature itself, in the same file
// as the widening it justifies. Widening a detector without pinning its new premise is how a
// detector quietly stops detecting, and this file has already argued that at length about itself.
//
// >>> ONE SHAPE THAT PASSES THIS FILE AND DEFEATS ITS INTENT — IDENTIFIED AND REJECTED, NOT USED. <<<
// `subjectBindings` counts DECLARATIONS, not assignments. So this passes every check here:
//
//     let read = readCost(activity);
//     if (group) read = readGroupCost(group);   // ← not a declaration; invisible to the count
//
// It was found while implementing F5 and deliberately NOT used, because it is a way past the guard
// rather than a way through it — and this file's target is the benign author, who is exactly the
// person who would copy it later as "the shape that keeps the compliance test green". Written down
// here so the rejection outlives the conversation it was made in. If you need a second authority,
// widen the patterns and pin the new function's return type, as F5 did; do not rebind the subject.
//
// >>> THE OTHER HALF OF THE SAME F5 FENCE: THE DIGEST'S GROUP WORDING WAS PINNED BY A COMMENT. <<<
// (F5 addendum, 2026-08-12.) Jon's fence — a collapsed card's span must not be readable as ONE
// session's bounds — lands on two surfaces, and only one of them was ASSERTED. The card's leading
// word is pinned behaviourally in tests/search/group-cost.test.ts (`'Varies: $103–$240'`, four
// times). The digest's was pinned by prose: `git grep "Varies by session"` returned exactly one hit
// in the whole repo — lib/email/format.ts:84, the source line itself — while the same grep for the
// card's `Varies:` finds its source AND its tests, so the instrument does find assertions when they
// exist. A fence asserted on one surface and merely narrated on the other is the asymmetry (D)
// closes, and the digest is the half that cannot be taken back once it has been read.
//
// No BEHAVIOURAL test can reach that arm. lib/email/format.ts binds from `readCost`, which cannot
// return `group_range` — only `readGroupCost` can, and nothing in the digest path collapses. The arm
// is type-required and runtime-dead today, and it ships real words anyway, on purpose (its own
// comment argues why). A source pin is therefore the available technique, and it is the same
// technique and the same justification as `GROUP_AUTHORITY_SIGNATURE` above: a fact the guarantee
// rests on, which nothing else in the repo would notice losing.
//
// (D) PINS THE PROPERTY, NOT THE STRING — it never mentions "Varies by session" anywhere. It reads
// the `group_range` and `range` arms' literals out of the digest's own source, collapses `${…}` to a
// placeholder so the comparison is about WORDS rather than about the expressions producing the
// digits, and requires the group wording to be: (1) not identical to the range wording; (2) not a
// prefix of it, in EITHER direction — `$5–$20 per session` opens with exactly what one session's
// bounds look like; (3) carrying at least one letter outside the numbers, so a bare span with
// cosmetic spacing does not slip past (1) and (2); and (4) not the same words as
// `unstatedCostLabel`'s `known` label, which is the DIFFERENT claim "we hold no price at all".
// Rewording the digest honestly stays green. What (D) cannot do is prove the RENDERED output —
// there is no runtime path to render, which is precisely why the pin is textual rather than
// behavioural, and why its scanner is watched failing on the real file in its own tripwire.
//
// SHAPE — the same shape as tests/compliance/venue-geo-authority-declared.test.ts, deliberately:
//
//   (A) THE GUARD IS PRESENT AND IN FORCE, per surface, located inside `formatCost`'s own body
//       rather than anywhere in the file, and matched by SHAPE (a `never`-typed binding fed from
//       the value the switch discriminates on) rather than by the variable's name — so renaming
//       `unhandledArm` or `read` is not a false alarm, while a guard fed from something other
//       than the switched value does not count. Two things make "present" mean "in force":
//       the subject must be bound exactly ONCE and from one of the two cost authorities —
//       `readCost()` or `readGroupCost()`, both declared to return `CostRead` (a rebinding shadows
//       the CostRead, and a guard fed from `undefined as never` type-checks while proving nothing)
//       — and no TS suppression directive may sit in the body (it silences the guard in place).
//       The group authority's RETURN TYPE is pinned here too, since the widening rests on it.
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
//
//   (D) THE DIGEST'S `group_range` WORDING IS DISTINGUISHABLE — from the `range` arm's span and
//       from `unstatedCostLabel`'s `known` label — read as a PROPERTY of the two arms' literals
//       rather than as a hard-coded string. It sits after (C) rather than inside it because its
//       tripwire rides in its own describe, exactly as (A)'s signature pin carries its own; (C)
//       remains the self-check for the (A)/(B) scanners it was written for.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

/** The two surfaces that turn a `CostRead` into words a parent reads. */
const GUARDED_SURFACES = ['app/preview/_data/format.ts', 'lib/email/format.ts'];

/** The module that owns both cost authorities and the `CostRead` union itself. */
const COST_AUTHORITY_MODULE = 'lib/search/filters/cost.ts';

/**
 * The digest — the irreversible channel, and the surface whose `group_range` WORDING (D) pins. The
 * card's half of the same fence is asserted behaviourally in tests/search/group-cost.test.ts and is
 * deliberately not re-pinned here: a second textual copy of a check that already runs the real code
 * is the duplicated-cost-rule defect this whole area exists to end.
 */
const DIGEST_SURFACE = 'lib/email/format.ts';

/**
 * The cost authorities a `formatCost` may bind its subject from: `readCost` for one listing,
 * `readGroupCost` for a collapsed card's group. Both are declared to return `CostRead` — which is
 * the whole reason either is admissible, and which `(A)`'s last test pins rather than assumes.
 *
 * Note `readGroupCost(` does NOT contain the substring `readCost(` — after `read` comes `G` — so
 * the unanchored site below has to be widened too, not just the two anchored ones.
 */
const COST_AUTHORITY = /read(?:Group)?Cost\s*\(/;
const COST_AUTHORITY_BINDING = /^read(?:Group)?Cost\s*\(/;

/**
 * `readGroupCost` declared to RETURN a `CostRead`, matched up to the opening brace so that widening
 * the type (`: CostRead | string`) stops matching instead of still passing on the `CostRead` prefix.
 */
const GROUP_AUTHORITY_SIGNATURE = /export\s+function\s+readGroupCost\s*\([^)]*\)\s*:\s*CostRead\s*\{/;

/**
 * (D)'s two patterns, beside the signature pin because they are the same kind of thing: a fact about
 * source text that the guarantee rests on and nothing else in the repo watches.
 *
 * `INTERPOLATION` collapses `${…}` so two arms are compared on the WORDS a parent reads rather than
 * on the expressions that produce the digits — `${money(read.min)}` and `$${read.min}` render the
 * same thing and must not be treated as a difference. `WHOLE_LITERAL` is the admissibility test: an
 * arm that no longer returns one string or template literal is a wording (D) cannot read, and that
 * is reported as a PROBLEM rather than passed over, because a pin that has lost sight of its subject
 * must never be silently green — the same anti-vacuity rule `formatCostBody` follows by returning
 * null instead of an empty slice.
 */
const INTERPOLATION = /\$\{[^{}]*\}/g;
const WHOLE_LITERAL = /^(['"`])[\s\S]*\1$/;
/** What an interpolation collapses TO. A control character so no real wording can contain it. */
const NUMBER_SLOT = String.fromCharCode(1);

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
  /** The body's start offset in the FILE, so an offset found in `keys` can be spliced into the
   *  source it came from. Added for (D)'s tripwire; nothing above it reads this. */
  readonly at: number;
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
    at: start,
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
 * THE DIRECTIVE MUST BE THE COMMENT'S LEADING TOKEN, which is the only position TypeScript honours,
 * and getting that wrong in the other direction is not free: the first version of this check matched
 * the directive ANYWHERE inside a comment, so the single most natural next edit to the guard's own
 * (very verbose) comments — warning the next author off `@ts-ignore` — would have failed this file
 * with the message "the guard is switched OFF" while the guarantee was completely intact. That is
 * worse than a miss: it is a tripwire that lies, and this file's own docstring already argued a
 * tripwire firing on innocent prose is one people start disabling.
 *
 * Measured, planting each form above the guard with a fifth `CostRead` arm added, and counting
 * TS2322 across the two label surfaces (2 = both still error = guarantee intact):
 *
 *   line comment, directive first          -> 0   HONOURED
 *   line comment, `@ts-expect-error` first -> 0   HONOURED
 *   BLOCK comment, directive first         -> 0   HONOURED  (a line-comment-only pattern loses this)
 *   JSDOC block, directive first           -> 0   HONOURED
 *   line comment, prose then directive     -> 2   not a directive; must stay green
 *   block comment, prose then directive    -> 2   not a directive
 *   jsdoc, directive on a continuation line -> 2  not a directive
 *
 * So the rule is: a comment opener, then horizontal whitespace only, then the directive. No newline
 * between them — the jsdoc continuation form is measured NOT to suppress, so matching it would
 * re-introduce exactly the false failure this narrowing exists to remove. Nothing TypeScript
 * actually honours is lost by narrowing to this; the three forms that suppress are all still caught.
 *
 * The opener's own offset is then required to be blanked in `keys`, which is what proves it is a
 * real comment rather than the same text inside a string literal.
 *
 * `@ts-nocheck` is deliberately NOT included: it only takes effect at the top of a FILE, so matching
 * it inside a body would be theatre. It is named in this file's header as an unwatched exit.
 */
const SUPPRESSION_DIRECTIVE = /(?:\/\/\/?|\/\*+)[ \t]*(@ts-(?:ignore|expect-error))/g;

function suppressionDirectives(body: FormatCostBody): string[] {
  const re = new RegExp(SUPPRESSION_DIRECTIVE.source, 'g');
  const found: string[] = [];
  for (let m = re.exec(body.raw); m; m = re.exec(body.raw)) {
    if (body.keys[m.index] === ' ') found.push(m[1]);
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

interface ArmReturn {
  /** The returned expression's source text. */
  readonly expr: string;
  /** Its span within the view it was found in — `[from, to)`, `to` being the `;`. */
  readonly from: number;
  readonly to: number;
}

/**
 * (D)'s reader. The expression a `case '<kind>':` arm returns, located in a COMMENT-MASKED view —
 * string content survives there, which is the half (D) needs, whereas the string-masked view blanks
 * exactly the words being compared. Comments between the label and the `return` are whitespace by
 * then, so the digest's very long `group_range` comment is simply skipped over.
 */
function armReturn(keys: string, kind: string): ArmReturn | null {
  const m = new RegExp(`case\\s*(['"\`])${kind}\\1\\s*:\\s*return\\s+([^;]+);`).exec(keys);
  if (!m) return null;
  const to = m.index + m[0].length - 1;
  return { expr: m[2].trim(), from: to - m[2].length, to };
}

/**
 * Rewrite one arm's returned expression, for (D)'s tripwire. Located in the COMMENT-MASKED view and
 * spliced into the raw source by OFFSET — masking preserves length, so the two copies stay
 * cross-referencable, the same property `codeMatches` relies on.
 *
 * MEASURED, NOT ASSUMED, AND THE REASON THIS IS NOT A `String.replace` ON RAW TEXT: the digest's
 * `group_range` comment contains the words "cannot return this arm", and the first version of this
 * tripwire — anchored on `case 'group_range': […] return …;` in raw source — matched THAT `return`
 * and swallowed the rest of the comment plus the real return statement. The mutation "applied", the
 * arm ceased to exist, and the tripwire reported the wrong failure. A raw-text anchor in a file this
 * heavily commented is not safe, which is the same lesson the header records about the scanner.
 */
function setArmWording(src: string, kind: string, expr: string): string | null {
  const body = formatCostBody(src);
  if (!body) return null;
  const arm = armReturn(body.keys, kind);
  if (!arm) return null;
  return src.slice(0, body.at + arm.from) + expr + src.slice(body.at + arm.to);
}

/**
 * An arm's WORDING: delimiters dropped, `${…}` collapsed to `NUMBER_SLOT`. Null when the arm does
 * not return a single literal — reported as a problem below rather than passed over.
 */
function wordingOf(expr: string | null): string | null {
  if (expr === null || !WHOLE_LITERAL.test(expr)) return null;
  return expr.slice(1, -1).replace(INTERPOLATION, NUMBER_SLOT);
}

/** A wording, printable — the collapsed bounds shown as what they are rather than as a control char. */
function show(wording: string): string {
  return wording.split(NUMBER_SLOT).join('${…}');
}

interface DigestWording {
  /** Source text of each arm's returned expression, kept so a failure can QUOTE what it read
   *  instead of only saying it could not read it. */
  readonly groupExpr: string | null;
  readonly rangeExpr: string | null;
  readonly knownExpr: string | null;
  /** The `group_range` arm's wording, bounds collapsed. */
  readonly group: string | null;
  /** The `range` arm's wording — ONE session whose own price spans that. */
  readonly range: string | null;
  /** `unstatedCostLabel`'s `known` label — the different claim "we hold no price at all". */
  readonly known: string | null;
}

/**
 * The three wordings (D) compares, read out of one surface's source. `known` is read from the whole
 * file rather than from `formatCost`'s body because `unstatedCostLabel` is a sibling function; it is
 * the only `case 'known':` in the digest, and the pin fails loudly below if it ever stops being read.
 */
function digestWording(src: string): DigestWording {
  const body = formatCostBody(src);
  const groupExpr = body ? armReturn(body.keys, 'group_range')?.expr ?? null : null;
  const rangeExpr = body ? armReturn(body.keys, 'range')?.expr ?? null : null;
  const knownExpr = armReturn(maskRegions(src, { strings: false }), 'known')?.expr ?? null;
  return {
    groupExpr,
    rangeExpr,
    knownExpr,
    group: wordingOf(groupExpr),
    range: wordingOf(rangeExpr),
    known: wordingOf(knownExpr),
  };
}

/**
 * JON'S FENCE AS FAILURE MODES (2026-08-12, hard): a collapsed span must not be readable as ONE
 * session's bounds, and must not be readable as "we hold no price". Empty list = still distinct.
 *
 * Deliberately NOT "the wording equals 'Varies by session: …'". A pin on the exact string would fail
 * an honest rewording and would teach the next author that the string is the requirement, when the
 * requirement is the DISTINCTION. Four ways to lose it, each named separately so a failure says
 * which one happened.
 */
function wordingProblems(w: DigestWording): string[] {
  const problems: string[] = [];
  const unreadable = (what: string, expr: string | null): string =>
    `${DIGEST_SURFACE} — the ${what} is no longer a readable string literal (\`${expr ?? 'arm not found'}\`), ` +
    'so this pin can no longer see the wording it is meant to compare. Restore a literal, or move ' +
    'this check to wherever the digest now decides its words — do not leave it green and blind.';
  if (w.group === null) problems.push(unreadable('`group_range` arm', w.groupExpr));
  if (w.range === null) problems.push(unreadable('`range` arm', w.rangeExpr));
  if (w.known === null) problems.push(unreadable("`unstatedCostLabel` `known` label", w.knownExpr));
  if (w.group === null || w.range === null || w.known === null) return problems;

  if (w.group === w.range) {
    problems.push(
      `${DIGEST_SURFACE} — the \`group_range\` arm now says EXACTLY what the \`range\` arm says ` +
        `(\`${show(w.group)}\`). Those are two different claims: the range arm means ONE session ` +
        'whose own price spans that; this arm means one session at the low bound and a DIFFERENT ' +
        "session at the high one. Jon's fence is that a parent must not be able to confuse them."
    );
  } else if (w.group.startsWith(w.range) || w.range.startsWith(w.group)) {
    problems.push(
      `${DIGEST_SURFACE} — the \`group_range\` wording (\`${show(w.group)}\`) and the \`range\` ` +
        `wording (\`${show(w.range)}\`) are a PREFIX collision: one BEGINS with the other, so the ` +
        'digest opens with exactly the characters that mean one session\'s bounds and only ' +
        'disambiguates later — in the channel that has already been read by the time anyone notices.'
    );
  }
  if (!/[A-Za-z]/.test(w.group.split(NUMBER_SLOT).join(''))) {
    problems.push(
      `${DIGEST_SURFACE} — the \`group_range\` wording (\`${show(w.group)}\`) carries no WORDS at ` +
        'all outside the two bounds; it is a bare span, which is what one session\'s price looks ' +
        'like. Cosmetic spacing is not a distinction — the leading word is (card formatter, line 104).'
    );
  }
  if (w.group === w.known) {
    problems.push(
      `${DIGEST_SURFACE} — the \`group_range\` arm now says the same words as \`unstatedCostLabel\`'s ` +
        `\`known\` label (\`${show(w.group)}\`). That label means we hold NO printable price; this ` +
        'arm means we hold TWO. Same string, two meanings, is the collapsed-claims defect this ' +
        'whole area exists to end — and the digest is the surface that cannot take it back.'
    );
  }
  return problems;
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
      expect(
        body?.keys,
        `${file}: formatCost no longer delegates to a cost authority (readCost / readGroupCost)`
      ).toMatch(COST_AUTHORITY);
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

  it('the guard is fed by the real CostRead — the subject is bound ONCE, from a cost authority', () => {
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
      } else if (!COST_AUTHORITY_BINDING.test(bindings[0])) {
        shadowed.push(
          `${file} — \`${body.subject}\` is no longer bound from a cost authority (readCost / ` +
            `readGroupCost); it is bound from \`${bindings[0]}\`, so the guard no longer says ` +
            'anything about the real CostRead union'
        );
      }
    }
    expect(shadowed, 'the value the exhaustiveness guard is fed is no longer the CostRead').toEqual([]);
  });

  it('the widening is EARNED: readGroupCost is declared to return a CostRead', () => {
    // THE PREMISE OF THE F5 WIDENING, PINNED RATHER THAN ASSUMED. The two tests above admit
    // `readGroupCost(` beside `readCost(` on one ground only: it returns the same `CostRead` union,
    // so the `never` assignment below it still narrows to `never` only while every arm is covered.
    // Change that signature and BOTH surfaces stop being guarded, with nothing anywhere saying so —
    // the same silent-hollowing shape the rest of this file exists to catch, one level up.
    expect(
      existsSync(resolve(ROOT, COST_AUTHORITY_MODULE)),
      `${COST_AUTHORITY_MODULE} is gone or has moved — repoint this test`
    ).toBe(true);
    const src = maskRegions(readSurface(COST_AUTHORITY_MODULE), { strings: true });
    expect(
      src,
      `${COST_AUTHORITY_MODULE}: readGroupCost is gone, or no longer DECLARES a CostRead return ` +
        'type. The card formatter binds the exhaustiveness guard from it, and this test admits it ' +
        'there only because of that declaration — restore it, or narrow the patterns back.'
    ).toMatch(GROUP_AUTHORITY_SIGNATURE);

    // Tripwire, same run: the scanner must say NO when the return type is widened away. Without
    // this, a pattern that had drifted into matching nothing would sit green forever.
    const widened = src.replace(
      /(export function readGroupCost\s*\([^)]*\)\s*:\s*)CostRead(\s*\{)/,
      '$1CostRead | string$2'
    );
    expect(widened, 'the signature mutation did not apply — this tripwire proves nothing').not.toBe(src);
    expect(
      GROUP_AUTHORITY_SIGNATURE.test(widened),
      'a WIDENED return type went undetected — the pattern is matching on the `CostRead` prefix ' +
        'rather than on the whole declared type'
    ).toBe(false);
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
      // All three forms are MEASURED to suppress: with a fifth CostRead arm planted, each one makes
      // both TS2322 errors disappear. The block form is here because a line-comment-only pattern
      // would silently stop catching it.
      for (const directive of ['// @ts-ignore', '// @ts-expect-error', '/* @ts-ignore */']) {
        const mutated = plantAboveGuard(raw, directive);
        expect(
          mutated,
          `${file}: planting ${directive} changed nothing, so this tripwire proves nothing — there is no ` +
            'guard line to plant it above, which means the guard is ALREADY gone (see (A) above)'
        ).not.toBe(raw);
        const body = formatCostBody(mutated);
        expect(body, `${file}: the mutated file must still HAVE a formatCost body`).not.toBeNull();
        expect(body ? suppressionDirectives(body) : [], `${file}: ${directive} went UNDETECTED`).toEqual([
          /@ts-[a-z-]+/.exec(directive)?.[0],
        ]);
        // …and the guard is still textually present, which is exactly why this check had to exist:
        // every other assertion in this file stays green while the guarantee is gone.
        expect(body ? hasNeverGuard(body) : false, `${file}: the guard is still there, just disarmed`).toBe(true);
      }
    }
  });

  it('is not tripped by a directive NAMED IN PROSE inside a comment', () => {
    // THE FALSE FAILURE THIS CHECK ONCE PRODUCED, pinned so it cannot come back. The first version
    // matched the directive anywhere inside a comment, so the most natural next edit to the guard's
    // own comments — warning the next author off `@ts-ignore` — failed this file claiming the guard
    // was switched OFF. Measured: with a fifth CostRead arm, that comment leaves BOTH TS2322 errors
    // firing. The guarantee is intact and the message said it was gone.
    //
    // Asserted in BOTH directions on the REAL files, because narrowing a detector is exactly where a
    // quiet weakening hides: prose stays green, a real leading-token directive is still caught.
    const prose = '// Do NOT reach for @ts-ignore here — that error is the guard working.';
    for (const file of GUARDED_SURFACES) {
      const raw = readSurface(file);
      const documented = plantAboveGuard(raw, prose);
      expect(documented, `${file}: the prose mutation did not apply`).not.toBe(raw);
      const documentedBody = formatCostBody(documented);
      expect(documentedBody, `${file}: the mutated file must still HAVE a formatCost body`).not.toBeNull();
      expect(
        documentedBody ? suppressionDirectives(documentedBody) : ['<no body>'],
        `${file}: a comment that merely NAMES the directive is not a suppression — failing here tells ` +
          'an author the guard is disarmed when it is fully intact'
      ).toEqual([]);
      // The other direction, same file, same run: a real one is still caught.
      const suppressed = formatCostBody(plantAboveGuard(raw, '// @ts-ignore'));
      expect(
        suppressed ? suppressionDirectives(suppressed) : [],
        `${file}: narrowing to leading-token position must not have cost any real detection`
      ).toEqual(['@ts-ignore']);
    }
    // And the same pair on a block comment, whose leading-token form is also measured to suppress.
    const blockProse = mutate([[/const unhandledArm: never = read;/, '/* prose first, then @ts-ignore */\n      const unhandledArm: never = read;']]);
    expect(suppressionDirectives(inspect(blockProse))).toEqual([]);
    const blockReal = mutate([[/const unhandledArm: never = read;/, '/* @ts-ignore */\n      const unhandledArm: never = read;']]);
    expect(suppressionDirectives(inspect(blockReal))).toEqual(['@ts-ignore']);
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
      expect(pristine[0], `${file}: and bind it from a cost authority`).toMatch(COST_AUTHORITY_BINDING);
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

describe("(D) the digest's group_range wording cannot be misread as one session's price", () => {
  it('the three wordings this section compares are actually readable from the digest', () => {
    // ANTI-VACUITY, and it is the whole risk here: every assertion below is a DIFFERENCE claim, and
    // two nulls differ from nothing. If the arms stopped being literals, `wordingProblems` would say
    // so — this test says it first, and in terms of what was read rather than what was not.
    const w = digestWording(readSurface(DIGEST_SURFACE));
    expect(w.group, `${DIGEST_SURFACE}: the \`group_range\` arm's wording could not be read`).not.toBeNull();
    expect(w.range, `${DIGEST_SURFACE}: the \`range\` arm's wording could not be read`).not.toBeNull();
    expect(w.known, `${DIGEST_SURFACE}: \`unstatedCostLabel\`'s \`known\` label could not be read`).not.toBeNull();
    // …and both spans really did interpolate their bounds. Without this, a wording that had lost its
    // `${…}` would compare as plain prose and the prefix test in particular would mean nothing.
    expect(w.group ?? '', 'the group wording must still interpolate its two bounds').toContain(NUMBER_SLOT);
    expect(w.range ?? '', 'the range wording must still interpolate its two bounds').toContain(NUMBER_SLOT);
  });

  it("the group_range wording is distinct from the range arm's and from the `known` label", () => {
    // THE HALF OF JON'S FENCE NOTHING WAS WATCHING. The card's half is asserted behaviourally in
    // tests/search/group-cost.test.ts; this one had a comment and no test, and `git grep` for its
    // string found only the source line. The property is pinned, not the string — see the header.
    expect(
      wordingProblems(digestWording(readSurface(DIGEST_SURFACE))),
      "the digest's collapsed-span wording has collided with one of the two claims it must stay " +
        'distinct from. Reword it so it still differs — do NOT relax this check; the digest is the ' +
        'channel a parent has already acted on by the time a wrong label is noticed.'
    ).toEqual([]);
  });

  it('tripwire: each way of losing the distinction is caught in the REAL digest source', () => {
    // A pin nobody has watched fail is decoration. Anchored on the ARM LABEL rather than on today's
    // words, so an honest rewording does not quietly stop the mutations from applying.
    const raw = readSurface(DIGEST_SURFACE);
    const collisions: ReadonlyArray<readonly [string, string, RegExp]> = [
      ['collapsed to the range arm\'s bare span', '`${money(read.min)}–${money(read.max)}`', /says EXACTLY what the `range` arm says/],
      ['reworded to the `known` label', "'Cost varies'", /the same words as `unstatedCostLabel`/],
      ['opened with the range arm\'s span', '`${money(read.min)}–${money(read.max)} per session`', /PREFIX collision/],
    ];

    for (const [name, expr, expected] of collisions) {
      const mutated = setArmWording(raw, 'group_range', expr);
      expect(
        mutated,
        `${name}: the arm could not be located, so this tripwire proves nothing`
      ).not.toBeNull();
      expect(
        mutated,
        `${name}: the mutation changed nothing, so this tripwire proves nothing — either the arm has ` +
          'moved or its shape has drifted from what this rewrite expects'
      ).not.toBe(raw);
      // The mutation LANDED WHERE IT WAS AIMED — the arm still exists and now returns exactly the
      // colliding wording. Without this the next assertion could pass on a mangled file for reasons
      // that have nothing to do with the collision being detected. (An earlier draft did exactly
      // that: it ate the arm and reported "not a readable literal" as if it were a catch.)
      expect(
        digestWording(mutated ?? '').groupExpr,
        `${name}: the mutation did not land on the group_range arm`
      ).toBe(expr);
      expect(
        wordingProblems(digestWording(mutated ?? '')).join('\n'),
        `${name} went UNDETECTED — the pin does not reach this way of losing the distinction`
      ).toMatch(expected);
    }

    // The control, in the same run: the pristine digest is clean under the very same scanner.
    expect(wordingProblems(digestWording(raw)), 'the scanner fires on the PRISTINE digest').toEqual([]);
  });
});
