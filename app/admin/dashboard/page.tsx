// app/admin/dashboard/page.tsx — internal admin / health dashboard (M5, first slice).
//
// Read-only operational visibility into the platform's own health: ingestion state
// per enabled source (terms/robots status, last successful check, row counts) and
// basic analytics (event totals + breakdowns). NOT a parent-facing surface — it is
// deliberately plain, not brand-polished. All numbers are queried live from the
// same tables the worker and analytics writer populate.
//
// ACCESS CONTROL IS TEMPORARY: gated by a shared secret (ADMIN_DASHBOARD_TOKEN)
// presented via the `x-admin-token` header or `?token=` query param. This is a
// stopgap until real role-based admin auth (lib/db/admin-guard.ts) ships from the
// account/session stream — see lib/admin/access.ts. An unauthenticated/incorrect
// caller gets a 404 (the route's existence is not advertised).
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import {
  ADMIN_TOKEN_HEADER,
  ADMIN_TOKEN_QUERY_PARAM,
  checkAdminDashboardAccess,
  resolvePresentedToken,
} from '@/lib/admin/access';
import { getAdminDashboardData, type IngestionSourceHealth } from '@/lib/admin/dashboard';
import { formatAge, formatCount, formatDurationMs, formatTimestampUtc } from '@/lib/admin/format';

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
  // --- temporary access gate -------------------------------------------------
  const headerToken = headers().get(ADMIN_TOKEN_HEADER);
  const presented = resolvePresentedToken(headerToken, searchParams[ADMIN_TOKEN_QUERY_PARAM]);
  if (!checkAdminDashboardAccess(presented).ok) {
    notFound(); // 404 — do not reveal that this route exists to un-gated callers.
  }

  const data = await getAdminDashboardData();
  const nowMs = Date.parse(data.generatedAt);
  const { registry, ingestion, analytics } = data;
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
          ⚠️ Temporary access gate (shared secret). Real role-based admin auth replaces this once the account/session work lands.
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
        Read-only ops view · numbers are live from the staging database · no data is modified by this page.
      </footer>
    </main>
  );
}

const ADMIN_CSS = `
  .adm { max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px; color: #1a1a1a;
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  .adm-head h1 { font-size: 20px; margin: 0 0 4px; }
  .adm-sub { margin: 0; color: #555; }
  .adm-note { margin: 8px 0 0; padding: 8px 12px; background: #fff7e6; border: 1px solid #f0d9a8;
              border-radius: 6px; color: #6b4f00; font-size: 13px; }
  .adm-section { margin-top: 28px; }
  .adm-section h2 { font-size: 16px; margin: 0 0 6px; border-bottom: 2px solid #eee; padding-bottom: 6px; }
  .adm-section h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #666; margin: 18px 0 6px; }
  .adm-hint, .adm-foot { color: #666; font-size: 13px; }
  .adm-foot { margin-top: 40px; border-top: 1px solid #eee; padding-top: 12px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .tile { border: 1px solid #e5e5e5; border-radius: 8px; padding: 14px 16px; background: #fafafa; }
  .tile-value { font-size: 26px; font-weight: 700; line-height: 1.1; }
  .tile-label { color: #444; margin-top: 2px; }
  .tile-sub { color: #888; font-size: 12px; margin-top: 2px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; align-items: start; }
  table.grid { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.grid th, table.grid td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
  table.grid th { font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: #777; background: #f7f7f7; }
  table.grid td.num, table.grid th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .src-name { font-weight: 600; }
  .src-family { color: #999; font-size: 12px; }
  .dim { color: #888; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 12px; border: 1px solid; }
  .badge.ok { background: #e7f6ec; border-color: #b6e0c4; color: #1a7f3c; }
  .badge.warn { background: #fff4e0; border-color: #f0d199; color: #915c00; }
  .badge.bad { background: #fdeaea; border-color: #f2b8b8; color: #b3261e; }
  .badge.info { background: #e8f0fe; border-color: #b7ccf5; color: #1a56c4; }
  .badge.muted { background: #f0f0f0; border-color: #ddd; color: #666; }
  .empty { color: #888; font-style: italic; padding: 8px 0; }
  .bar { display: inline-block; height: 10px; background: #6c8cff; border-radius: 3px; min-width: 2px; }
  @media (max-width: 720px) { .cols { grid-template-columns: 1fr; } }
`;
