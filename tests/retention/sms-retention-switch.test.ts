// tests/retention/sms-retention-switch.test.ts — the F1 regression guard for SMS_RETENTION_DRY_RUN,
// plus the handler's mode logging.
//
// F1 WAS A REAL, SHIPPED DATA-DESTRUCTION BUG in the corrections job: the kill-switch was compared
// with `=== 'true'`, so "TRUE" and "1" both failed the match, resolved to "delete for real", and
// permanently destroyed rows while the operator believed deletions were paused.
//
// This job stands in front of an irreversible action on the most sensitive table in the schema, so
// the identical guard is asserted here rather than assumed to be inherited. These tests would have
// caught F1.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SMS_RETENTION_DRY_RUN_ENV,
  resolveSmsRetentionDryRun,
  smsRetentionDryRunForced,
  SMS_STOPPED_RETENTION_DAYS,
  SMS_PENDING_RETENTION_DAYS,
} from '@/lib/retention/sms-config';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

function setSwitch(v: string) {
  vi.stubEnv(SMS_RETENTION_DRY_RUN_ENV, v);
}

describe('F1 — every spelling of the kill-switch resolves the same way', () => {
  const cases = [
    { raw: 'true', dryRun: true, reason: 'explicit_pause' },
    { raw: 'TRUE', dryRun: true, reason: 'explicit_pause' }, // THE LIVE HAZARD in F1
    { raw: 'True', dryRun: true, reason: 'explicit_pause' },
    { raw: '1', dryRun: true, reason: 'explicit_pause' },    // THE OTHER LIVE HAZARD
    { raw: ' on ', dryRun: true, reason: 'explicit_pause' },
    { raw: 'yes', dryRun: true, reason: 'explicit_pause' },
    { raw: 'false', dryRun: false, reason: 'explicit_run' },
    { raw: 'OFF', dryRun: false, reason: 'explicit_run' },
    { raw: '0', dryRun: false, reason: 'explicit_run' },
  ] as const;

  for (const c of cases) {
    it(`🔴 ${JSON.stringify(c.raw)} → dryRun=${c.dryRun}`, () => {
      setSwitch(c.raw);
      const r = resolveSmsRetentionDryRun();
      expect(r.dryRun).toBe(c.dryRun);
      expect(r.reason).toBe(c.reason);
      expect(smsRetentionDryRunForced()).toBe(c.dryRun);
    });
  }

  it('🔴 an unrecognised value FAILS SAFE to paused, and says so out loud', () => {
    // Asymmetric costs: wrongly pausing delays a purge the next run fixes; wrongly purging is
    // unrecoverable. Someone who set the variable at all was reaching for the switch.
    setSwitch('PAUSE-PLEASE');
    const r = resolveSmsRetentionDryRun();
    expect(r.dryRun).toBe(true);
    expect(r.reason).toBe('unrecognised');
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('PAUSE-PLEASE');
    expect(String(warn.mock.calls[0][0])).toContain('FAILING SAFE');
  });

  it('a recognised value never warns', () => {
    setSwitch('TRUE');
    resolveSmsRetentionDryRun();
    setSwitch('false');
    resolveSmsRetentionDryRun();
    expect(warn).not.toHaveBeenCalled();
  });

  it('🔴 UNSET means PURGE — a decision, not an inherited default', () => {
    // Deliberate, and the opposite choice was genuinely arguable. It loses because this job
    // exists BECAUSE a deletion promise was live and nothing performed it. If unset meant
    // "paused", arming the schedule would run the job, purge nothing, and silently reproduce
    // the exact bug being fixed. The schedule ships disabled; that is the safety gate.
    const r = resolveSmsRetentionDryRun();
    expect(r.dryRun).toBe(false);
    expect(r.reason).toBe('unset');
    expect(r.raw).toBeNull();
  });

  it('an empty or whitespace value counts as unset, not unrecognised', () => {
    setSwitch('   ');
    expect(resolveSmsRetentionDryRun().reason).toBe('unset');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the windows match migration 0034', () => {
  it('are 30 and 90 days', () => {
    // Not env-overridable on purpose: an env that could disagree with the migration would let
    // the retention PROMISE drift from the retention BEHAVIOUR, which is this whole bug.
    expect(SMS_STOPPED_RETENTION_DAYS).toBe(30);
    expect(SMS_PENDING_RETENTION_DAYS).toBe(90);
  });
});
