// tests/search/empty-explain-placement.test.ts — /search's explanatory notices must stay
// INDEPENDENT top-level conditionals.
//
// TWO NOTICES ARE PINNED HERE, for the same reason and with the same machinery: the empty-state
// explanation (`kf-browse__empty-explain`) and the day-remainder notice (`kf-dayremainder`).
// Both exist to explain a page a parent would otherwise misread, both are computed correctly by
// code the rest of the suite covers thoroughly, and both are one careless re-nest away from
// never rendering in the case they were written for — with every other test still green.
//
// WHY THIS EXISTS, AND WHY IT IS A STATIC-ANALYSIS TEST.
//
// The F2(a) fix moved the `emptyExplain` block OUT of the `total === 0` arm. That was the whole
// defect: `total` counts the expected/seasonal section as well as the confirmed one, so a query
// whose CONFIRMED results a filter had emptied went entirely unexplained the moment the expected
// section had anything in it. /search?free=1&region=nvan returned a full explanation in the API
// payload and rendered a page of expected cards with no reason given.
//
// That fix is PURE JSX PLACEMENT, and placement is exactly what the rest of the suite cannot see.
// Re-nest that block inside `total === 0` tomorrow and all 2540 other tests stay green: the engine
// still computes the explanation, `broaden.ts` still ranks it correctly, every unit assertion on
// the payload still passes — and the page silently stops rendering it in the case it exists for.
// The only evidence that ever caught this was a hand-run A/B against a live render, which is not
// wired into anything.
//
// app/search/page.tsx cannot be unit-rendered (async server component, Supabase/cookies at module
// scope), so a render test is not available in this lane. Static analysis is, and the property is
// structural rather than behavioural, so it is the right tool rather than a consolation prize.
// Same approach as tests/scheduler/worker-image-closure.test.ts.
//
// AST, NOT TEXT MATCHING. A source-ORDER assertion ("the explain block appears before the
// `total === 0` fork") would catch a re-nest, but it is blind to the second, more tempting
// regression: leaving the block where it is and gating it on the broadening notice —
// `{broadening && emptyExplain && ...}`. Source order is unchanged, the pin stays green, and the
// Free decline goes quiet. That case matters most, because the notice and the explanation are
// ANTI-CORRELATED there: on a Free decline the ladder deliberately changes nothing it can report,
// so `describeBroadening` returns null by design while the explanation is the only honest thing on
// the page. Asserting on the syntax tree lets this check the actual property — what the block is
// nested inside, and what it is guarded by — instead of a proxy for it.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const PAGE = fileURLToPath(new URL('../../app/search/page.tsx', import.meta.url));

/** The explanation block's own marker class — the thing whose placement is load-bearing. */
const EXPLAIN_CLASS = 'kf-browse__empty-explain';
/** The day-remainder notice's marker class ("today has run out" vs "nothing is on"). */
const DAY_REMAINDER_CLASS = 'kf-dayremainder';

const source = readFileSync(PAGE, 'utf8');
const sourceFile = ts.createSourceFile(PAGE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** Every node in the tree, depth-first. */
function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** True when `node` is `ancestor` or lives somewhere beneath it. */
function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
    if (cur === ancestor) return true;
  }
  return false;
}

/** The JSX element carrying `className="<cls>"`. */
function findElementByClass(cls: string): ts.Node | null {
  let found: ts.Node | null = null;
  walk(sourceFile, (node) => {
    if (found) return;
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    for (const attr of node.attributes.properties) {
      if (!ts.isJsxAttribute(attr) || attr.name.getText() !== 'className') continue;
      const init = attr.initializer;
      if (init && ts.isStringLiteral(init) && init.text === cls) found = node;
    }
  });
  return found;
}

/**
 * Everything the element is CONDITIONALLY nested inside, walking to the file root.
 *
 * Two shapes count, and only when the element sits in a branch the condition actually gates:
 *   • `cond ? <A/> : <B/>`   — a ternary, element in whenTrue or whenFalse
 *   • `guard && <A/>`        — an && guard, element on the RIGHT (on the left it is not gated)
 */
function enclosingConditions(element: ts.Node): string[] {
  const conditions: string[] = [];
  for (let cur: ts.Node | undefined = element; cur; cur = cur.parent) {
    const parent = cur.parent;
    if (!parent) continue;
    if (ts.isConditionalExpression(parent) && (isWithin(cur, parent.whenTrue) || isWithin(cur, parent.whenFalse))) {
      conditions.push(parent.condition.getText(sourceFile));
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      isWithin(cur, parent.right)
    ) {
      conditions.push(parent.left.getText(sourceFile));
    }
  }
  return conditions;
}

/** Does any enclosing condition reference this identifier? Word-bounded (`total` != `totalResults`). */
const gatedOn = (conditions: string[], identifier: string): boolean =>
  conditions.some((c) => new RegExp(`\\b${identifier}\\b`).test(c));

describe('/search: the empty-state explanation is an independent top-level conditional', () => {
  const explain = findElementByClass(EXPLAIN_CLASS);

  it('the explanation block still exists in app/search/page.tsx', () => {
    // Guards the rest of this file against silently passing on a renamed/removed class: every
    // assertion below is vacuously true if the element cannot be found.
    expect(
      explain,
      `No JSX element with className="${EXPLAIN_CLASS}" found in app/search/page.tsx. If the class ` +
        `was renamed, update EXPLAIN_CLASS here — do not delete this file; the placement it pins is ` +
        `the F2(a) fix.`,
    ).not.toBeNull();
  });

  it('is NOT nested inside the `total === 0` branch — the original defect', () => {
    const conditions = enclosingConditions(explain!);
    expect(
      gatedOn(conditions, 'total'),
      `The explanation is nested inside a condition on \`total\` (found: ${JSON.stringify(conditions)}).\n\n` +
        `This is the F2(a) defect exactly. \`total\` is confirmed + expected, so gating the ` +
        `explanation on it means a query whose CONFIRMED results were emptied by a filter renders ` +
        `no reason at all as soon as the expected section has anything in it — the API returns a ` +
        `full explanation and the page shows a screen of cards with nothing said.\n` +
        `The engine already gates this correctly: \`emptyState\` is non-null only when the primary ` +
        `run came back empty or thin. Render it whenever it exists.`,
    ).toBe(false);
  });

  it('is NOT coupled to the broadening notice — that would mute the Free decline', () => {
    const conditions = enclosingConditions(explain!);
    expect(
      gatedOn(conditions, 'broadening'),
      `The explanation is gated on \`broadening\` (found: ${JSON.stringify(conditions)}).\n\n` +
        `These are two different mechanisms with two different triggers, and in the case that ` +
        `matters most they are ANTI-CORRELATED. The notice reports what the ladder CHANGED. On a ` +
        `Free decline the ladder deliberately changes nothing it can report — it reaches ` +
        `\`expected_section\`, which describeBroadening treats as silent by design — so the notice ` +
        `is correctly null while the explanation is the only honest thing on the page.\n` +
        `Gate one on the other and /search goes quiet in exactly the case the Free filter exists for.`,
    ).toBe(false);
  });

  it('is guarded by `emptyExplain` itself, so it cannot render unconditionally either', () => {
    // The opposite failure: dropping the guard entirely would satisfy both assertions above while
    // rendering an empty <p> on every search.
    const conditions = enclosingConditions(explain!);
    expect(
      gatedOn(conditions, 'emptyExplain'),
      `The explanation is not guarded by \`emptyExplain\` (found: ${JSON.stringify(conditions)}). ` +
        `It must render when — and only when — the engine produced a message.`,
    ).toBe(true);
  });

  it('appears BEFORE the results fork, so it explains the results rather than trailing them', () => {
    // The source-order half of the property. Cheap, and it keeps the explanation adjacent to the
    // broadening notice (both speak about the search) rather than drifting below the card list.
    //
    // Located through the AST, NOT with source.indexOf('total === 0') — the first textual match
    // for that is inside the comment ABOVE the explanation block, which documents the very defect
    // being pinned. A text scan therefore compares the element against a comment about itself and
    // fails on correct code. The tree distinguishes a real ternary condition from prose about one.
    let resultsFork: number | null = null;
    walk(sourceFile, (node) => {
      if (resultsFork != null || !ts.isConditionalExpression(node)) return;
      if (/\btotal\s*===\s*0\b/.test(node.condition.getText(sourceFile))) resultsFork = node.getStart(sourceFile);
    });
    expect(resultsFork, 'expected a `total === 0` results fork in app/search/page.tsx').not.toBeNull();
    expect(
      explain!.getStart(sourceFile),
      'The explanation should precede the results fork, next to the broadening notice.',
    ).toBeLessThan(resultsFork!);
  });
});

// ── The day-remainder notice ("today has run out" vs "nothing is on today") ───────────────────
//
// SAME PROPERTY, SHARPER STAKES. The reported defect was a page with EIGHT results, not zero:
// three testers searched Today at 22:35, got eight long-running "any day" items and no
// explanation, and concluded the product was broken. Nesting this notice inside the `total === 0`
// arm would restore that exact page — the notice would render only for a search that returned
// nothing, which is the one case a parent can already interpret, and stay silent for the thin
// list that actually misleads. It is the F2(a) defect again with a worse blast radius, and it is
// invisible to every behavioural test because the derivation would still be correct.
describe('/search: the day-remainder notice is an independent top-level conditional', () => {
  const notice = findElementByClass(DAY_REMAINDER_CLASS);

  it('the day-remainder block still exists in app/search/page.tsx', () => {
    expect(
      notice,
      `No JSX element with className="${DAY_REMAINDER_CLASS}" found in app/search/page.tsx. If the ` +
        `class was renamed, update DAY_REMAINDER_CLASS here — do not delete this file; the ` +
        `placement it pins is what makes a THIN "Today" explain itself.`,
    ).not.toBeNull();
  });

  it('is NOT nested inside the `total === 0` branch — a thin page is the case it exists for', () => {
    const conditions = enclosingConditions(notice!);
    expect(
      gatedOn(conditions, 'total'),
      `The day-remainder notice is nested inside a condition on \`total\` (found: ` +
        `${JSON.stringify(conditions)}).\n\n` +
        `The reported defect was a page with EIGHT results and no explanation, at 22:35 local. ` +
        `Gating this on \`total\` means it renders only when the page is completely empty and ` +
        `stays silent for the thin list that actually misled three testers.`,
    ).toBe(false);
  });

  it('is NOT coupled to the broadening notice — the two cover opposite sides of one threshold', () => {
    const conditions = enclosingConditions(notice!);
    expect(
      gatedOn(conditions, 'broadening'),
      `The day-remainder notice is gated on \`broadening\` (found: ${JSON.stringify(conditions)}).\n\n` +
        `They are anti-correlated by construction. The ladder runs only BELOW the caller's ` +
        `minResults; the reported eight-result page was above it, so \`broadening.applied\` was ` +
        `empty and the banner correctly said nothing. That is precisely when this notice is the ` +
        `only thing on the page that can explain the day.`,
    ).toBe(false);
  });

  it('is guarded by `dayRemainder` itself, so it cannot render unconditionally', () => {
    expect(
      gatedOn(enclosingConditions(notice!), 'dayRemainder'),
      `The notice must render when — and only when — the derivation produced one. ` +
        `A well-filled morning Today has nothing to disclose and must stay clean.`,
    ).toBe(true);
  });

  it('appears BEFORE the results fork, so it frames the list rather than trailing it', () => {
    let resultsFork: number | null = null;
    walk(sourceFile, (node) => {
      if (resultsFork != null || !ts.isConditionalExpression(node)) return;
      if (/\btotal\s*===\s*0\b/.test(node.condition.getText(sourceFile))) resultsFork = node.getStart(sourceFile);
    });
    expect(resultsFork).not.toBeNull();
    expect(notice!.getStart(sourceFile)).toBeLessThan(resultsFork!);
  });
});
