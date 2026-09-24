// app/admin/data-health/page.tsx — dedicated internal data-health dashboard (M5 / T33).
//
// The canonical /admin/data-health route. Read-only operational visibility into the
// DATA'S health (not just ingestion mechanics): the source-freshness SLA (G-T33-1),
// the region × activity-family coverage-or-gap board (G-T33-3, the G2 gate), the
// failed/stale-source alerts (G-T33-2, reused from the ops dashboard) and the
// report/corrections queue (G-T33-4). Deliberately plain — an internal ops surface,
// not a parent-facing page. Every number is queried live from the same tables the
// worker and correction API populate.
//
// ACCESS CONTROL (G-T34-1): identical to /admin/dashboard — a signed-in session whose
// user is an active admin_user row, the only way in (the shared-secret URL token was removed
// 2026-09-24), resolved in the shared choke
// point app/admin/_lib/gate.ts resolveAdminAccess(); do NOT weaken or fork it. An
// un-gated caller still gets a 404 (the route's existence is not advertised).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveAdminAccess } from '../_lib/gate';
import { getDataHealthData } from '@/lib/admin/data-health';
import { correctionsForDisplay } from '@/lib/admin/dashboard';
import { canSeePersonalData } from '@/lib/db/admin-guard';
import { formatTimestampUtc } from '@/lib/admin/format';
import { SlaTile } from './_components/SlaTile';
import { CoverageMatrix } from './_components/CoverageMatrix';
import { HealthAlertsPanel } from './_components/HealthAlertsPanel';
import { CorrectionsQueue } from './_components/CorrectionsQueue';
import styles from './_components/DataHealth.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.
export const metadata = { title: 'KIDS FUN — Admin / Data health', robots: { index: false, follow: false } };

export default async function AdminDataHealthPage() {
  // --- admin access gate (G-T34-1, identical to /admin/dashboard) --------------
  const grant = await resolveAdminAccess({ surface: 'admin_data_health' });
  if (!grant.ok) {
    notFound(); // 404 — do not reveal that this route exists to un-gated callers.
  }

  const data = await getDataHealthData();
  const nowMs = Date.parse(data.generatedAt);

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <Link href="/admin/dashboard" className={styles.backLink}>
          ← Ops dashboard
        </Link>
        <h1 className={styles.pageTitle}>KIDS FUN — Data health</h1>
        <p className={styles.sub}>
          Internal data-health view · read-only · generated{' '}
          <span className={styles.mono}>{formatTimestampUtc(data.generatedAt)}</span>
        </p>
        <p className={styles.note}>
          🔒 Access gate: a signed-in admin session (session + active admin role) is the only way in. There is no
          shared-secret or URL-token access.
        </p>
      </header>

      <div className={styles.sections}>
        <SlaTile sla={data.sla} nowMs={nowMs} />
        <CoverageMatrix coverage={data.coverage} />
        <HealthAlertsPanel alerts={data.alerts} nowMs={nowMs} />
        <CorrectionsQueue
          summary={data.correctionsSummary}
          corrections={correctionsForDisplay(data.corrections, {
            redactPersonalData: !canSeePersonalData(grant.admin.role),
          })}
          nowMs={nowMs}
        />
      </div>

      <footer className={styles.foot}>
        Read-only data-health view · numbers are live from the database · no data is modified by this page.
      </footer>
    </main>
  );
}
