// tests/analytics/retention-dry-run-switch.test.ts — F1, arriving in this subsystem last.
//
// lib/analytics/config.ts read `env('ANALYTICS_RETENTION_DRY_RUN') === 'true'` until 2026-09-01 —
// the exact comparison that caused a real, shipped data-destruction incident in the corrections
// retention job, where "TRUE" and "1" both resolved to "delete for real" while the operator
// believed deletions were paused. The corrections fix was never carried across to this file.
//
// IT WAS NOT CAUSING WRONG BEHAVIOUR WHEN IT WAS FOUND — the var is unset in production, and unset
// resolves identically under both parsers. It would have fired the FIRST time anyone set it, which
// is the moment someone is deliberately trying to stop deletions. Every assertion below fails
// against the old implementation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYTICS_RETENTION_DRY_RUN_ENV,
  resolveAnalyticsRetentionDryRun,
  retentionDryRunForced,
} from '@/lib/analytics/config';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

const set = (v: string) => vi.stubEnv(ANALYTICS_RETENTION_DRY_RUN_ENV, v);

describe('F1 — the spellings that used to delete instead of pause', () => {
  // Each of these returned FALSE under `=== 'true'`, i.e. "delete for real", while the operator
  // who typed them was trying to stop deletions.
  for (const raw of ['TRUE', 'True', '1', 'yes', 'Y', 'on', 'ON', ' true ', 't']) {
    it(`🔴 ${JSON.stringify(raw)} PAUSES (it used to delete)`, () => {
      set(raw);
      expect(resolveAnalyticsRetentionDryRun().dryRun).toBe(true);
      expect(retentionDryRunForced()).toBe(true);
    });
  }

  for (const raw of ['false', 'FALSE', '0', 'no', 'off', 'f']) {
    it(`${JSON.stringify(raw)} deletes`, () => {
      set(raw);
      expect(retentionDryRunForced()).toBe(false);
    });
  }
});

describe('the fail-safe and the default', () => {
  it('🔴 an unrecognised value PAUSES, loudly', () => {
    // Asymmetric: a wrongly-paused purge is fixed by the next run; a wrongly-deleted row is gone.
    set('pause please');
    const r = resolveAnalyticsRetentionDryRun();
    expect(r.dryRun).toBe(true);
    expect(r.reason).toBe('unrecognised');
    expect(String(warn.mock.calls[0][0])).toContain('FAILING SAFE');
  });

  it('🔴 UNSET still means DELETE — verified against THIS file, not inherited', () => {
    // lib/analytics/config.ts's own header says "unset/false = the job actually deletes", and the
    // retention promise on the privacy page depends on that staying true. The corrections module
    // happens to agree; that was checked rather than assumed, because they are separate subsystems
    // with separate documented defaults.
    const r = resolveAnalyticsRetentionDryRun();
    expect(r.dryRun).toBe(false);
    expect(r.reason).toBe('unset');
    expect(warn).not.toHaveBeenCalled();
  });

  it('empty/whitespace is unset, not unrecognised — it must not silently pause retention', () => {
    set('   ');
    expect(resolveAnalyticsRetentionDryRun().reason).toBe('unset');
    expect(retentionDryRunForced()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
