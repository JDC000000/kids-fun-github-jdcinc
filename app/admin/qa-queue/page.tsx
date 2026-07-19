// app/admin/qa-queue/page.tsx — G-T34-5: QA review queue console.
//
// Surfaces occurrences awaiting human judgement — the ingestion state machine's
// 'needs_review' (the activity_occurrence default) and 'manual_candidate' (a surfaced
// lead) states (status_state enum, 0002_enums.sql; Round-13 Task J ingestion framework).
// An admin CONFIRMS a record (→ status_state 'confirmed', it becomes trusted/visible) or
// REJECTS it (→ archived_at set, it drops out of every read model). Both actions flip the
// underlying row in one transaction with an admin_audit_log entry — not a UI-only label.
//
// ACCESS (reuses app/admin/_lib/gate.ts, same posture as /admin/sources):
//   • VIEW  — real admin session OR interim token; un-gated → 404.
//   • WRITE — session admins only (grant.via === 'session'); token viewers are read-only.
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ADMIN_TOKEN_HEADER, ADMIN_TOKEN_QUERY_PARAM } from '@/lib/admin/access';
import { resolveAdminAccess } from '../_lib/gate';
import { ADMIN_CONSOLE_CSS } from '../sources/_lib/console-css';
import { listReviewQueue } from './_lib/data';
import { REVIEW_STATES } from './_lib/vocab';
import { ReviewForm } from './_components/ReviewForm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = { title: 'KIDS FUN — Admin / QA Queue', robots: { index: false, follow: false } };

function shortTime(iso: string | null): string {
  return iso ? iso.replace('T', ' ').replace(/\..+$/, ' UTC') : '—';
}

const FLASH: Record<string, string> = {
  confirmed: '✓ Record confirmed — it is now trusted and visible.',
  rejected: '✓ Record rejected — archived and removed from every read model.',
};

export default async function AdminQaQueuePage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const grant = await resolveAdminAccess({
    surface: 'admin_qa_queue',
    headerToken: headers().get(ADMIN_TOKEN_HEADER),
    queryToken: searchParams[ADMIN_TOKEN_QUERY_PARAM],
  });
  if (!grant.ok) notFound();

  const canMutate = grant.via === 'session';
  const queue = await listReviewQueue();
  const flashKey = typeof searchParams.flash === 'string' ? searchParams.flash : '';
  const flash = FLASH[flashKey];

  return (
    <main className="adm">
      <style>{ADMIN_CONSOLE_CSS}</style>

      <header className="adm-head">
        <h1>KIDS FUN — QA Queue</h1>
        <p className="adm-sub">Records awaiting review · {queue.length} in queue</p>
        <nav className="adm-nav">
          <Link href="/admin/dashboard">Ops dashboard</Link>
          <Link href="/admin/data-health">Data health</Link>
          <Link href="/admin/sources">Sources</Link>
          <Link href="/admin/corrections">Corrections</Link>
          <Link href="/admin/taxonomy">Taxonomy</Link>
        </nav>
        {canMutate ? (
          <p className="adm-note ok">
            ✏️ Signed in as an admin — <strong>Confirm</strong> flips a record to{' '}
            <span className="mono">confirmed</span>; <strong>Reject</strong> archives it. Both are recorded in{' '}
            <span className="mono">admin_audit_log</span>.
          </p>
        ) : (
          <p className="adm-note">🔒 Read-only (interim token). Sign in as a seeded admin to review records.</p>
        )}
      </header>

      {flash && (
        <p className="flash" role="status">
          {flash}
        </p>
      )}

      <section className="adm-section">
        <h2>Review queue</h2>
        <p className="adm-hint">
          Occurrences in{' '}
          {REVIEW_STATES.map((s, i) => (
            <span key={s}>
              {i > 0 && ' / '}
              <span className="mono">{s}</span>
            </span>
          ))}{' '}
          state, oldest first. Confirming marks a record trusted; rejecting soft-deletes it (
          <span className="mono">archived_at</span>).
        </p>
        {queue.length === 0 ? (
          <p className="empty">🎉 Nothing awaiting review — the queue is clear.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Record</th>
                <th>State</th>
                <th>When</th>
                <th>Created</th>
                {canMutate && <th>Review</th>}
              </tr>
            </thead>
            <tbody>
              {queue.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="src-name">{r.activityName}</div>
                    <div className="src-family mono">{r.id}</div>
                    <div className="dim">
                      {r.seriesTitle} · {r.sourceName}
                    </div>
                    {r.sourceUrl && (
                      <a className="mono" href={r.sourceUrl} target="_blank" rel="noreferrer noopener">
                        source ↗
                      </a>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${r.statusState === 'manual_candidate' ? 'info' : 'warn'}`}>{r.statusState}</span>
                    <div className="dim mono">conf: {r.confidenceLabel}</div>
                  </td>
                  <td className="mono dim">{r.openHoursState ? r.openHoursState : shortTime(r.startDatetimeUtc)}</td>
                  <td className="mono dim">{shortTime(r.createdAt)}</td>
                  {canMutate && (
                    <td>
                      <details>
                        <summary className="edit-toggle">Review…</summary>
                        <ReviewForm occurrenceId={r.id} />
                      </details>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer className="adm-foot">Internal admin console · reviews are audited · {new Date().toISOString()}</footer>
    </main>
  );
}
