// app/admin/corrections/page.tsx — G-T34-7: correction-workflow resolve console.
//
// Closes the loop opened in Round 17 Task 27 (the parent-facing "Report wrong info"
// flow → correction_report). Admins view the open queue and RESOLVE a report, which in
// one transaction flips the report to 'resolved' AND updates the underlying occurrence's
// health (status_state) + confidence, and writes an admin_audit_log row.
//
// ACCESS (reuses app/admin/_lib/gate.ts, same posture as /admin/dashboard):
//   • VIEW  — a signed-in admin session (the only way in); un-gated → 404.
//   • WRITE — the same session, re-checked in the server action.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveAdminAccess } from '../_lib/gate';
import { listOpenCorrections, getStatusStateOptions } from './_lib/data';
import { CONFIDENCE_LABELS } from './_lib/vocab';
import { ResolveForm } from './_components/ResolveForm';
import { ADMIN_CONSOLE_CSS } from '../sources/_lib/console-css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = { title: 'KIDS FUN — Admin / Corrections', robots: { index: false, follow: false } };

function shortTime(iso: string | null): string {
  return iso ? iso.replace('T', ' ').replace(/\..+$/, ' UTC') : '—';
}

export default async function AdminCorrectionsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const grant = await resolveAdminAccess({ surface: 'admin_corrections' });
  if (!grant.ok) notFound();

  const canMutate = grant.via === 'session';
  const [corrections, statusOptions] = await Promise.all([listOpenCorrections(), getStatusStateOptions()]);
  const resolved = searchParams.flash === 'correction-resolved';

  return (
    <main className="adm">
      <style dangerouslySetInnerHTML={{ __html: ADMIN_CONSOLE_CSS }} />

      <header className="adm-head">
        <h1>KIDS FUN — Corrections</h1>
        <p className="adm-sub">Open correction reports · {corrections.length} awaiting triage</p>
        <nav className="adm-nav">
          <Link href="/admin/dashboard">Ops dashboard</Link>
          <Link href="/admin/data-health">Data health</Link>
          <Link href="/admin/sources">Sources</Link>
          <Link href="/admin/listings/new">+ Manual listing</Link>
        </nav>
        {canMutate ? (
          <p className="adm-note ok">
            ✏️ Signed in as an admin — resolving a report updates the listing&apos;s health state and is recorded in{' '}
            <span className="mono">admin_audit_log</span>.
          </p>
        ) : (
          <p className="adm-note">
            🔒 Read-only access. Your admin account cannot resolve reports — that needs an admin with write access.
          </p>
        )}
      </header>

      {resolved && (
        <p className="flash" role="status">
          ✓ Report resolved — listing health updated.
        </p>
      )}

      <section className="adm-section">
        <h2>Open queue</h2>
        <p className="adm-hint">
          Parent-submitted reports from the activity detail page (<span className="mono">/api/corrections</span>), oldest
          first. Resolving flips the report to <span className="mono">resolved</span> and updates the underlying
          occurrence&apos;s <span className="mono">status_state</span> + <span className="mono">confidence_label</span>.
        </p>
        {corrections.length === 0 ? (
          <p className="empty">🎉 No open corrections — the queue is clear.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Listing</th>
                <th>Issue</th>
                <th>Reporter note</th>
                <th>Current state</th>
                <th>Reported</th>
                {canMutate && <th>Resolve</th>}
              </tr>
            </thead>
            <tbody>
              {corrections.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="src-name">{c.activityName}</div>
                    <div className="src-family mono">{c.occurrenceId}</div>
                    {c.sourceUrl && (
                      <a className="mono" href={c.sourceUrl} target="_blank" rel="noreferrer noopener">
                        source ↗
                      </a>
                    )}
                  </td>
                  <td>
                    <span className="badge muted">{c.issueType}</span>{' '}
                    <span className={`badge ${c.status === 'in_review' ? 'info' : 'warn'}`}>{c.status}</span>
                  </td>
                  <td className="err-cell">{c.note ? <span>{c.note}</span> : <span className="dim">(no note)</span>}</td>
                  <td>
                    <div className="mono">{c.occStatusState}</div>
                    <div className="dim mono">conf: {c.occConfidenceLabel}</div>
                  </td>
                  <td className="mono dim">{shortTime(c.createdAt)}</td>
                  {canMutate && (
                    <td>
                      <details>
                        <summary className="edit-toggle">Resolve…</summary>
                        <ResolveForm
                          reportId={c.id}
                          currentStatusState={c.occStatusState}
                          currentConfidenceLabel={c.occConfidenceLabel}
                          statusOptions={statusOptions}
                          confidenceOptions={CONFIDENCE_LABELS}
                        />
                      </details>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer className="adm-foot">Internal admin console · resolutions are audited · {new Date().toISOString()}</footer>
    </main>
  );
}
