// app/admin/listings/new/page.tsx — G-T34-3: manual-curation lane intake form.
//
// Hand-enter a listing that renders on /search + /preview/[id] exactly like an ingested
// one (see _lib/data.ts createManualListing). First real writer of a manually-curated
// activity_occurrence; every create is recorded in admin_audit_log.
//
// ACCESS (reuses app/admin/_lib/gate.ts): VIEW = session OR interim token (un-gated →
// 404); WRITE = session admins only (the form is shown only to a session admin; the
// action re-checks).
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ADMIN_TOKEN_HEADER, ADMIN_TOKEN_QUERY_PARAM } from '@/lib/admin/access';
import { resolveAdminAccess } from '../../_lib/gate';
import { listSourcesForSelect, getStatusStateOptions } from '../_lib/data';
import { CONFIDENCE_LABELS, COST_STATUSES } from '../_lib/vocab';
import { ManualListingForm } from '../_components/ManualListingForm';
import { ADMIN_CONSOLE_CSS } from '../../sources/_lib/console-css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = { title: 'KIDS FUN — Admin / New listing', robots: { index: false, follow: false } };

export default async function AdminNewListingPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const grant = await resolveAdminAccess({
    surface: 'admin_listings_new',
    headerToken: headers().get(ADMIN_TOKEN_HEADER),
    queryToken: searchParams[ADMIN_TOKEN_QUERY_PARAM],
  });
  if (!grant.ok) notFound();

  const canMutate = grant.via === 'session';
  const createdId =
    searchParams.flash === 'listing-created' && typeof searchParams.id === 'string' ? searchParams.id : null;

  const [sourceOptions, statusOptions] = canMutate
    ? await Promise.all([listSourcesForSelect(), getStatusStateOptions()])
    : [[], []];

  return (
    <main className="adm">
      <style dangerouslySetInnerHTML={{ __html: ADMIN_CONSOLE_CSS }} />

      <header className="adm-head">
        <h1>KIDS FUN — Manual listing</h1>
        <p className="adm-sub">Manual-curation lane · hand-enter a listing that renders on /search</p>
        <nav className="adm-nav">
          <Link href="/admin/dashboard">Ops dashboard</Link>
          <Link href="/admin/data-health">Data health</Link>
          <Link href="/admin/sources">Sources</Link>
          <Link href="/admin/corrections">Corrections</Link>
        </nav>
        {canMutate ? (
          <p className="adm-note ok">
            ✏️ Signed in as an admin — new listings are recorded in <span className="mono">admin_audit_log</span> and
            default to the <span className="mono">manual_candidate</span> (unverified) health state.
          </p>
        ) : (
          <p className="adm-note">🔒 Read-only (interim token). Sign in as a seeded admin to add a listing.</p>
        )}
      </header>

      {createdId && (
        <p className="flash" role="status">
          ✓ Listing created.{' '}
          <Link href={`/preview/${createdId}`}>View on /preview/{createdId.slice(0, 8)}…</Link> · <Link href="/search">open /search</Link>
        </p>
      )}

      {canMutate ? (
        <section className="adm-section">
          <h2>New listing</h2>
          <ManualListingForm
            sourceOptions={sourceOptions}
            statusOptions={statusOptions}
            confidenceOptions={CONFIDENCE_LABELS}
            costOptions={COST_STATUSES}
          />
        </section>
      ) : (
        <section className="adm-section">
          <p className="empty">Sign in as an admin to use the manual intake form.</p>
        </section>
      )}

      <footer className="adm-foot">Internal admin console · creations are audited · {new Date().toISOString()}</footer>
    </main>
  );
}
