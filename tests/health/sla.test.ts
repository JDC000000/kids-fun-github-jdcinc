// tests/health/sla.test.ts — G-T15-3 canonical worker-side health SLA.
//  • PURE: the three dimensions (cadence adherence, check-success rate, parse yield) and
//    the health_state fold, on known inputs.
//  • DB: computeHealthSla over seeded source_check_run rows with HAND-VERIFIED math, plus
//    applyHealthStates persisting the computed health_state.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  cadenceAdherent,
  checkSuccessRate,
  parseYieldRate,
  computeSourceHealth,
  adherencePct,
  meetsSlaTarget,
  computeHealthSla,
  applyHealthStates,
  HEALTH_SLA_TARGET_PCT,
  SLA_CADENCE_GRACE,
} from '../../worker/health/sla';
import { getPool, query, closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const NOW = Date.parse('2026-07-20T12:00:00Z');
const DAY = 86_400;
const agoMs = (s: number): number => NOW - s * 1000;

describe('SLA dimensions (pure)', () => {
  it('cadenceAdherent mirrors the grace × cadence rule', () => {
    expect(cadenceAdherent({ lastSuccessAtMs: agoMs(6 * 3600), cadenceSeconds: DAY }, NOW)).toBe(true);
    expect(cadenceAdherent({ lastSuccessAtMs: agoMs(DAY), cadenceSeconds: DAY }, NOW)).toBe(true);
    expect(cadenceAdherent({ lastSuccessAtMs: agoMs(SLA_CADENCE_GRACE * DAY), cadenceSeconds: DAY }, NOW)).toBe(
      true
    ); // inclusive exactly at grace×
    expect(cadenceAdherent({ lastSuccessAtMs: agoMs(2 * DAY), cadenceSeconds: DAY }, NOW)).toBe(false);
    expect(cadenceAdherent({ lastSuccessAtMs: null, cadenceSeconds: DAY }, NOW)).toBe(false);
  });

  // ── REGRESSION (2026-08-01) ───────────────────────────────────────────────────
  // The grace was 1, which is unsatisfiable in steady state: the scheduler fires a
  // source one cadence after the last fire, so the observed gap is `cadence + jitter`
  // with jitter structurally ≥ 0. Every production run since launch measured
  // 1440.4–1441.0 min against a 1440 min cadence and scored NOT adherent — costing
  // 0.30 of computeSourceHealth, which worker/core/confidence.ts multiplies in, which
  // moved the confirmed/needs_review threshold ~46% and mass-reclassified thousands of
  // user-visible occurrences. These cases pin the fix: a source running exactly on its
  // cadence is adherent; one that has skipped a whole cycle still is not.
  it('a source running exactly on cadence stays adherent despite scheduler drift', () => {
    for (const cadence of [3600, 2 * 3600, DAY]) {
      for (const driftSeconds of [0, 1, 30, 60, 240]) {
        expect(
          cadenceAdherent({ lastSuccessAtMs: agoMs(cadence + driftSeconds), cadenceSeconds: cadence }, NOW),
          `cadence=${cadence}s drift=+${driftSeconds}s must still be adherent`
        ).toBe(true);
      }
    }
  });

  it('a source that has skipped an entire cycle is NOT adherent', () => {
    for (const cadence of [3600, 2 * 3600, DAY]) {
      expect(
        cadenceAdherent({ lastSuccessAtMs: agoMs(2 * cadence), cadenceSeconds: cadence }, NOW),
        `cadence=${cadence}s, a full missed cycle must not be adherent`
      ).toBe(false);
    }
  });

  it('checkSuccessRate = succeeded ÷ attempted (null when none attempted)', () => {
    expect(checkSuccessRate({ attempted: 4, succeeded: 3, withRecords: 3 })).toBe(0.75);
    expect(checkSuccessRate({ attempted: 0, succeeded: 0, withRecords: 0 })).toBeNull();
  });

  it('parseYieldRate = successful-with-records ÷ successful (null when no successes)', () => {
    expect(parseYieldRate({ attempted: 5, succeeded: 4, withRecords: 3 })).toBe(0.75);
    expect(parseYieldRate({ attempted: 3, succeeded: 0, withRecords: 0 })).toBeNull();
  });

  it('computeSourceHealth folds the three dimensions with the documented precedence', () => {
    expect(computeSourceHealth({ adherence: 1, successRate: null, parseYieldRate: null, attempted: 0 }))
      .toMatchObject({ state: 'unknown', score: null });
    expect(computeSourceHealth({ adherence: 0, successRate: 0.4, parseYieldRate: 1, attempted: 5 }).state).toBe('failing');
    expect(computeSourceHealth({ adherence: 0, successRate: 0.8, parseYieldRate: 1, attempted: 5 }).state).toBe('stale');
    expect(computeSourceHealth({ adherence: 1, successRate: 0.8, parseYieldRate: 1, attempted: 5 }).state).toBe('degraded');
    expect(computeSourceHealth({ adherence: 1, successRate: 1, parseYieldRate: 0.4, attempted: 5 }).state).toBe('degraded');
    const healthy = computeSourceHealth({ adherence: 1, successRate: 1, parseYieldRate: 1, attempted: 5 });
    expect(healthy.state).toBe('healthy');
    expect(healthy.score).toBe(1); // 0.5·1 + 0.3·1 + 0.2·1
    expect(computeSourceHealth({ adherence: 1, successRate: 0.95, parseYieldRate: 0.8, attempted: 5 }).score).toBe(0.94); // 0.475+0.3+0.16
  });

  it('adherencePct / meetsSlaTarget honour the ≥95% target + null-safety', () => {
    expect(adherencePct(19, 20)).toBe(95);
    expect(adherencePct(0, 0)).toBeNull();
    expect(meetsSlaTarget(95)).toBe(true);
    expect(meetsSlaTarget(94)).toBe(false);
    expect(meetsSlaTarget(null)).toBe(false);
    expect(HEALTH_SLA_TARGET_PCT).toBe(95);
  });
});

describe.skipIf(!hasDb)('computeHealthSla over seeded runs (DB, hand-verified)', () => {
  const TAG = `t15sla_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ids = { healthy: '', stale: '', failing: '', editorial: '' };
  let dbNowMs = 0;

  beforeAll(async () => {
    dbNowMs = Date.parse(await (async () => {
      const [r] = await query<{ now: string }>(`SELECT now()::text AS now`);
      return r.now;
    })());

    async function mkSource(name: string, tier: string): Promise<string> {
      const [s] = await query<{ id: string }>(
        `INSERT INTO source (family, name, terms_status, authority_tier, baseline_cadence)
         VALUES ('noop', $1, 'allowed', $2, '1 day') RETURNING id`,
        [name, tier]
      );
      return s.id;
    }
    ids.healthy = await mkSource(`${TAG} healthy`, 'official');
    ids.stale = await mkSource(`${TAG} stale`, 'official');
    ids.failing = await mkSource(`${TAG} failing`, 'official');
    ids.editorial = await mkSource(`${TAG} editorial`, 'editorial'); // enabled but NOT P0

    // healthy: 3 successes with records, most recent 2h ago (< 1d cadence) → adherent.
    for (const h of [2, 26, 50]) {
      await query(
        `INSERT INTO source_check_run (source_id, status, records_found, started_at)
         VALUES ($1, 'success', 5, now() - ($2 || ' hours')::interval)`,
        [ids.healthy, h]
      );
    }
    // stale: 2 successes with records, but last one 3 DAYS ago (> 1d cadence) → not adherent.
    for (const d of [3, 4]) {
      await query(
        `INSERT INTO source_check_run (source_id, status, records_found, started_at)
         VALUES ($1, 'success', 5, now() - ($2 || ' days')::interval)`,
        [ids.stale, d]
      );
    }
    // failing: 3 failed runs, no successes → successRate 0 → failing.
    for (const h of [1, 5, 9]) {
      await query(
        `INSERT INTO source_check_run (source_id, status, started_at)
         VALUES ($1, 'failed', now() - ($2 || ' hours')::interval)`,
        [ids.failing, h]
      );
    }
    // editorial: one recent success so it's adherent (proves it counts in enabled, not P0).
    await query(
      `INSERT INTO source_check_run (source_id, status, records_found, started_at)
       VALUES ($1, 'success', 3, now() - interval '1 hour')`,
      [ids.editorial]
    );
  });

  afterAll(async () => {
    for (const id of Object.values(ids)) if (id) await query(`DELETE FROM source_check_run WHERE source_id = $1`, [id]);
    for (const id of Object.values(ids)) if (id) await query(`DELETE FROM source WHERE id = $1`, [id]);
    await closePool();
  });

  it('scores each seeded source exactly as the math predicts', async () => {
    const sla = await computeHealthSla(getPool(), dbNowMs);
    const find = (id: string) => sla.sources.find((s) => s.sourceId === id)!;

    const healthy = find(ids.healthy);
    expect(healthy.counts).toEqual({ attempted: 3, succeeded: 3, withRecords: 3 });
    expect(healthy.successRate).toBe(1);
    expect(healthy.parseYieldRate).toBe(1);
    expect(healthy.adherent).toBe(true);
    expect(healthy.health.state).toBe('healthy');
    expect(healthy.health.score).toBe(1);
    expect(healthy.isP0).toBe(true);

    const stale = find(ids.stale);
    expect(stale.counts).toEqual({ attempted: 2, succeeded: 2, withRecords: 2 });
    expect(stale.successRate).toBe(1);
    expect(stale.adherent).toBe(false); // last success 3d ago > 1d cadence
    expect(stale.health.state).toBe('stale');

    const failing = find(ids.failing);
    expect(failing.counts).toEqual({ attempted: 3, succeeded: 0, withRecords: 0 });
    expect(failing.successRate).toBe(0);
    expect(failing.parseYieldRate).toBeNull();
    expect(failing.health.state).toBe('failing');

    const editorial = find(ids.editorial);
    expect(editorial.isP0).toBe(false); // enabled but not official → excluded from P0 SLA
    expect(editorial.adherent).toBe(true);
  });

  it('aggregate P0 SLA arithmetic is internally consistent', async () => {
    const sla = await computeHealthSla(getPool(), dbNowMs);
    // Our three P0 sources contribute 1 adherent (healthy) of 3 — verify they're in the P0 set.
    const mineP0 = sla.sources.filter((s) => [ids.healthy, ids.stale, ids.failing].includes(s.sourceId));
    expect(mineP0.every((s) => s.isP0)).toBe(true);
    expect(mineP0.filter((s) => s.adherent).length).toBe(1);

    expect(sla.p0AdherencePct).toBe(adherencePct(sla.p0AdherentCount, sla.p0Count));
    expect(sla.meetsTarget).toBe(meetsSlaTarget(sla.p0AdherencePct));
    expect(sla.enabledCount).toBeGreaterThanOrEqual(4);
    expect(sla.targetPct).toBe(95);
  });

  it('applyHealthStates persists the computed health_state onto the source row', async () => {
    const sla = await computeHealthSla(getPool(), dbNowMs);
    await applyHealthStates(getPool(), sla);
    const [h] = await query<{ health_state: string }>(`SELECT health_state FROM source WHERE id = $1`, [ids.healthy]);
    const [st] = await query<{ health_state: string }>(`SELECT health_state FROM source WHERE id = $1`, [ids.stale]);
    const [f] = await query<{ health_state: string }>(`SELECT health_state FROM source WHERE id = $1`, [ids.failing]);
    expect(h.health_state).toBe('healthy');
    expect(st.health_state).toBe('stale');
    expect(f.health_state).toBe('failing');
  });
});
