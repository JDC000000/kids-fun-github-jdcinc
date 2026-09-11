// app/coverage-status/page.tsx — PUBLIC coverage/status page (roadmap initiative 7), at
// `/coverage-status` rather than the more obvious `/coverage`: this repo's .gitignore has a
// blanket `coverage/` rule for test-coverage report output (Istanbul/vitest), which silently
// swallows ANY directory named exactly `coverage` at any depth — app/coverage/, lib/coverage/,
// tests/coverage/ would all have been invisible to git. Renaming avoids touching the ignore
// rule (and any risk of it someday un-ignoring a real coverage-report artifact) — see
// lib/coverage-status.ts, the sibling rename.
//
// "Which cities does KIDS FUN actually cover, and when did we last check?" — a small, honest
// trust surface for a parent (or a source we're courting) to see coverage at a glance, deliberately
// separate from /admin/data-health's operator-facing region × family × network gap matrix (which
// stays gated — see app/admin/_lib/gate.ts). This page reads ONE new, small, purpose-built query
// (lib/coverage-status.ts) — it does not reuse or expose the admin coverage matrix itself, only
// the same underlying gate/health SQL constants so "connected" and "last crawl" mean the same
// thing here as they do on the internal dashboard.
//
// No access gate: this is intentionally a PUBLIC route, unlike everything under app/admin/.
// The page's CSS is a stylesheet, not a JSX text child of a style element: React escapes a text
// child, and the HTML parser treats that element as raw text — so one apostrophe in a CSS
// comment made the server and client text disagree and broke hydration on every load.
import './coverage-status.css';
import { getCoverageStatus, type CoverageStatus } from '@/lib/coverage-status';
import { formatAge, formatCount, formatTimestampUtc } from '@/lib/admin/format';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.
export const metadata = { title: 'KIDS FUN — Coverage & status' };

/**
 * Best-effort, never load-bearing: a genuine DB outage degrades to an honest "couldn't load"
 * message rather than the framework's generic 500 — this is a PUBLIC page (unlike
 * /admin/dashboard, which has no such guard and is fine crashing behind its own auth gate),
 * so a stranger's first impression of it should not be a stack trace. Mirrors the same
 * posture app/search/page.tsx's resolveSavedOrigin already uses for a non-critical read.
 */
async function loadStatus(nowMs: number): Promise<{ status: CoverageStatus } | { error: string }> {
  try {
    return { status: await getCoverageStatus(nowMs) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export default async function CoveragePage() {
  const nowMs = Date.now();
  const result = await loadStatus(nowMs);

  if ('error' in result) {
    return (
      <div className="kf-cov">
        <header className="kf-cov__head">
          <h1>Coverage &amp; status</h1>
        </header>
        <p className="kf-cov__empty" role="alert">
          We couldn&apos;t load coverage data just now. Nothing is faked to fill this page — try
          again in a moment.
        </p>
      </div>
    );
  }
  const { status } = result;

  return (
    <div className="kf-cov">
      <header className="kf-cov__head">
        <h1>Coverage &amp; status</h1>
        {/* The "nothing scraped … no invented events" half was the home page's first trust
            card. It was MERGED into this existing sentence rather than added as a second
            paragraph: the sentence already made the permission claim, so a separate card
            restating it here would have been the same duplication this page is replacing. */}
        <p className="kf-cov__sub">
          Where KIDS FUN is actively connected, and when each area was last checked. We only ever
          show activities from sources with confirmed permission to be listed — nothing scraped
          from behind a login, and no invented events. This page is about coverage, not content.
        </p>
      </header>

      <section className="kf-cov__tiles">
        <div className="kf-cov__tile">
          <div className="kf-cov__tile-value">{formatCount(status.totalConnectedSources)}</div>
          <div className="kf-cov__tile-label">Connected sources, across all areas</div>
        </div>
        <div className="kf-cov__tile">
          <div className="kf-cov__tile-value">{status.regions.filter((r) => r.connectedSources > 0).length}</div>
          <div className="kf-cov__tile-label">Areas with at least one connected source</div>
        </div>
      </section>

      <section className="kf-cov__section">
        <h2>By area</h2>
        <table className="kf-cov__table">
          <thead>
            <tr>
              <th scope="col">Area</th>
              <th scope="col" className="kf-cov__num">
                Connected sources
              </th>
              <th scope="col">Last checked</th>
            </tr>
          </thead>
          <tbody>
            {status.regions.map((r) => (
              <tr key={r.region.key}>
                <th scope="row">{r.region.label}</th>
                <td className="kf-cov__num">{formatCount(r.connectedSources)}</td>
                <td>
                  {r.lastCrawlAt ? (
                    <>
                      {formatAge(r.lastCrawlAt, nowMs)}{' '}
                      <span className="kf-cov__dim">({formatTimestampUtc(r.lastCrawlAt)})</span>
                    </>
                  ) : (
                    <span className="kf-cov__dim">No successful check yet</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {status.regions.every((r) => r.connectedSources === 0) && (
          <p className="kf-cov__empty">
            No areas have a connected source yet — an honest zero, not a loading state.
          </p>
        )}
      </section>

      <p className="kf-cov__foot">
        Generated {formatTimestampUtc(status.generatedAt)}. &quot;Connected&quot; means a source
        has confirmed permission to be listed (terms review passed); a paused or under-review
        source does not count here even if it has contributed activities in the past.
      </p>
    </div>
  );
}
