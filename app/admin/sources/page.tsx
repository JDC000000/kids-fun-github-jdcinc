// app/admin/sources/page.tsx — G-T34-3: no-code source registry console.
//
// The first admin MUTATION surface (T34 Phase 2). Admins add/edit ingestion `source`
// rows — cadence tier, terms/robots status, authority tier — without a code deploy.
// Cross-reference the compliance reasoning for each source in docs/source-register.md
// before promoting terms_status to allowed/summarise_only.
//
// ACCESS (reuses app/admin/_lib/gate.ts, identical posture to /admin/dashboard):
//   • VIEW — a real admin session OR the interim ADMIN_DASHBOARD_TOKEN (header/query).
//     Un-gated → 404 (route existence unadvertised).
//   • WRITE — session admins only (grant.via === 'session'). A token viewer sees a
//     read-only console; every write is re-checked in saveSourceAction and recorded in
//     admin_audit_log (the audit FK needs a real admin id the token path can't provide).
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ADMIN_TOKEN_HEADER, ADMIN_TOKEN_QUERY_PARAM } from '@/lib/admin/access';
import { resolveAdminAccess } from '../_lib/gate';
import { listSources } from './_lib/data';
import { SourceForm } from './_components/SourceForm';
import { ADMIN_CONSOLE_CSS } from './_lib/console-css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = { title: 'KIDS FUN — Admin / Sources', robots: { index: false, follow: false } };

const FLASH: Record<string, string> = {
  'source-created': '✓ Source created.',
  'source-updated': '✓ Source updated.',
};

export default async function AdminSourcesPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const grant = await resolveAdminAccess({
    surface: 'admin_sources',
    headerToken: headers().get(ADMIN_TOKEN_HEADER),
    queryToken: searchParams[ADMIN_TOKEN_QUERY_PARAM],
  });
  if (!grant.ok) notFound();

  const canMutate = grant.via === 'session';
  const sources = await listSources();
  const flashKey = typeof searchParams.flash === 'string' ? searchParams.flash : '';
  const flash = FLASH[flashKey];

  return (
    <main className="adm">
      <style>{ADMIN_CONSOLE_CSS}</style>

      <header className="adm-head">
        <h1>KIDS FUN — Sources</h1>
        <p className="adm-sub">No-code ingestion source registry · {sources.length} registered</p>
        <nav className="adm-nav">
          <Link href="/admin/dashboard">Ops dashboard</Link>
          <Link href="/admin/data-health">Data health</Link>
          <Link href="/admin/corrections">Corrections</Link>
          <Link href="/admin/listings/new">+ Manual listing</Link>
        </nav>
        {canMutate ? (
          <p className="adm-note ok">
            ✏️ Signed in as an admin — changes are recorded in <span className="mono">admin_audit_log</span>. Cross-check
            terms status against <span className="mono">docs/source-register.md</span> before enabling a source.
          </p>
        ) : (
          <p className="adm-note">
            🔒 Read-only (interim token). Sign in as a seeded admin to add or edit sources — a change must be attributable
            in the audit log, which the token cannot satisfy.
          </p>
        )}
      </header>

      {flash && (
        <p className="flash" role="status">
          {flash}
        </p>
      )}

      {canMutate && (
        <section className="adm-section">
          <h2>Add a source</h2>
          <SourceForm mode="create" />
        </section>
      )}

      <section className="adm-section">
        <h2>Registered sources</h2>
        {sources.length === 0 ? (
          <p className="empty">No sources registered yet.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Source</th>
                <th>Tier / method</th>
                <th>Terms</th>
                <th>Robots</th>
                <th>Cadence</th>
                <th>Health</th>
                {canMutate && <th>Edit</th>}
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div className="src-name">{s.name}</div>
                    <div className="src-family mono">{s.family}</div>
                  </td>
                  <td>
                    <span className="badge muted">{s.authorityTier}</span>{' '}
                    <span className="badge muted">{s.ingestionMethod}</span>
                  </td>
                  <td>
                    <span className={`badge ${s.termsStatus === 'allowed' || s.termsStatus === 'summarise_only' ? 'ok' : s.termsStatus === 'pending' ? 'warn' : 'bad'}`}>
                      {s.termsStatus}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${s.robotsStatus === 'allowed' ? 'ok' : s.robotsStatus === 'pending' ? 'warn' : 'muted'}`}>
                      {s.robotsStatus}
                    </span>
                    {/* F-5: without this, a source cleared by an unreadable-robots.txt override
                        renders as a muted `unknown` — visually identical to a source nobody has
                        ever checked, while the scheduler is actively fetching it. The badge is
                        what makes 'unknown' + a named decision readable as what it is. */}
                    {s.robotsOverrideDecision && (
                      <>
                        {' '}
                        <span className="badge warn" title={s.robotsOverrideNote ?? undefined}>
                          override: {s.robotsOverrideDecision}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="mono">
                    {s.baselineCadence}
                    {s.nearDateCadence && <span className="dim"> / {s.nearDateCadence}</span>}
                  </td>
                  <td>
                    <span className="badge muted">{s.healthState}</span>
                  </td>
                  {canMutate && (
                    <td>
                      <details>
                        <summary className="edit-toggle">Edit</summary>
                        <SourceForm mode="edit" source={s} />
                      </details>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer className="adm-foot">Internal admin console · writes are audited · {new Date().toISOString()}</footer>
    </main>
  );
}
