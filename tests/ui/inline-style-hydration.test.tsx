// tests/ui/inline-style-hydration.test.tsx — the guard for a hydration break that shipped to
// production on /coverage-status and was live on five admin pages at the same time.
//
// WHAT HAPPENED. app/coverage-status/page.tsx rendered its stylesheet as `<style>{COVERAGE_CSS}
// </style>`. A JSX text child is ESCAPED by React, so one apostrophe in a CSS comment ("the
// browser's default serif") was served as `&#x27;`. But `<style>` is a RAW TEXT element in the
// HTML spec: the parser does NOT decode entities inside it. So the browser's text node read
// `browser&#x27;s` while React's client render produced `browser's`, they could never agree, and
// EVERY load of that page failed hydration — 5x React #425 ("Text content does not match
// server-rendered HTML"), then #418, then #423, which drops the entire root to a client re-render.
// Nothing looked broken, which is exactly why it survived: the only symptom was console noise and
// a silently discarded server render.
//
// WHY A SOURCE SCAN RATHER THAN A RENDER TEST. The defect is invisible unless the CSS happens to
// contain one of four characters, so a test that renders today's CSS would pass and then go quiet
// the day somebody types an apostrophe. The rule has to be about the CONSTRUCT, not the content.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

function tsxFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) out.push(p);
    }
  };
  walk(root);
  return out;
}

describe('🔴 no component may render <style> with an escaped text child', () => {
  // The mechanism itself, asserted rather than described — if React ever stops escaping this,
  // the rule below can be retired, and this test is where that gets noticed.
  it('React escapes a text child of <style>, and the HTML parser will not undo it', () => {
    const html = renderToStaticMarkup(<style>{".a:after{content:'x'}"}</style>);
    expect(html, 'the apostrophe React emits is not what the browser will parse back').toContain(
      '&#x27;'
    );

    // dangerouslySetInnerHTML is the non-escaping form, and the one the codebase standardises on
    // for a static CSS string.
    const safe = renderToStaticMarkup(
      <style dangerouslySetInnerHTML={{ __html: ".a:after{content:'x'}" }} />
    );
    expect(safe).toContain("content:'x'");
    expect(safe).not.toContain('&#x27;');
  });

  it('no app/ or components/ file uses the escaping form', () => {
    const offenders = [...tsxFiles('app'), ...tsxFiles('components')].filter((f) =>
      // `<style>` followed by a JSX expression: the escaping form. A stylesheet import or
      // dangerouslySetInnerHTML both pass.
      /<style[^>]*>\s*\{/.test(readFileSync(f, 'utf8'))
    );
    expect(
      offenders,
      'render CSS via an imported .css file, or <style dangerouslySetInnerHTML={{ __html: CSS }} />'
    ).toEqual([]);
  });
});

describe('🔴 /coverage-status — the page the defect shipped on', () => {
  const src = readFileSync('app/coverage-status/page.tsx', 'utf8');

  it('carries no inline <style> at all, and imports its stylesheet instead', () => {
    expect(src).not.toMatch(/<style/);
    expect(src).toContain("import './coverage-status.css'");
  });

  it('the stylesheet still carries the rules the page depends on', () => {
    const css = readFileSync('app/coverage-status/coverage-status.css', 'utf8');
    // The scoping root and the table/tile classes the page renders — moving the CSS must not have
    // quietly dropped it.
    for (const cls of ['.kf-cov', '.kf-cov__tile-value', '.kf-cov__table', '.kf-cov__foot']) {
      expect(css, `${cls} missing from the extracted stylesheet`).toContain(cls);
    }
  });
});
