// app/admin/dashboard/page.tsx — internal admin / health dashboard (M5, first slice).
//
// Read-only operational visibility into the platform's own health: ingestion state
// per enabled source (terms/robots status, last successful check, row counts) and
// basic analytics (event totals + breakdowns). NOT a parent-facing surface — it is
// deliberately plain, not brand-polished. All numbers are queried live from the
// same tables the worker and analytics writer populate.
//
// ACCESS CONTROL (G-T34-1): the real role-based gate is now primary — a signed-in
// session whose user is an active admin_user row (lib/db/admin-guard.ts requireAdmin
// over lib/db/session-user.ts getRequestUser). The INTERIM shared-secret token
// (ADMIN_DASHBOARD_TOKEN via `x-admin-token` header or `?token=` query param) is
// retained ONLY as a coexistence fallback so wiring the real gate cannot lock out
// the current token holder before the first admin_user row is seeded. Both paths are
// composed in one place — app/admin/_lib/gate.ts resolveAdminAccess(). An
// unauthenticated/incorrect caller still gets a 404 (the route's existence is not
// advertised) — the same fail-closed posture as before.
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ADMIN_TOKEN_HEADER, ADMIN_TOKEN_QUERY_PARAM } from '@/lib/admin/access';
import { resolveAdminAccess } from '../_lib/gate';
import {
  getAdminDashboardData,
  STALE_CADENCE_GRACE,
  type IngestionSourceHealth,
  type RecentCorrection,
  type RecentFailure,
  type StaleSource,
} from '@/lib/admin/dashboard';
import { formatAge, formatCadence, formatCount, formatDurationMs, formatTimestampUtc } from '@/lib/admin/format';
import { getProductHealthKpis } from '@/lib/analytics/kpi';
import { KpiTiles } from './_components/KpiTiles';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.
export const metadata = { title: 'KIDS FUN — Admin / Health', robots: { index: false, follow: false } };

// Human labels for the region-chip ids stored on search_performed events (mirrors
// REGION_CHIPS in app/search/_lib/params.ts). Kept local so the admin data layer stays
// app-agnostic; falls back to the raw id if a new chip lands before this map updates.
const SEARCH_REGION_LABELS: Record<string, string> = {
  van: 'Vancouver',
  nvan: 'North Van',
  wvan: 'West Van',
  bby: 'Burnaby',
  rmd: 'Richmond',
};

function statusClass(status: string | null): string {
  switch (status) {
    case 'success':
      return 'ok';
    case 'partial':
      return 'warn';
    case 'failed':
      return 'bad';
    case 'running':
      return 'info';
    default:
      return 'muted';
  }
}

function IngestionRow({ s, nowMs }: { s: IngestionSourceHealth; nowMs: number }) {
  return (
    <tr>
      <td>
        <div className="src-name">{s.name}</div>
        <div className="src-family">{s.family}</div>
      </td>
      <td>
        <span className={`badge ${s.termsStatus === 'allowed' ? 'ok' : 'muted'}`}>terms: {s.termsStatus}</span>{' '}
        <span className={`badge ${s.robotsStatus === 'allowed' ? 'ok' : 'muted'}`}>robots: {s.robotsStatus}</span>
      </td>
      <td>
        <span className={`badge ${statusClass(s.latestRunStatus)}`}>{s.latestRunStatus ?? 'no runs'}</span>
        {s.latestRunRecordsFound != null && <span className="dim"> · {formatCount(s.latestRunRecordsFound)} rec</span>}
        {s.latestRunDurationMs != null && <span className="dim"> · {formatDurationMs(s.latestRunDurationMs)}</span>}
      </td>
      <td>
        <div>{formatAge(s.lastSuccessfulCheckAt, nowMs)}</div>
        <div className="dim mono">{formatTimestampUtc(s.lastSuccessfulCheckAt)}</div>
      </td>
      <td className="num">{formatCount(s.seriesCount)}</td>
      <td className="num">{formatCount(s.occurrenceCount)}</td>
    </tr>
  );
}

function StaleRow({ s, nowMs }: { s: StaleSource; nowMs: number }) {
  return (
    <tr>
      <td>
        <div className="src-name">{s.name}</div>
        <div className="src-family">{s.family}</div>
      </td>
      <td>
        <div>{formatAge(s.lastSuccessAt, nowMs)}</div>
        <div className="dim mono">{formatTimestampUtc(s.lastSuccessAt)}</div>
      </td>
      <td className="mono">{formatCadence(s.cadenceSeconds)}</td>
      <td>
        <span className={`badge ${statusClass(s.lastRunStatus)}`}>{s.lastRunStatus ?? 'no runs'}</span>
      </td>
    </tr>
  );
}

function FailureRow({ f, nowMs }: { f: RecentFailure; nowMs: number }) {
  return (
    <tr>
      <td>
        <div className="src-name">{f.sourceName}</div>
        <div className="src-family">{f.family}</div>
      </td>
      <td>
        <div>{formatAge(f.startedAt, nowMs)}</div>
        <div className="dim mono">{formatTimestampUtc(f.startedAt)}</div>
      </td>
      <td className="mono">{formatDurationMs(f.durationMs)}</td>
      <td className="err-cell">
        {f.errorSummary ? <span className="mono err-text">{f.errorSummary}</span> : <span className="dim">(no message)</span>}
        {f.errorCount != null && f.errorCount > 1 && <span className="dim"> · +{f.errorCount - 1} more</span>}
      </td>
    </tr>
  );
}

function CorrectionRow({ c, nowMs }: { c: RecentCorrection; nowMs: number }) {
  return (
    <tr>
      <td>
        <div className="src-name">{c.activityName ?? '(occurrence removed)'}</div>
        <div className="src-family mono">{c.occurrenceId}</div>
      </td>
      <td>
        <span className="badge muted">{c.issueType}</span>
      </td>
      <td className="err-cell">
        {c.note ? <span>{c.note}</span> : <span className="dim">(no note)</span>}
      </td>
      <td>
        <span className={`badge ${c.status === 'resolved' ? 'ok' : c.status === 'in_review' ? 'info' : 'warn'}`}>{c.status}</span>
      </td>
      <td>
        <div>{formatAge(c.createdAt, nowMs)}</div>
        <div className="dim mono">{formatTimestampUtc(c.createdAt)}</div>
      </td>
    </tr>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // --- admin access gate (G-T34-1): real session+role gate OR interim token ----
  const grant = await resolveAdminAccess({
    surface: 'admin_dashboard',
    headerToken: headers().get(ADMIN_TOKEN_HEADER),
    queryToken: searchParams[ADMIN_TOKEN_QUERY_PARAM],
  });
  if (!grant.ok) {
    notFound(); // 404 — do not reveal that this route exists to un-gated callers.
  }

  // Product-health KPIs (T32) are fetched alongside the existing ops payload; both
  // are independent read-only rollups, so run them concurrently.
  const [data, kpis] = await Promise.all([getAdminDashboardData(), getProductHealthKpis()]);
  const nowMs = Date.parse(data.generatedAt);
  const { registry, ingestion, analytics, alerts, corrections } = data;
  const allHealthy = alerts.staleSources.length === 0 && alerts.recentFailures.length === 0;
  const totalSeries = ingestion.reduce((sum, s) => sum + s.seriesCount, 0);
  const totalOccurrences = ingestion.reduce((sum, s) => sum + s.occurrenceCount, 0);
  const peakDay = analytics.last7Days.reduce((max, d) => Math.max(max, d.count), 0);

  return (
    <main className="adm">
      <style>{ADMIN_CSS}</style>

      <header className="adm-head">
        <h1>KIDS FUN — Admin / Health</h1>
        <p className="adm-sub">
          Internal operations view · read-only · generated <span className="mono">{formatTimestampUtc(data.generatedAt)}</span>
        </p>
        <p className="adm-note">
          🔒 Access gate: real role-based admin sign-in (session + admin role). The interim shared-secret token is
          retained only as a coexistence fallback until the first admin is seeded, then it will be retired.
        </p>
        <p className="adm-hint">
          Full data-health detail — source-freshness SLA, the region × activity-family coverage-or-gap board, and the
          corrections queue — lives on <Link href="/admin/data-health">/admin/data-health</Link>. The daily/monthly
          product-health review — every KPI as a trend rather than a snapshot — is on{' '}
          <Link href="/admin/operating">/admin/operating</Link> (protocol: <span className="mono">docs/kpi-cadence.md</span>).
        </p>
      </header>

      <section className="adm-section">
        <div className="tiles">
          <StatTile label="Enabled sources" value={formatCount(registry.enabledSources)} sub={`of ${formatCount(registry.totalSources)} registered`} />
          <StatTile label="Series" value={formatCount(totalSeries)} sub="from enabled sources" />
          <StatTile label="Occurrences" value={formatCount(totalOccurrences)} sub="non-archived" />
          <StatTile label="Analytics events" value={formatCount(analytics.totalEvents)} sub={`${formatCount(analytics.listingViewed)} listing views`} />
          <StatTile label="Searches" value={formatCount(analytics.searchPerformed)} sub="search_performed events" />
        </div>
      </section>

      <section className="adm-section">
        <h2>Product-health KPIs</h2>
        <p className="adm-hint">
          The launch product-health metrics (TSD §12.5), computed live from{' '}
          <span className="mono">analytics_event</span>. Tiles use the shared brand UI primitives. Metrics the current
          event data cannot support (e.g. relevance-graded search success) are intentionally omitted rather than faked;
          account-value tiles read 0 until their §9 events are wired by the owning streams. Target-vs-actual benchmarks
          and DAU/WAU/MAU trend charts live on <Link href="/admin/product-health">/admin/product-health</Link>.
        </p>
        <KpiTiles kpis={kpis} />
      </section>

      <section className="adm-section">
        <h2>Health alerts</h2>
        <p className="adm-hint">
          Operational problems only — enabled sources with a failed ingest run in the last{' '}
          {formatCount(alerts.windowDays)} day(s), or that haven&apos;t had a successful check within{' '}
          {STALE_CADENCE_GRACE}× their configured cadence. Derived live from{' '}
          <span className="mono">source_check_run</span>. Visibility only — no email/Slack alerting is wired (deferred;
          this surface is for a human watching the board).
        </p>
        {allHealthy ? (
          <p className="ok-note">
            ✓ All {formatCount(registry.enabledSources)} enabled source(s) healthy — no failed runs in the last{' '}
            {formatCount(alerts.windowDays)} day(s) and none stale.
          </p>
        ) : (
          <>
            {alerts.staleSources.length > 0 && (
              <>
                <h3>Stale sources ({formatCount(alerts.staleSources.length)})</h3>
                <p className="adm-hint">No successful check within {STALE_CADENCE_GRACE}× the source&apos;s cadence.</p>
                <table className="grid">
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
            {alerts.recentFailures.length > 0 && (
              <>
                <h3>Recent failed runs ({formatCount(alerts.recentFailures.length)})</h3>
                <p className="adm-hint">
                  Failed <span className="mono">source_check_run</span> rows from the last {formatCount(alerts.windowDays)}{' '}
                  day(s), newest first (max {formatCount(alerts.recentFailures.length)} shown).
                </p>
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>When</th>
                      <th>Duration</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alerts.recentFailures.map((f) => (
                      <FailureRow key={f.checkRunId} f={f} nowMs={nowMs} />
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </section>

      <section className="adm-section">
        <h2>Corrections reported</h2>
        <p className="adm-hint">
          Parent-submitted <span className="mono">Report wrong info</span> reports from the activity detail page, newest
          first (max {formatCount(corrections.length)} shown). Read-only visibility — triage (resolve/archive) is a later
          data-health slice. Captured into <span className="mono">correction_report</span> keyed to the occurrence and the
          anonymous session.
        </p>
        {corrections.length === 0 ? (
          <p className="empty">
            No corrections reported yet. The detail page&apos;s <span className="mono">Report wrong info</span> button POSTs to{' '}
            <span className="mono">/api/corrections</span>; this fills in as parents flag listings.
          </p>
        ) : (
          <table className="grid">
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
                <CorrectionRow key={c.id} c={c} nowMs={nowMs} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="adm-section">
        <h2>Ingestion health</h2>
        <p className="adm-hint">
          Showing the {formatCount(registry.enabledSources)} enabled source(s) (terms reviewed &amp; allowed).{' '}
          {registry.totalSources - registry.enabledSources} of {registry.totalSources} registered sources are still pending a
          terms/robots decision and are not ingesting yet.
        </p>
        {ingestion.length === 0 ? (
          <p className="empty">No enabled sources yet.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Source</th>
                <th>Compliance</th>
                <th>Latest run</th>
                <th>Last successful check</th>
                <th className="num">Series</th>
                <th className="num">Occurrences</th>
              </tr>
            </thead>
            <tbody>
              {ingestion.map((s) => (
                <IngestionRow key={s.sourceId} s={s} nowMs={nowMs} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="adm-section">
        <h2>Analytics</h2>
        {analytics.totalEvents === 0 ? (
          <p className="empty">
            No analytics events captured yet. Event capture is live (POST /api/analytics/event); this fills in as parents view
            listings.
          </p>
        ) : (
          <div className="cols">
            <div>
              <h3>Events by type</h3>
              <table className="grid">
                <thead>
                  <tr>
                    <th>Event type</th>
                    <th className="num">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.byType.map((r) => (
                    <tr key={r.eventType}>
                      <td className="mono">{r.eventType}</td>
                      <td className="num">{formatCount(r.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h3>Events · last 7 days</h3>
              {analytics.last7Days.length === 0 ? (
                <p className="empty">No events in the last 7 days.</p>
              ) : (
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Day (UTC)</th>
                      <th className="num">Count</th>
                      <th>Volume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.last7Days.map((d) => (
                      <tr key={d.day}>
                        <td className="mono">{d.day}</td>
                        <td className="num">{formatCount(d.count)}</td>
                        <td>
                          <span className="bar" style={{ width: `${peakDay ? Math.round((d.count / peakDay) * 100) : 0}%` }} aria-hidden="true" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div>
              <h3>Most-viewed listings</h3>
              {analytics.topListings.length === 0 ? (
                <p className="empty">No listing views yet.</p>
              ) : (
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Listing</th>
                      <th className="num">Views</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.topListings.map((r, i) => (
                      <tr key={`${r.occurrenceId ?? 'x'}-${i}`}>
                        <td>{r.label}</td>
                        <td className="num">{formatCount(r.views)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="adm-section">
        <h2>Search analytics</h2>
        <p className="adm-hint">
          What parents actually search for — query terms and filters from{' '}
          <span className="mono">search_performed</span> events fired by the /search page. The raw query text is
          captured (product signal); nothing identifying beyond the anonymous session id, and never the near-me
          location.
        </p>
        {analytics.searchPerformed === 0 ? (
          <p className="empty">
            No searches captured yet. The /search page fires a <span className="mono">search_performed</span> event
            whenever a real query or filter runs; this fills in as parents search.
          </p>
        ) : (
          <div className="cols">
            <div>
              <h3>Top query terms</h3>
              {analytics.topQueryTerms.length === 0 ? (
                <p className="empty">No query words yet — searches so far were filter-only.</p>
              ) : (
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Term</th>
                      <th className="num">Searches</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.topQueryTerms.map((r) => (
                      <tr key={r.term}>
                        <td className="mono">{r.term}</td>
                        <td className="num">{formatCount(r.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div>
              <h3>Region filters used</h3>
              {analytics.topSearchRegions.length === 0 ? (
                <p className="empty">No region filters used yet.</p>
              ) : (
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Region</th>
                      <th className="num">Searches</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.topSearchRegions.map((r) => (
                      <tr key={r.region}>
                        <td>{SEARCH_REGION_LABELS[r.region] ?? r.region}</td>
                        <td className="num">{formatCount(r.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <h3>Quick-filters used</h3>
              {analytics.topSearchFilters.length === 0 ? (
                <p className="empty">No quick-filters used yet.</p>
              ) : (
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Filter</th>
                      <th className="num">Searches</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.topSearchFilters.map((r) => (
                      <tr key={r.filter}>
                        <td className="mono">{r.filter}</td>
                        <td className="num">{formatCount(r.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </section>

      <footer className="adm-foot">
        Read-only ops view · numbers are live from the {process.env.NEXT_PUBLIC_APP_ENV ?? 'staging'} database ·
        no data is modified by this page.
      </footer>
    </main>
  );
}

// H2 a11y remediation — this block was authored in the M5 first slice, BEFORE the
// canonical --kf-* design tokens existed, so every colour was a raw hex. That caused
// two distinct WCAG 1.4.3 problems the H2 axe sweep caught (36 nodes light / 39 dark):
//
//  1. Several greys simply fail AA in LIGHT, independent of colour scheme:
//     #777 on #f7f7f7 = 4.18 (table headers), #888 on #fafafa = 3.39 (.tile-sub),
//     #888 on #fff = 3.54 (.empty), #999 on #fff = 2.84 (.src-family) — all < 4.5.
//  2. The block is entirely SCHEME-BLIND (hardcoded light surfaces, no dark rules),
//     while the KpiTiles CSS module nested inside it uses the FLIPPING ink roles. In
//     dark mode that put dark-mode ink (#9fb09d) on this block's hardcoded white —
//     light-on-light, which no amount of grey-darkening here would have fixed.
//
// Both are resolved by doing what the three newer admin surfaces already do: paint
// from the flipping role tokens. Light rendering stays essentially as designed (the
// role values ARE the tuned light greys); dark now inverts coherently instead of
// being a white page with dark-mode text on it. Layout/type/spacing are unchanged —
// this is a colour-token migration, not a redesign.
const ADMIN_CSS = `
  .adm { max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px;
         color: var(--kf-ink); background: var(--kf-canvas); min-height: 100vh; box-sizing: border-box;
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  .adm-head h1 { font-size: 20px; margin: 0 0 4px; }
  /* Cross-links to the other admin surfaces carried no colour rule at all, so they
     fell back to the UA default link blue #0000ee — 1.75:1 on the dark canvas (WCAG
     1.4.3). Scoped to .adm rather than the three flagged nodes so any link added to
     this page later inherits the accessible colour instead of re-introducing the bug.
     Underlined, so the link affordance never rests on colour alone (WCAG 1.4.1). */
  .adm a { color: var(--kf-info-text); text-decoration: underline; }
  .adm-sub { margin: 0; color: var(--kf-ink-secondary); }
  .adm-note { margin: 8px 0 0; padding: 8px 12px; background: var(--kf-expected-bg);
              border: 1px solid var(--kf-hairline);
              border-radius: 6px; color: var(--kf-expected-text); font-size: 13px; }
  .adm-section { margin-top: 28px; }
  .adm-section h2 { font-size: 16px; margin: 0 0 6px; border-bottom: 2px solid var(--kf-hairline); padding-bottom: 6px; }
  .adm-section h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--kf-ink-muted); margin: 18px 0 6px; }
  .adm-hint, .adm-foot { color: var(--kf-ink-secondary); font-size: 13px; }
  .adm-foot { margin-top: 40px; border-top: 1px solid var(--kf-hairline); padding-top: 12px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .tile { border: 1px solid var(--kf-hairline); border-radius: 8px; padding: 14px 16px; background: var(--kf-surface); }
  .tile-value { font-size: 26px; font-weight: 700; line-height: 1.1; }
  .tile-label { color: var(--kf-ink-secondary); margin-top: 2px; }
  .tile-sub { color: var(--kf-ink-muted); font-size: 12px; margin-top: 2px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; align-items: start; }
  table.grid { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.grid th, table.grid td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--kf-hairline); vertical-align: top; }
  table.grid th { font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: var(--kf-ink-secondary); background: var(--kf-surface-subtle); }
  table.grid td.num, table.grid th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .src-name { font-weight: 600; }
  .src-family { color: var(--kf-ink-muted); font-size: 12px; }
  .dim { color: var(--kf-ink-muted); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 12px; border: 1px solid var(--kf-hairline); }
  .badge.ok { background: var(--kf-confirmed-bg); color: var(--kf-confirmed-text); }
  .badge.warn { background: var(--kf-expected-bg); color: var(--kf-expected-text); }
  .badge.bad { background: var(--kf-cancelled-bg); color: var(--kf-cancelled-text); }
  .badge.info { background: var(--kf-info-bg); color: var(--kf-info-text); }
  .badge.muted { background: var(--kf-surface-subtle); color: var(--kf-ink-secondary); }
  .empty { color: var(--kf-ink-muted); font-style: italic; padding: 8px 0; }
  .ok-note { color: var(--kf-confirmed-text); background: var(--kf-confirmed-bg); border: 1px solid var(--kf-hairline); border-radius: 6px;
             padding: 8px 12px; margin: 6px 0 0; }
  .err-cell { max-width: 520px; }
  .err-text { color: var(--kf-cancelled-text); word-break: break-word; white-space: normal; }
  .bar { display: inline-block; height: 10px; background: var(--kf-chart-1); border-radius: 3px; min-width: 2px; }
  @media (max-width: 720px) { .cols { grid-template-columns: 1fr; } }
`;
