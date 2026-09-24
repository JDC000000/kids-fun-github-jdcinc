// CorrectionsQueue.tsx — G-T33-4: report/corrections queue surface.
//
// The open-count / oldest-open AGGREGATE is the new data-health surface
// (getCorrectionsQueueSummary); the recent LIST is REUSED from the existing
// lib/admin/dashboard.ts read (getRecentCorrections) — not re-implemented.
import { Badge, Card } from '@/components/ui';
import { formatAge, formatCount, formatTimestampUtc } from '@/lib/admin/format';
import type { DisplayedCorrection } from '@/lib/admin/dashboard';
import type { CorrectionsQueueSummary } from '@/lib/admin/data-health';
import styles from './DataHealth.module.css';

const EM_DASH = '—';

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

function statusVariant(status: string): 'confirmed' | 'info' | 'expected' | 'neutral' {
  switch (status) {
    case 'resolved':
      return 'confirmed';
    case 'in_review':
      return 'info';
    case 'open':
      return 'expected';
    default:
      return 'neutral';
  }
}

export function CorrectionsQueue({
  summary,
  corrections,
  nowMs,
}: {
  summary: CorrectionsQueueSummary;
  corrections: DisplayedCorrection[];
  nowMs: number;
}) {
  return (
    <section className={styles.section} aria-label="Corrections queue">
      <h2 className={styles.sectionTitle}>Report / corrections queue</h2>
      <p className={styles.hint}>
        Parent-submitted <span className={styles.mono}>Report wrong info</span> reports (
        <span className={styles.mono}>correction_report</span>). The queue depth (open / oldest-open) is the surface an
        operator watches; the recent list below shows what&apos;s arriving. Triage (resolve/archive) is a later slice.
      </p>

      <div className={styles.tileRow}>
        <Tile
          label="Open reports"
          value={formatCount(summary.openCount)}
          badge={summary.openCount === 0 ? { text: 'queue clear', variant: 'confirmed' } : { text: 'awaiting triage', variant: 'expected' }}
          sub="status = open"
        />
        <Tile label="In review" value={formatCount(summary.inReviewCount)} sub="status = in_review" />
        <Tile label="Unresolved total" value={formatCount(summary.unresolvedCount)} sub="open + in_review (not archived)" />
        <Tile
          label="Oldest open"
          value={summary.oldestOpenAt ? formatAge(summary.oldestOpenAt, nowMs) : EM_DASH}
          sub={summary.oldestOpenAt ? formatTimestampUtc(summary.oldestOpenAt) : 'no open reports'}
        />
      </div>

      <h3 className={styles.subhead}>Recent reports ({formatCount(corrections.length)})</h3>
      {corrections.length === 0 ? (
        <p className={styles.empty}>
          No corrections reported yet. The detail page&apos;s <span className={styles.mono}>Report wrong info</span> button
          POSTs to <span className={styles.mono}>/api/corrections</span>; this fills in as parents flag listings.
        </p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Listing</th>
              <th>Issue</th>
              <th>Note</th>
              <th>Status</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {corrections.map((c) => (
              <tr key={c.id}>
                <td>
                  <div className={styles.srcName}>{c.activityName ?? '(occurrence removed)'}</div>
                  <div className={`${styles.srcFamily} ${styles.mono}`}>{c.occurrenceId}</div>
                </td>
                <td>
                  <Badge variant="neutral">{c.issueType}</Badge>
                </td>
                <td>
                  {c.note ? (
                    <span>{c.note}</span>
                  ) : c.redacted && c.hasNote ? (
                    <span className={styles.dim}>(note hidden — read-only role)</span>
                  ) : (
                    <span className={styles.dim}>(no note)</span>
                  )}
                </td>
                <td>
                  <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                </td>
                <td>
                  <div>{formatAge(c.createdAt, nowMs)}</div>
                  <div className={`${styles.dim} ${styles.mono}`}>{formatTimestampUtc(c.createdAt)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
