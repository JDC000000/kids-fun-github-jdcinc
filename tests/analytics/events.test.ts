// tests/analytics/events.test.ts — writeAnalyticsEvent is best-effort (never throws).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeAnalyticsEvent } from '../../lib/analytics/events';

describe('writeAnalyticsEvent (best-effort)', () => {
  let savedDbUrl: string | undefined;
  beforeEach(() => {
    savedDbUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  it('resolves { ok: false } instead of throwing when the DB is unavailable', async () => {
    await expect(writeAnalyticsEvent({ eventType: 'listing_viewed' })).resolves.toEqual({ ok: false });
  });
});
