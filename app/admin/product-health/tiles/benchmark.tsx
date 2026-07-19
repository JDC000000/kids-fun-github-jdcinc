// app/admin/product-health/tiles/benchmark.tsx — G-T32-5 benchmark tile.
//
// Target-vs-actual for the KPIs Round 16 already computes, plus the flagship
// "open gym near East Van" query as a NAMED standing benchmark. Presentational and
// server-compatible (no `use client`) — the exact pattern KpiTiles.tsx / SlaTile.tsx
// use: it takes already-derived rows as props (the page does the SELECT-only reads)
// and renders them on the shared, brand-token-driven <Card> + <Badge> primitives, so
// it reads consistently in light and dark. Status is a <Badge> with a GLYPH + WORDS
// ("✓ on target"), never colour alone (WCAG 1.4.1) — and it uses the semantic Badge
// tokens, never the chart-series colours, so a status can't impersonate a series.
import { Badge, Card } from '@/components/ui';
import { formatCount, formatTimestampUtc } from '@/lib/admin/format';
import type { BenchmarkRow, FlagshipQueryStats } from '@/lib/analytics/benchmark';
import styles from '../_components/ProductHealth.module.css';

const EM_DASH = '—';

/** The live value, formatted for its metric kind; em-dash when there's no data. */
function formatActual(row: BenchmarkRow): string {
  if (row.actual == null || !Number.isFinite(row.actual)) return EM_DASH;
  switch (row.format) {
    case 'pct':
      return `${row.actual}%`;
    case 'perDay':
      return `${row.actual.toLocaleString('en-CA', { maximumFractionDigits: 1 })} / day`;
    case 'results':
      return `${row.actual.toLocaleString('en-CA', { maximumFractionDigits: 1 })} avg`;
    case 'count':
    default:
      return formatCount(row.actual);
  }
}

/** "target ≥25%" / "target ≤10%" / "target ≥20 / day" … */
function formatTarget(row: BenchmarkRow): string {
  const cmp = row.direction === 'gte' ? '≥' : '≤';
  let suffix = '';
  if (row.format === 'pct') suffix = '%';
  else if (row.format === 'perDay') suffix = ' / day';
  else if (row.format === 'results') suffix = ' avg';
  return `target ${cmp}${row.target.toLocaleString('en-CA')}${suffix}`;
}

function benchBadge(met: boolean | null): { text: string; variant: 'confirmed' | 'expected' | 'neutral' } {
  if (met == null) return { text: `${EM_DASH} no data`, variant: 'neutral' };
  return met ? { text: '✓ on target', variant: 'confirmed' } : { text: '✗ off target', variant: 'expected' };
}

function BenchmarkTileCard({ row }: { row: BenchmarkRow }) {
  const badge = benchBadge(row.met);
  return (
    <Card className={styles.tile}>
      <div className={styles.tileLabel}>{row.label}</div>
      <div className={styles.tileValue}>{formatActual(row)}</div>
      <div className={styles.badgeRow}>
        <Badge variant={badge.variant}>{badge.text}</Badge>
      </div>
      <div className={styles.tileSub}>
        {formatTarget(row)} · <span className={styles.dim}>{row.source}</span>
      </div>
    </Card>
  );
}

export interface BenchmarkTileProps {
  /** Target-vs-actual for the Round-16 KPIs. */
  kpiRows: BenchmarkRow[];
  /** The flagship query's live stats. */
  flagship: FlagshipQueryStats;
  /** The flagship query's own target-vs-actual rows. */
  flagshipRows: BenchmarkRow[];
}

export function BenchmarkTile({ kpiRows, flagship, flagshipRows }: BenchmarkTileProps) {
  const metCount = kpiRows.filter((r) => r.met === true).length;
  const scored = kpiRows.filter((r) => r.met != null).length;

  return (
    <section className={styles.section} aria-label="Product-health benchmarks">
      <h2 className={styles.sectionTitle}>Benchmarks · target vs actual</h2>
      <p className={styles.hint}>
        The launch product targets read against the live KPIs from{' '}
        <span className={styles.mono}>analytics_event</span>. Only the source click-through target is a ratified
        KPI (TSD §12.5 #7); the rest are explicit launch goals so every metric has a bar to read against.{' '}
        {scored > 0 ? (
          <strong>
            {formatCount(metCount)} of {formatCount(scored)} on target.
          </strong>
        ) : (
          <span className={styles.dim}>Not enough data yet to score any target.</span>
        )}
      </p>

      <div className={styles.tileRow}>
        {kpiRows.map((row) => (
          <BenchmarkTileCard key={row.key} row={row} />
        ))}
      </div>

      {/* Flagship named query benchmark. */}
      <h3 className={styles.subhead}>Flagship query benchmark</h3>
      <Card className={styles.flagship}>
        <div className={styles.flagshipHead}>
          <div>
            <div className={styles.flagshipLabel}>Flagship query</div>
            <div className={styles.flagshipQuery}>“{flagship.label}”</div>
          </div>
          <div className={styles.flagshipBadges}>
            {flagshipRows.map((row) => {
              const badge = benchBadge(row.met);
              return (
                <div key={row.key} className={styles.flagshipBadgeItem}>
                  <Badge variant={badge.variant}>{badge.text}</Badge>
                  <span className={styles.flagshipBadgeLabel}>
                    {row.label} · {formatTarget(row)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className={styles.flagshipStats}>
          <div className={styles.flagshipStat}>
            <span className={styles.flagshipStatValue}>{formatCount(flagship.runs)}</span>
            <span className={styles.flagshipStatLabel}>runs · last {flagship.windowDays}d</span>
          </div>
          <div className={styles.flagshipStat}>
            <span className={styles.flagshipStatValue}>
              {flagship.avgResults == null ? EM_DASH : flagship.avgResults.toLocaleString('en-CA')}
            </span>
            <span className={styles.flagshipStatLabel}>avg results</span>
          </div>
          <div className={styles.flagshipStat}>
            <span className={styles.flagshipStatValue}>{formatCount(flagship.zeroResultRuns)}</span>
            <span className={styles.flagshipStatLabel}>zero-result runs</span>
          </div>
          <div className={styles.flagshipStat}>
            <span className={styles.flagshipStatValue}>{formatCount(flagship.broadenedRuns)}</span>
            <span className={styles.flagshipStatLabel}>broadened to fill</span>
          </div>
        </div>

        <p className={styles.tileSub}>
          {flagship.runs === 0 ? (
            <>
              No runs of the flagship query in the last {flagship.windowDays} days yet — this benchmark fills in as
              parents run “{flagship.label}”. A standing benchmark on the canonical query surfaces a catalogue hole
              the moment that search starts coming back thin.
            </>
          ) : (
            <>
              Last run <span className={styles.mono}>{formatTimestampUtc(flagship.lastRunAt)}</span>. A flagship query
              should essentially never come back empty — if the zero-result badge turns amber, the East-Van gym
              catalogue has a gap to fill.
            </>
          )}
        </p>
      </Card>
    </section>
  );
}
