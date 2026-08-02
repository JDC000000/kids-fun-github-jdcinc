// SlaTile.tsx — G-T33-1: source-freshness SLA (aggregate cadence adherence).
//
// Presentational, server-compatible (no `use client`). Renders the aggregate
// "% of enabled sources meeting their cadence" vs the ≥95% target, plus a compact
// breakdown of the sources currently NOT on-cadence (the ones a human needs to act
// on). All derived numbers come from the pure helpers in lib/admin/data-health.ts.
import { Badge, Card } from '@/components/ui';
import { formatAge, formatCadence, formatCount, formatTimestampUtc } from '@/lib/admin/format';
import { SLA_CADENCE_GRACE, SLA_CADENCE_TARGET_PCT, type SourceFreshnessSla } from '@/lib/admin/data-health';
import { STALE_CADENCE_GRACE } from '@/lib/admin/dashboard';
import styles from './DataHealth.module.css';

const EM_DASH = '—';

function formatPct(value: number | null): string {
  return value == null ? EM_DASH : `${value}%`;
}

function Tile({
  label,
  value,
  sub,
  badge,
}: {
  label: string;
  value: string;
  sub?: string;
  badge?: { text: string; variant: 'confirmed' | 'info' | 'expected' | 'cancelled' | 'neutral' };
}) {
  return (
    <Card className={styles.tile}>
      <div className={styles.tileLabel}>{label}</div>
      <div className={styles.tileValue}>{value}</div>
      {badge && (
        <div className={styles.badgeRow}>
          <Badge variant={badge.variant}>{badge.text}</Badge>
        </div>
      )}
      {sub && <div className={styles.tileSub}>{sub}</div>}
    </Card>
  );
}

function slaBadge(sla: SourceFreshnessSla): { text: string; variant: 'confirmed' | 'expected' | 'neutral' } {
  if (sla.adherencePct == null) return { text: 'no enabled sources', variant: 'neutral' };
  return sla.meetsTarget
    ? { text: `≥${SLA_CADENCE_TARGET_PCT}% target met`, variant: 'confirmed' }
    : { text: `below ${SLA_CADENCE_TARGET_PCT}% target`, variant: 'expected' };
}

export function SlaTile({ sla, nowMs }: { sla: SourceFreshnessSla; nowMs: number }) {
  const laggingCount = sla.enabledCount - sla.adherentCount;
  const lagging = sla.sources.filter((s) => !s.adherent);

  return (
    <section className={styles.section} aria-label="Source-freshness SLA">
      <h2 className={styles.sectionTitle}>Source-freshness SLA</h2>
      <p className={styles.hint}>
        Share of enabled sources currently meeting their configured cadence — a <strong>clean</strong> successful{' '}
        <span className={styles.mono}>source_check_run</span> within {SLA_CADENCE_GRACE}× its cadence. Target is{' '}
        ≥{SLA_CADENCE_TARGET_PCT}% on-cadence. A source between {SLA_CADENCE_GRACE}× and {STALE_CADENCE_GRACE}× its
        cadence shows here before it becomes a hard staleness alert (below); one inside {SLA_CADENCE_GRACE}× is
        on-cadence and appears on neither.
      </p>
      <p className={styles.hint}>
        <strong>&ldquo;Clean&rdquo; means the run raised no health verdict.</strong> A run that completed but reported{' '}
        <span className={styles.mono}>shape_drift</span>, <span className={styles.mono}>phone_rejection_spike</span> or
        any other alert no longer counts as a successful refresh, because it was not one. This changed on 2026-08-02
        (F-11): before then an alerting run counted as a success, so raising an alarm made this number go{' '}
        <em>up</em>. If the figure dropped when that shipped, the SLA did not get worse — the measurement stopped
        overstating it. Compare against the attention panel below, not against pre-2026-08-02 readings.
      </p>

      <div className={styles.tileRow}>
        <Tile
          label="Cadence adherence"
          value={formatPct(sla.adherencePct)}
          badge={slaBadge(sla)}
          sub={`${formatCount(sla.adherentCount)} of ${formatCount(sla.enabledCount)} enabled sources on-cadence`}
        />
        <Tile label="Enabled sources" value={formatCount(sla.enabledCount)} sub="terms reviewed & allowed" />
        <Tile
          label="On-cadence"
          value={formatCount(sla.adherentCount)}
          sub={`clean success within ${SLA_CADENCE_GRACE}\u00d7 their cadence`}
        />
        <Tile
          label="Lagging / non-adherent"
          value={formatCount(laggingCount)}
          badge={laggingCount === 0 ? { text: 'all fresh', variant: 'confirmed' } : { text: 'needs attention', variant: 'expected' }}
          sub={`past ${SLA_CADENCE_GRACE}\u00d7 their cadence, or never cleanly succeeded`}
        />
      </div>

      {sla.enabledCount === 0 ? (
        <p className={styles.empty}>
          No enabled sources yet — the registry seed leaves sources <span className={styles.mono}>pending</span> until an
          explicit terms decision enables them. The SLA fills in once sources go live.
        </p>
      ) : lagging.length === 0 ? (
        <p className={styles.okNote}>
          ✓ All {formatCount(sla.enabledCount)} enabled source(s) are on-cadence.
        </p>
      ) : (
        <>
          <h3 className={styles.subhead}>Off-cadence sources ({formatCount(lagging.length)})</h3>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Source</th>
                <th>Cadence</th>
                <th>Last successful check</th>
              </tr>
            </thead>
            <tbody>
              {lagging.map((s) => (
                <tr key={s.sourceId}>
                  <td>
                    <div className={styles.srcName}>{s.name}</div>
                    <div className={styles.srcFamily}>{s.family}</div>
                  </td>
                  <td className={styles.mono}>{formatCadence(s.cadenceSeconds)}</td>
                  <td>
                    <div>{formatAge(s.lastSuccessAt, nowMs)}</div>
                    <div className={`${styles.dim} ${styles.mono}`}>{formatTimestampUtc(s.lastSuccessAt)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
