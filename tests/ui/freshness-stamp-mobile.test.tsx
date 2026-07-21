import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FreshnessStamp } from '../../app/preview/_components/FreshnessStamp';
import type { Activity } from '../../app/preview/_data/types';

// BUG-011 (bug bash G-T39-3, Round 27): on a 375px viewport the "✓ Confirmed · <source> ·
// Checked today" trust badge — the product's core trust signal — overflowed the viewport
// (right≈399.8px vs innerWidth=375) and clipped "Checked today" on every card + detail.
//
// vitest runs in the `node` environment (no layout engine), so real pixel overflow can't be
// measured here — that is re-verified by QA's real-browser lane at 320/360/375/390px. This
// guard instead locks in the CSS mechanics that make horizontal overflow impossible: the
// stamp wraps, is capped to its container width, and its long source token can break.
// (Mirrors the CSS-parse convention in tests/ui/brand-tokens.test.ts.)

const cssPath = fileURLToPath(new URL('../../app/preview/preview.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

/** Grab the declaration body of an exact single-class rule (not its --modifiers). */
function ruleBody(selector: string): string {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`CSS rule not found: ${selector}`);
  return m[1];
}

describe('BUG-011: freshness stamp cannot overflow a narrow mobile viewport', () => {
  it('the source name renders through the breakable .kf-stamp__src span', () => {
    const activity = {
      status: 'confirmed',
      lastCheckedIso: '2026-07-20T16:00:00.000Z',
      sourceName: 'yourlibrary.bibliocommons.com', // the long hostname that overflowed
    } as unknown as Activity;
    const html = renderToStaticMarkup(<FreshnessStamp activity={activity} />);
    expect(html).toContain('kf-stamp__src');
    expect(html).toContain('yourlibrary.bibliocommons.com');
  });

  it('.kf-stamp wraps and is capped to its container width', () => {
    const body = ruleBody('.kf-stamp');
    expect(body).toMatch(/flex-wrap:\s*wrap/);
    expect(body).toMatch(/max-width:\s*100%/);
  });

  it('.kf-stamp__src lets a long source hostname break instead of overflowing', () => {
    const body = ruleBody('.kf-stamp__src');
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
    expect(body).toMatch(/min-width:\s*0/);
  });

  it('has a narrow-viewport tune so the wrapped stamp stays compact on phones', () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*400px\)/);
  });
});
