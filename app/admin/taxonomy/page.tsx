// app/admin/taxonomy/page.tsx — G-T34-4: no-code taxonomy console (regions / categories /
// aliases). The operator adds/edits regions, categories and query-time aliases WITHOUT a
// code deploy — the taxonomy equivalent of the Round-19 source registry.
//
// The alias section is the headline: editing an alias here applies at QUERY TIME
// immediately (lib/search/expand.ts never bakes alias text into listing vectors; the
// server action drops the alias-resolver cache — lib/search/postgres-alias-resolver.ts —
// so the very next live search reflects the change with no re-index and no restart).
//
// ACCESS (reuses app/admin/_lib/gate.ts, identical posture to /admin/sources):
//   • VIEW  — a real admin session OR the interim ADMIN_DASHBOARD_TOKEN (header/query).
//     Un-gated → 404 (route existence unadvertised).
//   • WRITE — session admins only (grant.via === 'session'). A token viewer sees a
//     read-only console; every write is re-checked in the action + recorded in
//     admin_audit_log (the audit FK needs a real admin id the token path can't provide).
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ADMIN_TOKEN_HEADER, ADMIN_TOKEN_QUERY_PARAM } from '@/lib/admin/access';
import { resolveAdminAccess } from '../_lib/gate';
import { ADMIN_CONSOLE_CSS } from '../sources/_lib/console-css';
import { listRegions, listCategories, listTags, listAliases } from './_lib/data';
import type { Option } from './_components/fields';
import { RegionForm } from './_components/RegionForm';
import { CategoryForm } from './_components/CategoryForm';
import { AliasForm } from './_components/AliasForm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = { title: 'KIDS FUN — Admin / Taxonomy', robots: { index: false, follow: false } };

const FLASH: Record<string, string> = {
  'region-created': '✓ Region created.',
  'region-updated': '✓ Region updated.',
  'category-created': '✓ Category created.',
  'category-updated': '✓ Category updated.',
  'alias-created': '✓ Alias created — live search reflects it immediately.',
  'alias-updated': '✓ Alias updated — live search reflects it immediately.',
  'alias-deleted': '✓ Alias deleted — removed from live search immediately.',
};

export default async function AdminTaxonomyPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const grant = await resolveAdminAccess({
    surface: 'admin_taxonomy',
    headerToken: headers().get(ADMIN_TOKEN_HEADER),
    queryToken: searchParams[ADMIN_TOKEN_QUERY_PARAM],
  });
  if (!grant.ok) notFound();

  const canMutate = grant.via === 'session';
  const [regions, categories, tags, aliases] = await Promise.all([
    listRegions(),
    listCategories(),
    listTags(),
    listAliases(),
  ]);

  const flashKey = typeof searchParams.flash === 'string' ? searchParams.flash : '';
  const flash = FLASH[flashKey];

  const parentOptions: Option[] = regions.map((r) => ({ value: r.id, label: `${r.name} (${r.level})` }));
  const targetOptions: Option[] = [
    ...categories.map((c) => ({ value: `category:${c.id}`, label: `Category · ${c.label} (${c.key})` })),
    ...tags.map((t) => ({ value: `tag:${t.id}`, label: `Tag · ${t.label} (${t.key})` })),
  ];

  return (
    <main className="adm">
      <style dangerouslySetInnerHTML={{ __html: ADMIN_CONSOLE_CSS }} />

      <header className="adm-head">
        <h1>KIDS FUN — Taxonomy</h1>
        <p className="adm-sub">
          No-code regions, categories &amp; query-time aliases · {regions.length} regions · {categories.length} categories ·{' '}
          {aliases.length} aliases
        </p>
        <nav className="adm-nav">
          <Link href="/admin/dashboard">Ops dashboard</Link>
          <Link href="/admin/data-health">Data health</Link>
          <Link href="/admin/sources">Sources</Link>
          <Link href="/admin/corrections">Corrections</Link>
          <Link href="/admin/qa-queue">QA queue</Link>
        </nav>
        {canMutate ? (
          <p className="adm-note ok">
            ✏️ Signed in as an admin — changes are recorded in <span className="mono">admin_audit_log</span>. Alias edits take
            effect at query time immediately (no re-index).
          </p>
        ) : (
          <p className="adm-note">
            🔒 Read-only (interim token). Sign in as a seeded admin to edit taxonomy — a change must be attributable in the
            audit log, which the token cannot satisfy.
          </p>
        )}
      </header>

      {flash && (
        <p className="flash" role="status">
          {flash}
        </p>
      )}

      {/* ── Regions ── */}
      <section className="adm-section">
        <h2>Regions</h2>
        <p className="adm-hint">
          The metro → municipality → sub_area hierarchy driving area chips. Edits reach live search immediately (region cache
          is dropped on save).
        </p>
        {canMutate && (
          <>
            <h3>Add a region</h3>
            <RegionForm mode="create" parentOptions={parentOptions} />
          </>
        )}
        {regions.length === 0 ? (
          <p className="empty">No regions yet.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Level</th>
                <th>Parent</th>
                {canMutate && <th>Edit</th>}
              </tr>
            </thead>
            <tbody>
              {regions.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="src-name">{r.name}</div>
                    <div className="src-family mono">{r.id}</div>
                  </td>
                  <td>
                    <span className="badge muted">{r.level}</span>
                  </td>
                  <td>{r.parentName ? r.parentName : <span className="dim">— top level —</span>}</td>
                  {canMutate && (
                    <td>
                      <details>
                        <summary className="edit-toggle">Edit</summary>
                        <RegionForm mode="edit" region={r} parentOptions={parentOptions.filter((o) => o.value !== r.id)} />
                      </details>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Categories ── */}
      <section className="adm-section">
        <h2>Categories</h2>
        <p className="adm-hint">
          The canonical category vocabulary. Live search matches on a category&apos;s <span className="mono">key</span>; aliases
          expand parent phrases to these keys.
        </p>
        {canMutate && (
          <>
            <h3>Add a category</h3>
            <CategoryForm mode="create" />
          </>
        )}
        {categories.length === 0 ? (
          <p className="empty">No categories yet.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Label</th>
                <th>Key</th>
                <th>Primary-eligible</th>
                {canMutate && <th>Edit</th>}
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="src-name">{c.label}</div>
                  </td>
                  <td className="mono">{c.key}</td>
                  <td>
                    <span className={`badge ${c.isPrimaryEligible ? 'ok' : 'muted'}`}>{c.isPrimaryEligible ? 'yes' : 'no'}</span>
                  </td>
                  {canMutate && (
                    <td>
                      <details>
                        <summary className="edit-toggle">Edit</summary>
                        <CategoryForm mode="edit" category={c} />
                      </details>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Aliases ── */}
      <section className="adm-section">
        <h2>Aliases (query-time synonyms)</h2>
        <p className="adm-hint">
          Parent-language phrases mapped to a canonical category or tag. Applied at query time only
          (<span className="mono">synonym_alias</span> → <span className="mono">lib/search/expand.ts</span>) — an edit here changes
          the very next search, no re-index.
        </p>
        {canMutate && (
          <>
            <h3>Add an alias</h3>
            <AliasForm mode="create" targetOptions={targetOptions} />
          </>
        )}
        {aliases.length === 0 ? (
          <p className="empty">No aliases yet.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Alias phrase</th>
                <th>Maps to</th>
                {canMutate && <th>Edit</th>}
              </tr>
            </thead>
            <tbody>
              {aliases.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div className="src-name">{a.aliasText}</div>
                  </td>
                  <td>
                    <span className={`badge ${a.targetKind === 'category' ? 'info' : 'muted'}`}>{a.targetKind}</span>{' '}
                    <span className="mono">{a.targetKey}</span>
                    <div className="dim">{a.targetLabel}</div>
                  </td>
                  {canMutate && (
                    <td>
                      <details>
                        <summary className="edit-toggle">Edit</summary>
                        <AliasForm mode="edit" alias={a} targetOptions={targetOptions} />
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
