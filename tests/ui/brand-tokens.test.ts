import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Brand V2 — AA-safe TEXT-token verification (G-T38-5).
 * ---------------------------------------------------------------------------
 * Locks in Round 18 / Task Y's contrast remediation (G-T38-4) as a PERMANENT
 * regression guard so nobody can silently reintroduce a low-contrast body-text
 * token in a future round.
 *
 * This is deliberately COMPLEMENTARY to components/ui/__tests__/contrast.test.ts
 * (Round 10 / FINDING #1). That guard covers the UI-primitive fg/bg PAIRINGS
 * (Badge/Button/Chip/Input) in both schemes. It does NOT model the two things
 * that actually broke in the Round-17 axe audit and that Task Y fixed:
 *
 *   (a) the darkened muted brand greys used as *body / meta / label text* on the
 *       real surfaces they render on (white card + warm-paper canvas), and
 *   (b) the compounding `.kf-card--muted { opacity: 0.9 }` blend — text tokens
 *       composited at 0.9 over their background. Task Y's root-cause was that the
 *       old greys sat *just* under AA on paper and the 0.9 blend dragged them
 *       further down (e.g. --kf-park-moss-text #5f7360 → 3.85:1 as a muted Badge,
 *       --kf-tertiary-text #6c766b → 4.23:1 plain on paper). Both are BELOW AA.
 *
 * The AA target for normal text is 4.5:1 (WCAG 1.4.3). Every ratio below is
 * COMPUTED from the real token hexes parsed out of app/design-tokens.css — no
 * expected-pass value is hardcoded. The alpha-composite mirrors what a browser
 * (and axe-core) actually measures: an sRGB channel blend of the 0.9-opacity
 * text over its background, rounded to the 8-bit pixel that gets rendered.
 *
 * The bottom `describe` block is a test-OF-the-test: it re-runs the SAME math on
 * the pre-Round-18 hexes and asserts they would FAIL — encoding the bug so the
 * exact low-contrast values can never quietly return, and proving the guard is
 * not trivially green regardless of the colours.
 */

const cssPath = fileURLToPath(new URL('../../app/design-tokens.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

// Split the file into the light `:root` and the dark `@media` override, exactly
// as the sibling primitive-contrast guard does, so dark inherits + overrides win.
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
const dark = { ...light, ...parseTokens(darkSrc) }; // dark inherits light; overrides win
const SCHEMES: Array<[name: string, map: Record<string, string>]> = [
  ['light', light],
  ['dark', dark],
];

/** Follow a `var(--x)` chain down to a concrete value (hex). */
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

function contrastHex(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Composite a foreground colour at `alpha` opacity over `bg`, the way the
 * browser paints `opacity` and the way axe-core measures the resulting pixel:
 * a per-channel sRGB (gamma-space) blend, rounded to the 8-bit value rendered.
 * alpha = 1 returns fg unchanged.
 */
function composite(fg: string, bg: string, alpha: number): string {
  if (alpha >= 1) return fg;
  const [fr, fgc, fb] = rgb(fg);
  const [br, bgc, bb] = rgb(bg);
  const blend = (f: number, b: number) => Math.round(f * alpha + b * (1 - alpha));
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${hex(blend(fr, br))}${hex(blend(fgc, bgc))}${hex(blend(fb, bb))}`;
}

const AA = 4.5;
const MUTED_CARD = 0.9; // .kf-card--muted { opacity: 0.9 } — the compounding blend Task Y fixed
const HERO_WORDMARK = 0.85; // .kf-hero__wordmark { opacity: 0.85 }

/**
 * Every body/meta/label/link text token in the system, paired with the real
 * surface it renders on, in BOTH schemes. `alpha` < 1 models the muted-card
 * (or hero-wordmark) opacity blend that dragged the pre-Round-18 greys under AA.
 *
 * fg / bg are token names; the test resolves them per-scheme so a token that
 * FLIPS in dark (ink / ink-secondary / ink-muted / info-text) is checked with
 * its dark value on the dark surface, not its light value.
 */
type Pairing = { label: string; fg: string; bg: string; alpha?: number };

const TEXT_PAIRINGS: Pairing[] = [
  // ── Primary body text (--kf-ink) — sanity anchor; must be comfortably AA. ──
  { label: 'body text (ink) on card surface', fg: '--kf-ink', bg: '--kf-surface' },
  { label: 'body text (ink) on canvas', fg: '--kf-ink', bg: '--kf-canvas' },
  { label: 'body text (ink) in muted card', fg: '--kf-ink', bg: '--kf-surface', alpha: MUTED_CARD },

  // ── Secondary text — --kf-ink-secondary → --kf-park-moss-text (Task Y #1). ──
  //    .kf-card__meta renders this on the white card; the muted variant blends 0.9.
  { label: 'secondary/meta (park-moss-text) on card surface', fg: '--kf-ink-secondary', bg: '--kf-surface' },
  { label: 'secondary/meta (park-moss-text) on canvas', fg: '--kf-ink-secondary', bg: '--kf-canvas' },
  { label: 'secondary/meta in MUTED card (×0.9)', fg: '--kf-ink-secondary', bg: '--kf-surface', alpha: MUTED_CARD },
  // Badge `neutral` fill is --kf-surface-subtle; inside a muted card it blends 0.9
  // (this exact case was 3.85:1 pre-Task-Y — the worst muted-badge offender).
  { label: 'secondary on subtle fill (Badge neutral) in MUTED card (×0.9)', fg: '--kf-ink-secondary', bg: '--kf-surface-subtle', alpha: MUTED_CARD },

  // ── Tertiary/metadata text — --kf-ink-muted → --kf-tertiary-text (Task Y #2). ──
  //    .kf-section__count sits on the warm-paper canvas; .kf-card__type on the
  //    white card; both go through the 0.9 blend in a muted card.
  { label: 'metadata (tertiary-text) on card surface', fg: '--kf-ink-muted', bg: '--kf-surface' },
  { label: 'metadata (tertiary-text) on canvas', fg: '--kf-ink-muted', bg: '--kf-canvas' },
  { label: 'card type (tertiary-text) in MUTED card (×0.9)', fg: '--kf-ink-muted', bg: '--kf-surface', alpha: MUTED_CARD },
  { label: 'section count (tertiary-text) on canvas in MUTED card (×0.9)', fg: '--kf-ink-muted', bg: '--kf-canvas', alpha: MUTED_CARD },

  // ── Link / CTA text — --kf-info-text is the canonical link colour used by
  //    .kf-card__cta and .kf-link, rendered on the white card (and 0.9 when muted). ──
  { label: 'link/CTA (info-text) on card surface', fg: '--kf-info-text', bg: '--kf-surface' },
  { label: 'link/CTA (info-text) in MUTED card (×0.9)', fg: '--kf-info-text', bg: '--kf-surface', alpha: MUTED_CARD },

  // ── Hero anchor FILL — warm-paper text on the anchor band; wordmark is 0.85. This pair is
  //    a fill + the ink that sits ON it (preview.css .kf-hero), which is why --kf-anchor is
  //    allowed to be near-black in dark mode and why links must NOT use it. ──
  { label: 'hero anchor text on anchor fill', fg: '--kf-anchor-text', bg: '--kf-anchor' },
  { label: 'hero wordmark (×0.85) on anchor fill', fg: '--kf-anchor-text', bg: '--kf-anchor', alpha: HERO_WORDMARK },

  // ── Link role (--kf-link, split out of --kf-anchor on 2026-09-13) — on EVERY surface a link
  //    actually renders on. The bug this encodes: --kf-anchor's dark value is the hero fill
  //    (#0e110e), so every link that borrowed it measured 1.15–1.65:1 in dark mode — verified
  //    in Chromium on /u/…, /sms/start, /sms/signup, /link-unavailable, /activity-unavailable
  //    before the fix. Checking all three surfaces, not just the canvas, is deliberate: the
  //    preferences page's links are on --kf-surface (5.74:1), not the canvas (7.61:1). ──
  { label: 'link on canvas', fg: '--kf-link', bg: '--kf-canvas' },
  { label: 'link on card surface', fg: '--kf-link', bg: '--kf-surface' },
  { label: 'link on subtle surface', fg: '--kf-link', bg: '--kf-surface-subtle' },
  { label: 'link in MUTED card (×0.9)', fg: '--kf-link', bg: '--kf-surface', alpha: MUTED_CARD },
  // Links sit inside the preferences status panel and the start-page notices, which are
  // status fills rather than plain surfaces.
  { label: 'link on confirmed fill', fg: '--kf-link', bg: '--kf-confirmed-bg' },
  { label: 'link on expected fill', fg: '--kf-link', bg: '--kf-expected-bg' },

  // ── Status text tokens as text on their paired fills (both schemes). The
  //    sibling primitive guard checks these on plain badges; here they also go
  //    through the muted-card 0.9 blend (freshness stamps live inside cards). ──
  { label: 'confirmed stamp text in MUTED card (×0.9)', fg: '--kf-confirmed-text', bg: '--kf-confirmed-bg', alpha: MUTED_CARD },
  { label: 'info stamp text in MUTED card (×0.9)', fg: '--kf-info-text', bg: '--kf-info-bg', alpha: MUTED_CARD },
  { label: 'expected stamp text in MUTED card (×0.9)', fg: '--kf-expected-text', bg: '--kf-expected-bg', alpha: MUTED_CARD },
  { label: 'cancelled stamp text in MUTED card (×0.9)', fg: '--kf-cancelled-text', bg: '--kf-cancelled-bg', alpha: MUTED_CARD },
];

describe('Brand V2 text tokens are AA-safe (WCAG 1.4.3, ≥4.5:1) — locks in Round 18 / Task Y', () => {
  for (const { label, fg, bg, alpha } of TEXT_PAIRINGS) {
    it(`${label} clears AA in light and dark`, () => {
      for (const [scheme, map] of SCHEMES) {
        const bgHex = resolve(map, bg);
        const fgHex = composite(resolve(map, fg), bgHex, alpha ?? 1);
        const ratio = contrastHex(fgHex, bgHex);
        console.log(
          `${label} · ${scheme}: ${ratio.toFixed(2)}:1  (${fgHex} on ${bgHex}${alpha ? ` @${alpha}` : ''})`,
        );
        expect(ratio, `${label} · ${scheme}`).toBeGreaterThanOrEqual(AA);
      }
    });
  }

  /**
   * THE ROOT-CAUSE GUARD, not a contrast one.
   *
   * --kf-anchor (a fill) and --kf-link (text) were ONE token, and the reason the conflation
   * survived five separate reviews is that in LIGHT mode they are legitimately the same colour —
   * Evergreen is both a fine band and a fine link. It is only in dark mode that a fill must go
   * darker than the canvas while a link must go lighter. So: same value in light is fine and
   * expected; the same value in DARK means somebody has re-merged the roles.
   */
  it('the link role and the anchor FILL role stay separate in dark mode', () => {
    expect(resolve(light, '--kf-link')).toBe(resolve(light, '--kf-anchor'));
    expect(resolve(dark, '--kf-link')).not.toBe(resolve(dark, '--kf-anchor'));
    // And the direction is not arbitrary: on the dark canvas the fill is DARKER and the link
    // is LIGHTER. A link that resolves darker than its own canvas is the shipped bug.
    const canvas = luminance(resolve(dark, '--kf-canvas'));
    expect(luminance(resolve(dark, '--kf-link'))).toBeGreaterThan(canvas);
    expect(luminance(resolve(dark, '--kf-anchor'))).toBeLessThan(canvas);
  });

  it('the two Task Y tokens hold their darkened light-mode values', () => {
    // Guards against a silent revert of the specific hexes Task Y landed. If the
    // brand intentionally re-tunes these, update BOTH this assertion and the
    // pre-Round-18 guard below — a two-place change is the point (make it loud).
    expect(resolve(light, '--kf-park-moss-text')).toBe('#4d604c');
    expect(resolve(light, '--kf-tertiary-text')).toBe('#555e54');
  });
});

/**
 * Test-of-the-test: the SAME math on the PRE-Round-18 hexes must report AA
 * FAILURES for the exact scenarios the Round-17 axe audit flagged. This proves
 * the guard above is real (not trivially green) and permanently encodes the bug
 * so the old low-contrast values cannot return unnoticed.
 */
describe('regression encoding — the pre-Round-18 greys DID fail AA (bug lock)', () => {
  const PRE = {
    parkMoss: '#5f7360', // old --kf-park-moss-text
    tertiary: '#6c766b', // old --kf-tertiary-text
  };

  it('old park-moss #5f7360 fails AA as a MUTED Badge neutral (was ~3.85:1)', () => {
    const bg = resolve(light, '--kf-surface-subtle');
    const ratio = contrastHex(composite(PRE.parkMoss, bg, MUTED_CARD), bg);
    console.log(`pre-R18 park-moss muted badge: ${ratio.toFixed(2)}:1 (must be < ${AA})`);
    expect(ratio).toBeLessThan(AA);
  });

  it('old tertiary #6c766b fails AA plain on warm paper (was ~4.23:1)', () => {
    const bg = resolve(light, '--kf-canvas');
    const ratio = contrastHex(PRE.tertiary, bg);
    console.log(`pre-R18 tertiary on paper: ${ratio.toFixed(2)}:1 (must be < ${AA})`);
    expect(ratio).toBeLessThan(AA);
  });

  it('old tertiary #6c766b fails AA as a MUTED card type (×0.9) (was ~3.93:1)', () => {
    const bg = resolve(light, '--kf-surface');
    const ratio = contrastHex(composite(PRE.tertiary, bg, MUTED_CARD), bg);
    console.log(`pre-R18 tertiary muted type: ${ratio.toFixed(2)}:1 (must be < ${AA})`);
    expect(ratio).toBeLessThan(AA);
  });

  it('the current tokens FIX every scenario the old ones broke', () => {
    // Same three scenarios, current values — all must now clear AA. This ties the
    // "old fails" evidence directly to the "new passes" claim in one place.
    const subtle = resolve(light, '--kf-surface-subtle');
    const paper = resolve(light, '--kf-canvas');
    const surface = resolve(light, '--kf-surface');
    const now = {
      parkMuted: contrastHex(composite(resolve(light, '--kf-park-moss-text'), subtle, MUTED_CARD), subtle),
      tertPaper: contrastHex(resolve(light, '--kf-tertiary-text'), paper),
      tertMuted: contrastHex(composite(resolve(light, '--kf-tertiary-text'), surface, MUTED_CARD), surface),
    };
    console.log(
      `current fixes: park-moss muted badge ${now.parkMuted.toFixed(2)}:1 · tertiary paper ${now.tertPaper.toFixed(2)}:1 · tertiary muted type ${now.tertMuted.toFixed(2)}:1`,
    );
    expect(now.parkMuted).toBeGreaterThanOrEqual(AA);
    expect(now.tertPaper).toBeGreaterThanOrEqual(AA);
    expect(now.tertMuted).toBeGreaterThanOrEqual(AA);
  });
});
