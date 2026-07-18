// tests/analytics/emit.test.ts — generic emitter + retention-window config.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { emitEvent } from '../../lib/analytics/emit';
import {
  retentionDays,
  retainedUntil,
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
} from '../../lib/analytics/config';

describe('emitEvent (best-effort)', () => {
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
    await expect(
      emitEvent('search_performed', { q: 'swim' }, { total: 3 }, 'anon-abc')
    ).resolves.toEqual({ ok: false });
  });

  it('never throws for a server-only event either', async () => {
    await expect(
      emitEvent('listing_status_changed', null, { from: 'confirmed', to: 'cancelled' }, 'system', {
        occurrenceId: '11111111-1111-1111-1111-111111111111',
      })
    ).resolves.toEqual({ ok: false });
  });
});

describe('retention window config', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ANALYTICS_RETENTION_DAYS;
    delete process.env.ANALYTICS_RETENTION_DAYS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ANALYTICS_RETENTION_DAYS;
    else process.env.ANALYTICS_RETENTION_DAYS = saved;
  });

  it('defaults to ~13 months (395 days)', () => {
    expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
    expect(DEFAULT_RETENTION_DAYS).toBe(395);
  });

  it('honours a valid override', () => {
    process.env.ANALYTICS_RETENTION_DAYS = '90';
    expect(retentionDays()).toBe(90);
  });

  it('falls back to default on a dangerous/invalid override (0, negative, NaN)', () => {
    for (const bad of ['0', '-5', 'abc', '']) {
      process.env.ANALYTICS_RETENTION_DAYS = bad;
      expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
    }
    expect(MIN_RETENTION_DAYS).toBe(1);
  });

  it('retainedUntil is exactly window days in the future from a given now', () => {
    process.env.ANALYTICS_RETENTION_DAYS = '30';
    const now = new Date('2026-01-01T00:00:00.000Z');
    const until = retainedUntil(now);
    expect(until.getTime() - now.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
