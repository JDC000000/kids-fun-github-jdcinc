// tests/health/sla-consistency.test.ts — G-T15-3 reconciliation guard.
// The worker-side canonical adherence predicate (worker/health/sla.ts::cadenceAdherent) and
// the /admin/data-health display predicate (lib/admin/data-health.ts::isCadenceAdherent) are
// deliberately two separate read paths (the Next app must not import from worker/). This test
// PINS them together: they must agree on every input, so the formula can never silently
// diverge. If someone edits one grace/threshold and not the other, this goes red.
import { describe, it, expect } from 'vitest';
import {
  cadenceAdherent,
  adherenceFactor as workerAdherenceFactor,
  isFullyAdherent as workerIsFullyAdherent,
  SLA_CADENCE_GRACE as WORKER_GRACE,
  CLEAN_SUCCESS_RUN_SQL as WORKER_CLEAN_SUCCESS_SQL,
} from '../../worker/health/sla';
import {
  isCadenceAdherent,
  adherenceFactor as adminAdherenceFactor,
  isFullyAdherent as adminIsFullyAdherent,
  SLA_CADENCE_GRACE as ADMIN_GRACE,
} from '../../lib/admin/data-health';
import { CLEAN_SUCCESS_RUN_SQL as ADMIN_CLEAN_SUCCESS_SQL } from '../../lib/admin/dashboard';

const NOW = Date.parse('2026-07-20T12:00:00Z');
const DAY = 86_400;
const agoMs = (s: number): number => NOW - s * 1000;

describe('worker vs admin cadence-adherence parity', () => {
  it('the two grace constants are identical', () => {
    expect(WORKER_GRACE).toBe(ADMIN_GRACE);
  });

  it('the two predicates agree across a table of inputs', () => {
    const cadences = [null, 0, 3600, DAY, 7 * DAY];
    // Lags deliberately straddle BOTH the 1× and the grace× boundary, so the two
    // constants cannot drift apart around either edge.
    const lags = [
      null,
      0,
      1800,
      3600,
      3600 + 30,
      1.5 * 3600,
      2 * 3600,
      DAY - 1,
      DAY,
      DAY + 1,
      DAY + 60,
      1.5 * DAY - 1,
      1.5 * DAY,
      1.5 * DAY + 1,
      2 * DAY,
      8 * DAY,
      11 * DAY,
    ];
    for (const cadenceSeconds of cadences) {
      for (const lag of lags) {
        const input = { lastSuccessAtMs: lag == null ? null : agoMs(lag), cadenceSeconds };
        expect(
          cadenceAdherent(input, NOW),
          `mismatch for cadence=${cadenceSeconds} lag=${lag}`
        ).toBe(isCadenceAdherent(input, NOW));
      }
    }
  });

  // ── the CONTINUOUS measure must be pinned just as hard ──────────────────────────
  // The boolean is now derived from adherenceFactor in both files, so a divergence in
  // the decay would drag the pass/fail verdict with it. Exact numeric equality, not
  // toBeCloseTo: these are two copies of one formula, not two approximations of it.
  it('the two continuous adherenceFactor copies agree EXACTLY, including deep into the decay', () => {
    const cadences = [null, 0, -1, 60, 3600, 2 * 3600, DAY, 7 * DAY];
    const lags = [
      null,
      -60, // clock skew: last success in the future
      0,
      1,
      1800,
      3600,
      3600 + 30,
      1.4626 * 3600, // worst in-grace gap actually observed on staging
      1.5 * 3600,
      1.5 * 3600 + 0.001,
      2 * 3600,
      DAY - 1,
      DAY,
      DAY + 1,
      DAY + 60,
      1.5 * DAY - 1,
      1.5 * DAY,
      1.5 * DAY + 1,
      2 * DAY,
      2.0005 * DAY, // the real H.R. MacMillan missed cycle
      3 * DAY,
      5.3829 * DAY,
      7.4923 * DAY, // the real City of Vancouver events-calendar outage
      12.0508 * DAY,
      24.0093 * DAY,
      365 * DAY,
    ];
    for (const cadenceSeconds of cadences) {
      for (const lag of lags) {
        const input = { lastSuccessAtMs: lag == null ? null : agoMs(lag), cadenceSeconds };
        expect(
          workerAdherenceFactor(input, NOW),
          `mismatch for cadence=${cadenceSeconds} lag=${lag}`
        ).toBe(adminAdherenceFactor(input, NOW));
      }
    }
  });

  it('a non-default grace stays in parity too', () => {
    for (const grace of [1, 1.25, 1.5, 2, 3]) {
      for (const lag of [0, DAY, 1.5 * DAY, 2 * DAY, 10 * DAY]) {
        const input = { lastSuccessAtMs: agoMs(lag), cadenceSeconds: DAY };
        expect(workerAdherenceFactor(input, NOW, grace), `grace=${grace} lag=${lag}`).toBe(
          adminAdherenceFactor(input, NOW, grace)
        );
        expect(cadenceAdherent(input, NOW, grace), `grace=${grace} lag=${lag}`).toBe(
          isCadenceAdherent(input, NOW, grace)
        );
      }
    }
  });

  it('both files agree on what "fully adherent" means', () => {
    for (const v of [0, 0.5, 0.9999, 1, 1.0001, 2]) {
      expect(workerIsFullyAdherent(v)).toBe(adminIsFullyAdherent(v));
    }
  });
});

// F-11. The grace parity above pins the PURE predicate, but both sides feed that predicate a
// `lastSuccessAtMs` computed by their own SQL — and that SQL was where the two could (and did)
// silently mean different things. "Last successful check" must mean the same thing on the
// worker's health board and on /admin/data-health: a run that COMPLETED and raised NO health
// verdict. Same duplication rationale as the grace constant (the Next app cannot import from
// worker/), so it gets the same treatment: two copies, pinned byte-for-byte here.
describe('worker vs admin clean-successful-run SQL parity', () => {
  it('the two predicates are byte-identical', () => {
    expect(WORKER_CLEAN_SUCCESS_SQL).toBe(ADMIN_CLEAN_SUCCESS_SQL);
  });

  it('the predicate excludes alerted runs and assumes the `cr` alias', () => {
    // Pinned explicitly, not just against each other: two copies edited in lock-step to
    // something wrong (e.g. dropping the alert clause) would still satisfy the test above.
    expect(WORKER_CLEAN_SUCCESS_SQL).toContain('health_alert_code IS NULL');
    expect(WORKER_CLEAN_SUCCESS_SQL).toContain("cr.status IN ('success', 'partial')");
  });
});
