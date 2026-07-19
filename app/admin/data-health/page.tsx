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
// ACCESS CONTROL: identical to /admin/dashboard — the TEMPORARY shared-secret gate
// (lib/admin/access.ts) via the `x-admin-token` header or `?token=` query param. An
// un-gated caller gets a 404 (the route's existence is not advertised). This is the
// same stopgap the ops dashboard uses until real role-based admin auth lands; do NOT
// weaken or fork it.
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ADMIN_TOKEN_HEADER,
  ADMIN_TOKEN_QUERY_PARAM,
  checkAdminDashboardAccess,
  resolvePresentedToken,
} from '@/lib/admin/access';
import { getDataHealthData } from '@/lib/admin/data-health';
import { formatTimestampUtc } from '@/lib/admin/format';
import { SlaTile } from './_components/SlaTile';
import { CoverageMatrix } from './_components/CoverageMatrix';
import { HealthAlertsPanel } from './_components/HealthAlertsPanel';
import { CorrectionsQueue } from './_components/CorrectionsQueue';
import styles from './_components/DataHealth.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.
export const metadata = { title: 'KIDS FUN — Admin / Data health', robots: { index: false, follow: false } };

export default async function AdminDataHealthPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // --- temporary access gate (identical to /admin/dashboard) ------------------
  const headerToken = headers().get(ADMIN_TOKEN_HEADER);
  const presented = resolvePresentedToken(headerToken, searchParams[ADMIN_TOKEN_QUERY_PARAM]);
  if (!checkAdminDashboardAccess(presented).ok) {
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
          ⚠️ Temporary access gate (shared secret). Real role-based admin auth replaces this once the account/session work
          lands.
        </p>
      </header>

      <div className={styles.sections}>
        <SlaTile sla={data.sla} nowMs={nowMs} />
        <CoverageMatrix coverage={data.coverage} />
        <HealthAlertsPanel alerts={data.alerts} nowMs={nowMs} />
        <CorrectionsQueue summary={data.correctionsSummary} corrections={data.corrections} nowMs={nowMs} />
      </div>

      <footer className={styles.foot}>
        Read-only data-health view · numbers are live from the database · no data is modified by this page.
      </footer>
    </main>
  );
}
