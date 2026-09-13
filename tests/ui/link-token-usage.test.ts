import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE LINT RULE design-tokens.css SAID DID NOT EXIST (2026-09-13).
 * ---------------------------------------------------------------------------
 * `--kf-anchor` is a FILL — the dark band the hero sits on, paired with
 * `--kf-anchor-text`. `--kf-link` is the TEXT/BORDER role for links.
 *
 * The two were one token, and the conflation shipped five times: DataHealth and
 * ProductHealth `.backLink`, `child-profile` `.kf-cprof__btn`, `start.css`
 * `.kf-start__submit`, and finally every link on the preferences / signup /
 * interstitial surfaces — which is the one a parent reported, from a phone, in
 * dark mode, at a MEASURED 1.53:1. Each of the first four was fixed one file at a
 * time; none of them stopped the fifth, because nothing checked.
 *
 * Why it kept happening: in LIGHT mode both roles are legitimately Evergreen, so a
 * misuse renders correctly and reviews clean. The failure only exists in dark mode,
 * where a fill must go DARKER than the canvas and a link must go LIGHTER.
 *
 * This guard is a grep with a reason attached, and it closes the class rather than
 * the instance: no stylesheet may paint TEXT (or a border/outline, which carries the
 * same 3:1 duty under WCAG 1.4.11) with the fill token, and no stylesheet may paint a
 * BACKGROUND with the link token — the same mistake in the other direction, which
 * would put `--kf-anchor-text` cream onto a bright leaf-green fill at 1.94:1.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const SEARCH_DIRS = ['app', 'components'];

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) cssFiles(full, out);
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

/** Comments explain the trap at length and must not be mistaken for the trap. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const INK_PROPS =
  /^(color|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|text-decoration-color|caret-color|fill|stroke)$/;
const FILL_PROPS = /^(background|background-color|background-image)$/;

interface Violation {
  file: string;
  prop: string;
  value: string;
  why: string;
}

function scan(): Violation[] {
  const bad: Violation[] = [];
  for (const dir of SEARCH_DIRS) {
    for (const file of cssFiles(join(root, dir))) {
      const src = stripComments(readFileSync(file, 'utf8'));
      const decl = /(?:^|[;{}])\s*(--)?([a-z-]+)\s*:\s*([^;{}]+)/g;
      let m: RegExpExecArray | null;
      while ((m = decl.exec(src))) {
        const isCustomProperty = Boolean(m[1]);
        if (isCustomProperty) continue; // aliases (preview.css --anchor) re-export the role as-is
        const [prop, value] = [m[2], m[3].trim()];
        const rel = file.slice(root.length);
        if (INK_PROPS.test(prop) && /var\(\s*--kf-anchor\s*[,)]/.test(value)) {
          bad.push({ file: rel, prop, value, why: '--kf-anchor is a FILL; use --kf-link for text/border' });
        }
        if (FILL_PROPS.test(prop) && /var\(\s*--kf-link\s*[,)]/.test(value)) {
          bad.push({ file: rel, prop, value, why: '--kf-link is TEXT; use --kf-anchor for a band fill' });
        }
      }
    }
  }
  return bad;
}

describe('--kf-anchor (fill) and --kf-link (text) are not interchangeable', () => {
  it('no stylesheet paints text, a border or an outline with the anchor FILL token', () => {
    const violations = scan().filter((v) => v.why.startsWith('--kf-anchor'));
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('no stylesheet paints a background with the link TEXT token', () => {
    const violations = scan().filter((v) => v.why.startsWith('--kf-link'));
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('the scanner actually finds the bug it exists to prevent (test-of-the-test)', () => {
    // The exact declaration that shipped in preferences.css, run through the same matcher.
    const shipped = '.kf-prefs__picks a {\n  color: var(--kf-anchor);\n}';
    const decl = /(?:^|[;{}])\s*(--)?([a-z-]+)\s*:\s*([^;{}]+)/g;
    const hits: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = decl.exec(stripComments(shipped)))) {
      if (!m[1] && INK_PROPS.test(m[2]) && /var\(\s*--kf-anchor\s*[,)]/.test(m[3])) hits.push(m[2]);
    }
    expect(hits).toEqual(['color']);
  });
});
