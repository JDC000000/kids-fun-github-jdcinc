import { describe, it, expect } from 'vitest';
import {
  activityTitle,
  buildDetailMetadata,
  canonicalActivityPath,
  describeActivity,
  notFoundDetailMetadata,
} from '../app/preview/_data/detail-metadata';
import { findActivity } from '../app/preview/_data/fixtures';
import type { Activity } from '../app/preview/_data/types';

// A stable fixture (all fields present, cost known, "Checked today" against FIXTURE_NOW).
const skate = findActivity('trout-lake-public-skate') as Activity;
// A fixture whose cost is unknown — proves the description never invents a price.
const unknownCost = findActivity('new-brighton-outdoor-pool') as Activity;

describe('canonicalActivityPath', () => {
  it('builds the /activity/[id] canonical path', () => {
    expect(canonicalActivityPath('trout-lake-public-skate')).toBe('/activity/trout-lake-public-skate');
  });
  it('url-encodes ids that need it', () => {
    expect(canonicalActivityPath('a b/c')).toBe('/activity/a%20b%2Fc');
  });
});

describe('activityTitle', () => {
  it('leads with activity — venue and brands it', () => {
    expect(activityTitle(skate)).toBe('Public skate — Trout Lake Rink · KIDS FUN');
  });
});

describe('describeActivity', () => {
  it('composes an honest summary from real fields', () => {
    const desc = describeActivity(skate);
    expect(desc).toContain('Ages 5–12');
    expect(desc).toContain('Trout Lake');
    expect(desc).toContain('$7 approx.');
    expect(desc).toContain('Source: vancouver.ca');
    expect(desc).toContain('Checked today');
  });
  it('never invents a price when cost is unknown', () => {
    const desc = describeActivity(unknownCost);
    expect(desc).toContain('Price not confirmed — check source');
    expect(desc).not.toMatch(/\$\d/);
  });
  it('stays within the social/search preview window', () => {
    for (const id of ['trout-lake-public-skate', 'science-world-tinker', 'qe-park-toboggan']) {
      const a = findActivity(id) as Activity;
      expect(describeActivity(a).length).toBeLessThanOrEqual(200);
    }
  });
});

describe('buildDetailMetadata', () => {
  const meta = buildDetailMetadata(skate, 'trout-lake-public-skate');

  it('sets the canonical to the /activity/[id] route', () => {
    expect(meta.alternates?.canonical).toBe('/activity/trout-lake-public-skate');
  });
  it('points OpenGraph at the same canonical url and brands the site', () => {
    expect(meta.openGraph?.url).toBe('/activity/trout-lake-public-skate');
    expect((meta.openGraph as { siteName?: string })?.siteName).toBe('KIDS FUN');
  });
  it('emits a summary twitter card with the honest description', () => {
    expect((meta.twitter as { card?: string })?.card).toBe('summary');
    expect(meta.twitter?.description).toBe(describeActivity(skate));
  });
  it('sets a metadataBase so relative urls resolve absolutely', () => {
    expect(meta.metadataBase).toBeInstanceOf(URL);
  });
  it('canonical always points at /activity even when built for the /preview shell', () => {
    // Same builder is used on /preview/[id]; canonical must still be the /activity route.
    expect(buildDetailMetadata(skate, 'trout-lake-public-skate').alternates?.canonical).toBe(
      '/activity/trout-lake-public-skate',
    );
  });
});

describe('notFoundDetailMetadata', () => {
  it('is noindex so dead detail urls are not indexed', () => {
    const meta = notFoundDetailMetadata();
    expect((meta.robots as { index?: boolean })?.index).toBe(false);
  });
});
