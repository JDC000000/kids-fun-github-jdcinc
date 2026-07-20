// tests/health/sla-consistency.test.ts — G-T15-3 reconciliation guard.
// The worker-side canonical adherence predicate (worker/health/sla.ts::cadenceAdherent) and
// the /admin/data-health display predicate (lib/admin/data-health.ts::isCadenceAdherent) are
// deliberately two separate read paths (the Next app must not import from worker/). This test
// PINS them together: they must agree on every input, so the formula can never silently
// diverge. If someone edits one grace/threshold and not the other, this goes red.
import { describe, it, expect } from 'vitest';
import { cadenceAdherent, SLA_CADENCE_GRACE as WORKER_GRACE } from '../../worker/health/sla';
import { isCadenceAdherent, SLA_CADENCE_GRACE as ADMIN_GRACE } from '../../lib/admin/data-health';

const NOW = Date.parse('2026-07-20T12:00:00Z');
const DAY = 86_400;
const agoMs = (s: number): number => NOW - s * 1000;

describe('worker vs admin cadence-adherence parity', () => {
  it('the two grace constants are identical', () => {
    expect(WORKER_GRACE).toBe(ADMIN_GRACE);
  });

  it('the two predicates agree across a table of inputs', () => {
    const cadences = [null, 0, 3600, DAY, 7 * DAY];
    const lags = [null, 0, 1800, DAY - 1, DAY, DAY + 1, 2 * DAY, 8 * DAY];
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
});
