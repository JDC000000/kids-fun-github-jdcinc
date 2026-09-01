// tests/retention/sms-retention-handler.test.ts — the worker job handler's contract.
import { afterEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted: vi.mock's factory is hoisted above the file, so it cannot close over ordinary
// top-level consts (that fails with "Cannot access ... before initialization" at collect time).
const { purgeStoppedSubscriberData, purgeUnconfirmedSignups } = vi.hoisted(() => ({
  purgeStoppedSubscriberData: vi.fn(async () => ({
    dryRun: false, cutoff: '2026-08-02T00:00:00.000Z', matched: 2, purged: 2,
    batches: 1, retentionDays: 30, truncated: false,
  })),
  purgeUnconfirmedSignups: vi.fn(async () => ({
    dryRun: false, cutoff: '2026-06-03T00:00:00.000Z', matched: 1, purged: 1,
    batches: 1, retentionDays: 90, truncated: false,
  })),
}));
vi.mock('../../lib/retention/sms', () => ({ purgeStoppedSubscriberData, purgeUnconfirmedSignups }));

import { SMS_RETENTION_JOB_TYPE, makeSmsRetentionJobHandler } from '../../worker/core/sms-retention';

const JOB = { id: 'job-1', jobType: SMS_RETENTION_JOB_TYPE } as never;

afterEach(() => {
  vi.unstubAllEnvs();
  purgeStoppedSubscriberData.mockClear();
  purgeUnconfirmedSignups.mockClear();
});

describe('the sms_retention job handler', () => {
  it('is registered under the job_type the migration seeds', () => {
    // job_queue.job_type is free text (0011 has no CHECK), so nothing in the database catches a
    // typo between the schedule row and the registry — only this agreement does.
    expect(SMS_RETENTION_JOB_TYPE).toBe('sms_retention');
  });

  it('runs BOTH purges', async () => {
    const logger = { log: vi.fn() };
    await makeSmsRetentionJobHandler({ logger })(JOB);
    expect(purgeStoppedSubscriberData).toHaveBeenCalledTimes(1);
    expect(purgeUnconfirmedSignups).toHaveBeenCalledTimes(1);
  });

  it('🔴 logs the resolved mode BEFORE either purge runs', async () => {
    // Has to exist even if a purge then throws: "was the kill-switch on?" must be answerable
    // from the log, not inferred from an env var whose spelling is what went wrong in F1.
    const calls: string[] = [];
    const logger = { log: (m: string) => { calls.push(m); } };
    purgeStoppedSubscriberData.mockImplementationOnce(async () => { throw new Error('db down'); });
    await expect(makeSmsRetentionJobHandler({ logger })(JOB)).rejects.toThrow('db down');
    expect(calls[0]).toContain('effective mode');
    expect(calls[0]).toContain('PURGING');
  });

  it('🔴 propagates the kill-switch to both purges', async () => {
    vi.stubEnv('SMS_RETENTION_DRY_RUN', 'TRUE'); // the F1 spelling
    const logger = { log: vi.fn() };
    await makeSmsRetentionJobHandler({ logger })(JOB);
    expect(purgeStoppedSubscriberData).toHaveBeenCalledWith({ dryRun: true });
    expect(purgeUnconfirmedSignups).toHaveBeenCalledWith({ dryRun: true });
  });

  it('🔴 logs counts only — never a phone number, postal code or birth year', async () => {
    const calls: string[] = [];
    await makeSmsRetentionJobHandler({ logger: { log: (m: string) => { calls.push(m); } } })(JOB);
    const all = calls.join(' ');
    expect(all).not.toMatch(/\+1\d{10}/);
    expect(all).not.toMatch(/[A-Z]\d[A-Z]\s?\d[A-Z]\d/);
    expect(all).toContain('purged=2');
    expect(all).toContain('purged=1');
  });

  it('throws on a DB failure rather than recording a silent success', async () => {
    purgeUnconfirmedSignups.mockImplementationOnce(async () => { throw new Error('boom'); });
    await expect(makeSmsRetentionJobHandler({ logger: { log: vi.fn() } })(JOB)).rejects.toThrow('boom');
  });
});
