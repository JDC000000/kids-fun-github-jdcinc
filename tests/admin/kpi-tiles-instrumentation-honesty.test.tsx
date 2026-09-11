// tests/admin/kpi-tiles-instrumentation-honesty.test.tsx
//
// The admin KPI section must never present a STRUCTURAL zero as a MEASURED one.
//
// Six §9 events (outbound_source_click, saved_search_created, weekly_email_opt_in,
// account_signed_in, correction_report_submitted, listing_status_changed) have a
// capture layer in lib/analytics/** but no emit call site on the product path —
// their rollups are 0 because nothing can ever write them, not because parents
// aren't engaging. Rendering that as a bare "0" (or "0%") makes the dashboard
// claim to measure something it does not measure; `outbound_source_click` is the
// headline beta engagement KPI, so this is the difference between "nobody clicked
// through" and "we are not counting click-throughs".
//
// Node-env test (no jsdom): render to static markup and assert on the HTML, the
// technique tests/admin/operating-trends.test.tsx already uses.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { KpiTiles } from '../../app/admin/dashboard/_components/KpiTiles';
import { EVENT_CATALOG, catalogEntry } from '../../lib/analytics/catalog';
import type { ProductHealthKpis } from '../../lib/analytics/kpi';

/** The day-one shape: capture is live, nothing has been emitted yet. */
const ZEROES: ProductHealthKpis = {
  windows: { engagementDays: 7, dauDays: 1, wauDays: 7, mauDays: 30, accountDays: 30 },
  engagement: {
    searches: 0,
    listingViews: 0,
    outboundClicks: 0,
    searchesWithResults: 0,
    zeroResultSearches: 0,
    broadenedSearches: 0,
  },
  activeUsers: { dau: 0, wau: 0, mau: 0 },
  accountValue: { savedSearches: 0, emailOptIns: 0, signInEvents: 0, signedInUsers: 0 },
};

/** Real traffic on the wired events; the un-wired ones stay structurally 0. */
const WITH_TRAFFIC: ProductHealthKpis = {
  ...ZEROES,
  engagement: {
    searches: 400,
    listingViews: 120,
    outboundClicks: 0,
    searchesWithResults: 380,
    zeroResultSearches: 19,
    broadenedSearches: 4,
  },
  activeUsers: { dau: 12, wau: 60, mau: 140 },
};

function render(kpis: ProductHealthKpis): string {
  return renderToStaticMarkup(<KpiTiles kpis={kpis} />);
}

/** Every tile label the section renders, used only to find tile boundaries. */
const TILE_LABELS = [
  'Searches',
  'Listing views',
  'Outbound source clicks',
  'Source click-through rate',
  'Zero-result search rate',
  'DAU \u00b7 last 1d',
  'WAU \u00b7 last 7d',
  'MAU \u00b7 last 30d',
  'Signed-in users \u00b7 last 30d',
  'Saved searches created',
  'Weekly-email opt-ins',
  'Sign-ins',
] as const;

/**
 * One tile's markup, sliced from its label div up to the next tile's label div.
 * Anchored on the rendered label text rather than a CSS-module class, because
 * those are content-hashed — the same reason tests/admin/operating-trends.test.tsx
 * asserts on text and ARIA instead of classes.
 */
function tileFor(html: string, label: string): string {
  const anchor = (l: string) => html.indexOf(`>${l}</div>`);
  const at = anchor(label);
  expect(at, `tile "${label}" is missing from the KPI section`).toBeGreaterThan(-1);
  const next = TILE_LABELS.map(anchor)
    .filter((i) => i > at)
    .sort((a, b) => a - b)[0];
  return html.slice(at, next ?? html.length);
}

const UNWIRED_TILE_LABELS = [
  'Outbound source clicks',
  'Source click-through rate',
  'Signed-in users \u00b7 last 30d',
  'Saved searches created',
  'Weekly-email opt-ins',
  'Sign-ins',
];

describe('un-instrumented KPI tiles', () => {
  it('says "Not yet instrumented" rather than a number on every tile whose event has no emit site', () => {
    const html = render(WITH_TRAFFIC);
    for (const label of UNWIRED_TILE_LABELS) {
      expect(tileFor(html, label), `${label} must not fabricate a measurement`).toContain(
        'Not yet instrumented',
      );
    }
  });

  it('names the missing event on the tile so the reader knows what to wire', () => {
    const html = render(ZEROES);
    expect(tileFor(html, 'Outbound source clicks')).toContain('outbound_source_click');
    expect(tileFor(html, 'Saved searches created')).toContain('saved_search_created');
    expect(tileFor(html, 'Weekly-email opt-ins')).toContain('weekly_email_opt_in');
    expect(tileFor(html, 'Sign-ins')).toContain('account_signed_in');
  });

  it('never prints a bare 0 / 0% as the value of an un-instrumented tile', () => {
    const html = render(WITH_TRAFFIC);
    // The CTR tile is the sharpest case: 0 clicks ÷ 120 views is a real-looking
    // "0%" that would read as a failed KPI #7 rather than an unmeasured one.
    const ctr = tileFor(html, 'Source click-through rate');
    expect(ctr).not.toContain('0%');
    expect(ctr).not.toContain('25% target met');
    expect(ctr).not.toContain('below 25% target');
    // …and the outbound tile must not claim a rate.
    expect(tileFor(html, 'Outbound source clicks')).not.toContain('/ day');
  });

  it('suppresses the "% of MAU" share badge, which is derived from the same un-wired event', () => {
    const html = render(WITH_TRAFFIC); // mau = 140, signedInUsers = 0 → would render "0% of MAU"
    expect(tileFor(html, 'Signed-in users \u00b7 last 30d')).not.toContain('of MAU');
  });
});

describe('wired KPI tiles are untouched', () => {
  it('still renders real numbers for the two events that do have emit sites', () => {
    const html = render(WITH_TRAFFIC);
    expect(tileFor(html, 'Searches')).not.toContain('Not yet instrumented');
    expect(tileFor(html, 'Listing views')).not.toContain('Not yet instrumented');
    expect(tileFor(html, 'Zero-result search rate')).not.toContain('Not yet instrumented');
    expect(html).toContain('400 in 7d');
    expect(html).toContain('120 in 7d');
  });

  it('leaves DAU/WAU/MAU alone — they aggregate across all events, wired ones included', () => {
    const html = render(WITH_TRAFFIC);
    for (const label of ['DAU · last 1d', 'WAU · last 7d', 'MAU · last 30d']) {
      expect(tileFor(html, label)).not.toContain('Not yet instrumented');
    }
  });
});

describe('the honesty label is driven by the catalog, not a hard-coded list', () => {
  it('treats exactly the catalog\'s non-"wired" events as un-instrumented', () => {
    // Guards the mechanism: when a stream wires its emit and flips its catalog
    // entry to 'wired', the tile must go back to showing a number WITHOUT an
    // edit to KpiTiles.tsx. If this list ever drifts, this test is the tripwire.
    const unwired = EVENT_CATALOG.filter((e) => e.wiring !== 'wired').map((e) => e.type);
    expect(new Set(unwired)).toEqual(
      new Set([
        'outbound_source_click',
        'saved_search_created',
        'weekly_email_opt_in',
        'account_signed_in',
        'correction_report_submitted',
        'listing_status_changed',
      ]),
    );
    expect(catalogEntry('search_performed')?.wiring).toBe('wired');
    expect(catalogEntry('listing_viewed')?.wiring).toBe('wired');
  });
});
