// tests/admin/data-health-logic.test.ts — PURE unit tests for the data-health logic
// (SLA cadence-adherence + coverage-or-gap assembly). No DB: exact values on known
// inputs, mirroring tests/admin/health-alerts.test.ts. The DB-backed behaviour is
// covered separately in tests/admin/data-health-db.test.ts.
import { describe, it, expect } from 'vitest';
import {
  LAUNCH_REGIONS,
  P0_FAMILIES,
  SLA_CADENCE_TARGET_PCT,
  adherencePct,
  buildCoverageMatrix,
  isCadenceAdherent,
  meetsSlaTarget,
  networkShort,
  type CoverageRawRow,
  type FamilyDef,
  type RegionDef,
} from '../../lib/admin/data-health';

const NOW = Date.parse('2026-07-19T12:00:00Z');
const DAY = 86_400; // seconds
const agoMs = (seconds: number): number => NOW - seconds * 1000;

describe('isCadenceAdherent', () => {
  it('a source that succeeded within one cadence interval is adherent', () => {
    expect(isCadenceAdherent({ lastSuccessAtMs: agoMs(6 * 3600), cadenceSeconds: DAY }, NOW)).toBe(true);
  });

  it('is inclusive exactly at 1× cadence (boundary)', () => {
    // grace defaults to 1 → threshold == cadence; equal is still adherent (<=).
    expect(isCadenceAdherent({ lastSuccessAtMs: agoMs(DAY), cadenceSeconds: DAY }, NOW)).toBe(true);
  });

  it('a source lagging past its cadence is NOT adherent', () => {
    expect(isCadenceAdherent({ lastSuccessAtMs: agoMs(1.5 * DAY), cadenceSeconds: DAY }, NOW)).toBe(false);
  });

  it('a source that never succeeded is NOT adherent', () => {
    expect(isCadenceAdherent({ lastSuccessAtMs: null, cadenceSeconds: DAY }, NOW)).toBe(false);
  });

  it('falls back to the default cadence when none is configured', () => {
    // No cadence → DEFAULT_CADENCE_SECONDS (1 day). 6h ago is within 1 day → adherent.
    expect(isCadenceAdherent({ lastSuccessAtMs: agoMs(6 * 3600), cadenceSeconds: null }, NOW)).toBe(true);
    // 2 days ago > 1 day default → not adherent.
    expect(isCadenceAdherent({ lastSuccessAtMs: agoMs(2 * DAY), cadenceSeconds: 0 }, NOW)).toBe(false);
  });

  it('scales with a longer (weekly) cadence', () => {
    const week = 7 * DAY;
    expect(isCadenceAdherent({ lastSuccessAtMs: agoMs(5 * DAY), cadenceSeconds: week }, NOW)).toBe(true);
    expect(isCadenceAdherent({ lastSuccessAtMs: agoMs(8 * DAY), cadenceSeconds: week }, NOW)).toBe(false);
  });
});

describe('adherencePct / meetsSlaTarget', () => {
  it('computes a whole-number percentage', () => {
    expect(adherencePct(95, 100)).toBe(95);
    expect(adherencePct(3, 4)).toBe(75);
    expect(adherencePct(1, 3)).toBe(33);
  });

  it('returns null when there are no enabled sources (no misleading 0%)', () => {
    expect(adherencePct(0, 0)).toBeNull();
    expect(adherencePct(5, 0)).toBeNull();
  });

  it('meetsSlaTarget honours the ≥95% target and null-safety', () => {
    expect(meetsSlaTarget(95)).toBe(true);
    expect(meetsSlaTarget(96)).toBe(true);
    expect(meetsSlaTarget(94)).toBe(false);
    expect(meetsSlaTarget(null)).toBe(false);
    expect(SLA_CADENCE_TARGET_PCT).toBe(95);
  });
});

describe('buildCoverageMatrix', () => {
  const regions: RegionDef[] = [
    { key: 'van', name: 'Vancouver', label: 'Vancouver' },
    { key: 'bby', name: 'Burnaby', label: 'Burnaby' },
  ];
  const families: FamilyDef[] = [
    { key: 'open_gym', label: 'Open Gym' },
    { key: 'public_swim', label: 'Swim' },
  ];
  const raw: CoverageRawRow[] = [
    { regionName: 'Vancouver', familyKey: 'open_gym', network: 'activenet', cnt: 3 },
    { regionName: 'Vancouver', familyKey: 'open_gym', network: 'perfectmind', cnt: 2 },
    { regionName: 'Burnaby', familyKey: 'public_swim', network: 'activenet', cnt: 1 },
    // noise that must be ignored:
    { regionName: 'Nowhere', familyKey: 'open_gym', network: 'activenet', cnt: 9 }, // region not in grid
    { regionName: 'Vancouver', familyKey: 'not_a_family', network: 'activenet', cnt: 9 }, // family not in grid
    { regionName: 'Vancouver', familyKey: 'open_gym', network: 'activenet', cnt: 0 }, // zero count
  ];

  const matrix = buildCoverageMatrix(regions, families, raw);

  it('produces a full region × family grid (no missing cells)', () => {
    expect(matrix.cellCount).toBe(4);
    expect(matrix.rows).toHaveLength(2);
    for (const row of matrix.rows) expect(row.cells).toHaveLength(2);
  });

  it('sums per-cell counts and per-network breakdown, ignoring out-of-grid noise', () => {
    const vanOpenGym = matrix.rows[0].cells.find((c) => c.regionKey === 'van')!;
    expect(matrix.rows[0].family.key).toBe('open_gym');
    expect(vanOpenGym.total).toBe(5);
    expect(vanOpenGym.byNetwork).toEqual({ activenet: 3, perfectmind: 2 });
    expect(vanOpenGym.gap).toBe(false);
  });

  it('marks every zero-coverage combination as an EXPLICIT gap', () => {
    const vanSwim = matrix.rows[1].cells.find((c) => c.regionKey === 'van')!;
    const bbyOpenGym = matrix.rows[0].cells.find((c) => c.regionKey === 'bby')!;
    expect(vanSwim.gap).toBe(true);
    expect(vanSwim.total).toBe(0);
    expect(vanSwim.byNetwork).toEqual({});
    expect(bbyOpenGym.gap).toBe(true);
  });

  it('computes covered/gap tallies and totals', () => {
    expect(matrix.coveredCount).toBe(2);
    expect(matrix.gapCount).toBe(2);
    expect(matrix.grandTotal).toBe(6);
    expect(matrix.regionTotals).toEqual([5, 1]); // [Vancouver, Burnaby]
    expect(matrix.rows[0].total).toBe(5); // open_gym across regions
    expect(matrix.rows[1].total).toBe(1); // swim across regions
  });

  it('lists contributing networks with the P0 networks (ActiveNet, PerfectMind) first', () => {
    expect(matrix.networks).toEqual(['activenet', 'perfectmind']);
  });

  it('gap ⟺ total === 0 across the whole grid (invariant)', () => {
    for (const row of matrix.rows) {
      for (const cell of row.cells) {
        expect(cell.gap).toBe(cell.total === 0);
      }
    }
  });
});

describe('canonical taxonomy constants', () => {
  it('exposes the 5 launch regions in REGION_CHIPS order', () => {
    expect(LAUNCH_REGIONS.map((r) => r.key)).toEqual(['van', 'nvan', 'wvan', 'bby', 'rmd']);
  });

  it('exposes the 10 P0 activity families (primary-eligible categories)', () => {
    expect(P0_FAMILIES).toHaveLength(10);
    expect(P0_FAMILIES.map((f) => f.key)).toContain('open_gym');
    expect(P0_FAMILIES.map((f) => f.key)).not.toContain('miniature_train'); // secondary-only
  });

  it('gives ActiveNet / PerfectMind friendly short codes', () => {
    expect(networkShort('activenet')).toBe('AN');
    expect(networkShort('perfectmind')).toBe('PM');
    expect(networkShort('unknown_family')).toBe('UN'); // fallback = first 2 chars, upper
  });
});
