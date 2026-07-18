import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * WCAG contrast regression guard for the design tokens (Round-10 QA FINDING #1).
 *
 * The bug: a FIXED light palette token (--kf-neutral-100) used as a background
 * paired with a FLIPPING ink token produced light-on-light in dark mode. The fix
 * introduces the flipping --kf-surface-subtle role. This test PARSES the real
 * app/design-tokens.css (light :root + the dark @media override), resolves the
 * token graph for each scheme, and asserts every foreground/background pairing
 * used by the primitives clears AA (4.5:1) in BOTH light and dark — so this
 * class of trap cannot silently return as adopters add pairings.
 */

const css = readFileSync(
  fileURLToPath(new URL('../../../app/design-tokens.css', import.meta.url)),
  'utf8',
);

const DARK_MARKER = 'prefers-color-scheme: dark';
const darkAt = css.indexOf(DARK_MARKER);
const lightSrc = darkAt >= 0 ? css.slice(0, darkAt) : css;
const darkSrc = darkAt >= 0 ? css.slice(darkAt) : '';

function parseTokens(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(--kf-[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out[m[1]] = m[2].trim();
  return out;
}

const light = parseTokens(lightSrc);
const dark = { ...light, ...parseTokens(darkSrc) }; // dark inherits light, overrides win

function resolve(map: Record<string, string>, token: string): string {
  let v: string | undefined = map[token];
  const seen = new Set<string>();
  while (v && v.startsWith('var(')) {
    const name = v.slice(v.indexOf('(') + 1, v.indexOf(')')).trim();
    if (seen.has(name)) break;
    seen.add(name);
    v = map[name];
  }
  if (!v) throw new Error(`Unresolved token: ${token}`);
  return v.trim();
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(map: Record<string, string>, fgToken: string, bgToken: string): number {
  const a = luminance(resolve(map, fgToken));
  const b = luminance(resolve(map, bgToken));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;

// [label, fgToken, bgToken] — every fg/bg pairing the primitives actually render.
const PAIRINGS: [string, string, string][] = [
  // FINDING #1 — the ones that failed in dark mode before the fix.
  ['Badge neutral', '--kf-ink-secondary', '--kf-surface-subtle'],
  ['Button secondary/ghost :hover', '--kf-ink', '--kf-surface-subtle'],
  // Semantic status badges (the flipping pattern being mirrored).
  ['Badge confirmed', '--kf-confirmed-text', '--kf-confirmed-bg'],
  ['Badge info', '--kf-info-text', '--kf-info-bg'],
  ['Badge expected', '--kf-expected-text', '--kf-expected-bg'],
  ['Badge cancelled', '--kf-cancelled-text', '--kf-cancelled-bg'],
  // Text fields — Input and its multi-line twin Textarea share these pairings
  // (same tokens), so the guard covers both. Placeholder is held to AA too.
  ['Input/Textarea text', '--kf-ink', '--kf-surface'],
  ['Input/Textarea placeholder', '--kf-ink-muted', '--kf-surface'],
  // Chip primitive (Round 14 / Task O) — the selection vocabulary. Rail base text +
  // the segmented (view/map) UNSELECTED segment share this pairing (new to the guard).
  ['Chip rail/segmented base text', '--kf-ink-secondary', '--kf-surface'],
  // The list/map segmented ON-state — THE FIX. The old .kf-viewtoggle__btn--on was
  // white-on-Leaf (2.17:1, FAILED AA); this is Forest-ink on Leaf. Leaf + Forest-ink
  // are FIXED brand values, so it is identical (and AA) in BOTH schemes.
  ['Chip segmented selected (view/map on)', '--kf-forest-ink', '--kf-leaf'],
  // The "Near me" action chip's hover: text (--kf-ink) on the pale confirmed hover fill.
  ['Chip action :hover', '--kf-ink', '--kf-confirmed-bg'],
  // (Chip rail SELECTED reuses --kf-confirmed-text/-bg = "Badge confirmed" above, and the
  //  action/segmented-hover base reuses --kf-ink/--kf-surface = "Input/Textarea text" — both
  //  already guarded, so they are not duplicated here.)
];

describe('design-token contrast (WCAG AA, both schemes)', () => {
  for (const [label, fg, bg] of PAIRINGS) {
    it(`${label} passes AA in light and dark`, () => {
      const l = contrast(light, fg, bg);
      const d = contrast(dark, fg, bg);
      // Surface the actual ratios in the test output.
      console.log(`${label}: light ${l.toFixed(2)}:1 · dark ${d.toFixed(2)}:1`);
      expect(l, `${label} light`).toBeGreaterThanOrEqual(AA);
      expect(d, `${label} dark`).toBeGreaterThanOrEqual(AA);
    });
  }

  it('Button danger (white on --kf-danger) passes AA (fixed, both schemes)', () => {
    const l = contrast(light, '--kf-white', '--kf-danger');
    console.log(`Button danger: ${l.toFixed(2)}:1`);
    expect(l).toBeGreaterThanOrEqual(AA);
  });

  it('Chip segmented on-state FIXES the view/map toggle contrast bug (was white-on-Leaf)', () => {
    // BEFORE (Round 13 / Task K QA): .kf-viewtoggle__btn--on = color:#ffffff on
    // background:var(--leaf) — white on Leaf. AFTER: <Chip variant="segmented"> on-state =
    // --kf-forest-ink on --kf-leaf. Leaf is a fixed brand value, so both schemes are identical.
    const before = contrast(light, '--kf-white', '--kf-leaf');
    const after = contrast(light, '--kf-forest-ink', '--kf-leaf');
    console.log(`view/map toggle on-state: before ${before.toFixed(2)}:1 (white) → after ${after.toFixed(2)}:1 (forest-ink)`);
    // The OLD on-state must be a genuine AA failure — this encodes the bug so it can't return.
    expect(before, 'old white-on-Leaf must fail AA (the documented bug)').toBeLessThan(AA);
    // The NEW on-state must clear AA (and does so identically in dark, being a fixed brand pair).
    expect(after, 'new forest-ink-on-Leaf must pass AA').toBeGreaterThanOrEqual(AA);
  });

  it('regression: --kf-surface-subtle must flip between schemes (else light-on-light)', () => {
    expect(resolve(light, '--kf-surface-subtle')).not.toBe(resolve(dark, '--kf-surface-subtle'));
  });
});
