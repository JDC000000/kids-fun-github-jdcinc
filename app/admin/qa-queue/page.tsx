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
import { Fragment } from 'react';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ADMIN_TOKEN_HEADER, ADMIN_TOKEN_QUERY_PARAM } from '@/lib/admin/access';
import { resolveAdminAccess } from '../_lib/gate';
import { ADMIN_CONSOLE_CSS } from '../sources/_lib/console-css';
import { listReviewQueue, type ReviewItem, type DedupPairing } from './_lib/data';
import { REVIEW_STATES } from './_lib/vocab';
import { ReviewForm } from './_components/ReviewForm';
import { DedupReviewForm } from './_components/DedupReviewForm';

// Local styles for the dedup side-by-side panel (G-T34-6) — kept here rather than in the
// shared console-css so the other consoles are untouched (reuse, don't fork).
const DEDUP_CSS = `
  .dedup-row > td { background: #fbfcff; }
  .dedup-why { margin: 2px 0 8px; color: #555; font-size: 13px; }
  .dedup-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 8px 0 4px; }
  .dedup-col { border: 1px solid #e3e8f2; border-radius: 8px; padding: 10px 12px; background: #fff; }
  .dedup-col h4 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: #666; }
  .dedup-col.keep { border-color: #b6e0c4; background: #f4fbf6; }
  .dedup-col .line { margin: 2px 0; }
  @media (max-width: 720px) { .dedup-compare { grid-template-columns: 1fr; } }
`;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = { title: 'KIDS FUN — Admin / QA Queue', robots: { index: false, follow: false } };

function shortTime(iso: string | null): string {
  return iso ? iso.replace('T', ' ').replace(/\..+$/, ' UTC') : '—';
}

const FLASH: Record<string, string> = {
  confirmed: '✓ Record confirmed — it is now trusted and visible.',
  rejected: '✓ Record rejected — archived and removed from every read model.',
  merged: '✓ Merge confirmed — the duplicate was merged into the canonical (provenance preserved) and archived.',
  kept_separate: '✓ Kept separate — the records were confirmed as distinct; both remain live.',
};

function shortTimeOrHours(startIso: string | null, openHours: string | null): string {
  return openHours ? openHours : startIso ? startIso.replace('T', ' ').replace(/\..+$/, ' UTC') : '—';
}

/** Side-by-side comparison of a flagged duplicate vs its suspected canonical (G-T34-6). */
function DedupCompare({ item, dedup }: { item: ReviewItem; dedup: DedupPairing }) {
  const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);
  return (
    <>
      <p className="dedup-why">
        Flagged as a possible cross-source duplicate by the nightly adjudicator
        {dedup.reason ? (
          <>
            {' '}— <em>{dedup.reason}</em>
          </>
        ) : null}
        . <span className="mono">title similarity {pct(dedup.deterministicScore)}</span> ·{' '}
        <span className="mono">model confidence {pct(dedup.llmConfidence)}</span>
      </p>
      <div className="dedup-compare">
        <div className="dedup-col">
          <h4>This record — candidate duplicate (archived on merge)</h4>
          <div className="line src-name">{item.activityName}</div>
          <div className="line dim">
            {item.seriesTitle} · {item.sourceName}
          </div>
          <div className="line mono dim">{shortTimeOrHours(item.startDatetimeUtc, item.openHoursState)}</div>
          <div className="line mono dim">conf: {item.confidenceLabel}</div>
          <div className="line mono dim">{item.id}</div>
          {item.sourceUrl && (
            <a className="line mono" href={item.sourceUrl} target="_blank" rel="noreferrer noopener">
              source ↗
            </a>
          )}
        </div>
        <div className="dedup-col keep">
          <h4>Suspected canonical — kept &amp; enriched</h4>
          <div className="line src-name">{dedup.canonicalName ?? '(unavailable)'}</div>
          <div className="line dim">
            {dedup.canonicalSeriesTitle ?? '—'} · {dedup.canonicalSourceName ?? '—'}
          </div>
          <div className="line mono dim">
            {shortTimeOrHours(dedup.canonicalStartDatetimeUtc, dedup.canonicalOpenHoursState)}
          </div>
          <div className="line mono dim">conf: {dedup.canonicalConfidenceLabel ?? '—'}</div>
          <div className="line mono dim">{dedup.canonicalId}</div>
          {dedup.canonicalSourceUrl && (
            <a className="line mono" href={dedup.canonicalSourceUrl} target="_blank" rel="noreferrer noopener">
              source ↗
            </a>
          )}
        </div>
      </div>
    </>
  );
}

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
      <style>{DEDUP_CSS}</style>

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
              {queue.map((r) => {
                const isDedup = Boolean(r.dedup);
                const mergeable = canMutate && r.dedup?.canonicalAvailable === true;
                const colSpan = canMutate ? 5 : 4;
                return (
                  <Fragment key={r.id}>
                    <tr>
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
                        {isDedup && (
                          <div>
                            <span className="badge muted">possible duplicate</span>
                          </div>
                        )}
                        <div className="dim mono">conf: {r.confidenceLabel}</div>
                      </td>
                      <td className="mono dim">{r.openHoursState ? r.openHoursState : shortTime(r.startDatetimeUtc)}</td>
                      <td className="mono dim">{shortTime(r.createdAt)}</td>
                      {canMutate && (
                        <td>
                          {mergeable ? (
                            <span className="dim">⇔ dedup review below</span>
                          ) : (
                            <details>
                              <summary className="edit-toggle">Review…</summary>
                              {isDedup && (
                                <p className="dedup-why">
                                  Flagged as a possible duplicate, but the suspected canonical is no longer available —
                                  review as a standalone record.
                                </p>
                              )}
                              <ReviewForm occurrenceId={r.id} />
                            </details>
                          )}
                        </td>
                      )}
                    </tr>
                    {mergeable && r.dedup && (
                      <tr className="dedup-row">
                        <td colSpan={colSpan}>
                          <details>
                            <summary className="edit-toggle">⇔ Dedup review — compare &amp; decide…</summary>
                            <DedupCompare item={r} dedup={r.dedup} />
                            <DedupReviewForm duplicateId={r.id} canonicalId={r.dedup.canonicalId} />
                          </details>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <footer className="adm-foot">Internal admin console · reviews are audited · {new Date().toISOString()}</footer>
    </main>
  );
}
