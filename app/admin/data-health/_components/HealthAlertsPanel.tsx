// HealthAlertsPanel.tsx — G-T33-2: failed + stale sources.
//
// This is REUSED wholesale from the existing lib/admin/dashboard.ts read layer
// (getHealthAlerts / isSourceStale) — the panel only re-presents that same payload
// on the dedicated data-health page. No ingestion-health logic is re-implemented here.
import { Badge } from '@/components/ui';
import { formatAge, formatCadence, formatCount, formatDurationMs, formatTimestampUtc } from '@/lib/admin/format';
import {
  ATTENTION_RUN_WINDOW_DAYS,
  STALE_CADENCE_GRACE,
  type HealthAlerts,
  type RunNeedingAttention,
  type StaleSource,
} from '@/lib/admin/dashboard';
import styles from './DataHealth.module.css';

function statusVariant(status: string | null): 'confirmed' | 'expected' | 'cancelled' | 'info' | 'neutral' {
  switch (status) {
    case 'success':
      return 'confirmed';
    case 'partial':
      return 'expected';
    case 'failed':
      return 'cancelled';
    case 'running':
      return 'info';
    default:
      return 'neutral';
  }
}

function StaleRow({ s, nowMs }: { s: StaleSource; nowMs: number }) {
  return (
    <tr>
      <td>
        <div className={styles.srcName}>{s.name}</div>
        <div className={styles.srcFamily}>{s.family}</div>
      </td>
      <td>
        <div>{formatAge(s.lastSuccessAt, nowMs)}</div>
        <div className={`${styles.dim} ${styles.mono}`}>{formatTimestampUtc(s.lastSuccessAt)}</div>
      </td>
      <td className={styles.mono}>{formatCadence(s.cadenceSeconds)}</td>
      <td>
        <Badge variant={statusVariant(s.lastRunStatus)}>{s.lastRunStatus ?? 'no runs'}</Badge>
      </td>
    </tr>
  );
}

function AttentionRow({ f, nowMs }: { f: RunNeedingAttention; nowMs: number }) {
  // An alert-only row's real message is the verdict, not the generic first-error string —
  // show the code as a badge so `shape_drift` vs `phone_rejection_spike` is scannable.
  const message = f.healthAlertDetail ?? f.errorSummary;
  return (
    <tr>
      <td>
        <div className={styles.srcName}>{f.sourceName}</div>
        <div className={styles.srcFamily}>{f.family}</div>
      </td>
      <td>
        <div>{formatAge(f.startedAt, nowMs)}</div>
        <div className={`${styles.dim} ${styles.mono}`}>{formatTimestampUtc(f.startedAt)}</div>
      </td>
      <td>
        <Badge variant={statusVariant(f.status)}>{f.status}</Badge>
        {f.healthAlertCode && (
          <>
            {' '}
            <Badge variant="cancelled">{f.healthAlertCode}</Badge>
          </>
        )}
      </td>
      <td className={styles.mono}>{formatDurationMs(f.durationMs)}</td>
      <td>
        {message ? (
          <span className={`${styles.mono} ${styles.errText}`}>{message}</span>
        ) : (
          <span className={styles.dim}>(no message)</span>
        )}
        {f.errorCount != null && f.errorCount > 1 && <span className={styles.dim}> · +{f.errorCount - 1} more</span>}
      </td>
    </tr>
  );
}

export function HealthAlertsPanel({ alerts, nowMs }: { alerts: HealthAlerts; nowMs: number }) {
  const allHealthy = alerts.staleSources.length === 0 && alerts.runsNeedingAttention.length === 0;

  return (
    <section className={styles.section} aria-label="Health alerts">
      <h2 className={styles.sectionTitle}>Runs needing attention &amp; stale sources</h2>
      <p className={styles.hint}>
        Real problems only — enabled sources whose ingest run in the last{' '}
        {formatCount(ATTENTION_RUN_WINDOW_DAYS)} day(s) either FAILED outright or raised a health verdict (
        <span className={styles.mono}>shape_drift</span>, <span className={styles.mono}>phone_rejection_spike</span>, …),
        or with no clean successful check within {STALE_CADENCE_GRACE}× their cadence. A verdict-raising run usually
        still ingests its records, so it shows as <span className={styles.mono}>partial</span> — that is exactly the
        case this panel used to miss. Derived live from <span className={styles.mono}>source_check_run</span> (reused
        from the ops dashboard). Visibility only — no email/Slack alerting is wired.
      </p>

      {allHealthy ? (
        <p className={styles.okNote}>✓ No failed or alerting runs, and no stale sources.</p>
      ) : (
        <>
          {alerts.staleSources.length > 0 && (
            <>
              <h3 className={styles.subhead}>Stale sources ({formatCount(alerts.staleSources.length)})</h3>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Last successful check</th>
                    <th>Cadence</th>
                    <th>Latest run</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.staleSources.map((s) => (
                    <StaleRow key={s.sourceId} s={s} nowMs={nowMs} />
                  ))}
                </tbody>
              </table>
            </>
          )}
          {alerts.runsNeedingAttention.length > 0 && (
            <>
              <h3 className={styles.subhead}>
                Runs needing attention ({formatCount(alerts.runsNeedingAttention.length)})
              </h3>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>When</th>
                    <th>Run / verdict</th>
                    <th>Duration</th>
                    <th>What happened</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.runsNeedingAttention.map((f) => (
                    <AttentionRow key={f.checkRunId} f={f} nowMs={nowMs} />
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </section>
  );
}
