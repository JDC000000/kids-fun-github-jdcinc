// app/admin/sms-engagement/page.tsx — per-subscriber engagement, for REAL subscribers only.
//
// Jon: "I only want to track real usage as connected to a telephone number and events that those
// people take." This is that surface. It is deliberately NOT /admin/operating, whose twelve
// metrics measure anonymous web usage — a different question, and one whose denominator is
// overwhelmingly machine traffic.
//
// ACCESS CONTROL: the shared choke point resolveAdminAccess(), same as every other admin route.
// Un-gated callers get a 404 and the route's existence is never advertised.
//
// SERVER COMPONENT, and must stay one. It renders no phone numbers at all — short_ref identifies a
// subscriber and the FSA is as far as location goes — but the read model it calls sits next to
// code that does handle numbers, and 'use client' anywhere in this tree would start shipping this
// data to a browser. A test asserts the absence.
//
// ═══ IT WILL LOOK EMPTY, AND THAT IS THE HONEST RENDERING ═══
// There is currently ONE real subscriber. A dashboard that pads that into something resembling a
// populated product would be lying about the state of the world; the empty state below says how
// many real subscribers exist and stops there. When the numbers are real they will fill this in.
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { ADMIN_TOKEN_HEADER, ADMIN_TOKEN_QUERY_PARAM } from '@/lib/admin/access';
import { resolveAdminAccess } from '../_lib/gate';
import { ADMIN_CONSOLE_CSS } from '../sources/_lib/console-css';
import { formatTimestampUtc } from '@/lib/admin/format';
import { getSmsEngagement } from '@/lib/admin/sms-engagement';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.
export const metadata = {
  title: 'KIDS FUN — Admin / SMS engagement',
  robots: { index: false, follow: false },
};

/** A rate, or an em dash. Never "0%" for "we have never offered this person anything". */
function rate(pct: number | null): string {
  return pct === null ? '—' : `${pct}%`;
}

export default async function AdminSmsEngagementPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const grant = await resolveAdminAccess({
    surface: 'admin_sms_engagement',
    headerToken: headers().get(ADMIN_TOKEN_HEADER),
    queryToken: searchParams[ADMIN_TOKEN_QUERY_PARAM],
  });
  if (!grant.ok) {
    notFound();
  }

  // The toggle is opt-in and off by default: a metric that silently counts a test handset is a
  // metric nobody can trust. `?includeTest=1` is for QA, and the page says so when it is on.
  const includeTest = searchParams.includeTest === '1';
  const { rows, summary } = await getSmsEngagement({ includeTest });

  return (
    <main className="adm">
      <style dangerouslySetInnerHTML={{ __html: ADMIN_CONSOLE_CSS }} />
      <div className="adm-head">
        <h1>SMS engagement</h1>
        <p className="adm-sub">
          What we sent each phone-verified subscriber, and what they tapped. Anonymous web activity
          is not counted here — it cannot be attributed to a subscriber.
        </p>
      </div>

      <div className="adm-nav">
        <span>
          {summary.subscribers} subscriber{summary.subscribers === 1 ? '' : 's'} ·{' '}
          {summary.sends} send{summary.sends === 1 ? '' : 's'} · {summary.picksOffered} picks
          offered · {summary.taps} tap{summary.taps === 1 ? '' : 's'} · {rate(summary.tapRatePct)}{' '}
          tap rate
        </span>
      </div>

      {includeTest && (
        <p className="adm-hint">
          Showing test handsets as well as real subscribers. These numbers are not the product&apos;s
          real engagement.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="adm-hint">
          No real subscribers yet. Nothing to measure — this page fills in as people sign up.
        </p>
      ) : (
        // `grid`, not `adm-table`. ADM-TABLE IS DEFINED NOWHERE — console-css.ts styles only
        // `.grid`, which every other admin table uses — so this table shipped completely
        // unstyled. Same failure as the `.adm-badge` class I caught before shipping on the
        // subscriber list: a plausible class name that no stylesheet defines looks correct in
        // the diff and renders as bare markup.
        <table className="grid">
          <thead>
            <tr>
              <th>Subscriber</th>
              <th>Area</th>
              <th>Status</th>
              <th>Sends</th>
              <th>Delivered</th>
              <th>Failed</th>
              <th>Picks offered</th>
              <th>Taps</th>
              <th>Direct / hub</th>
              <th>Tap rate</th>
              <th>Last send</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.subscriberId}>
                <td>
                  {row.shortRef}
                  {row.isTest && <span className="adm-hint"> · test handset</span>}
                </td>
                <td>{row.fsa ?? <span className="adm-hint">purged</span>}</td>
                <td>{row.status}</td>
                <td>{row.sends}</td>
                <td>{row.delivered}</td>
                <td>{row.failed}</td>
                <td>{row.picksOffered}</td>
                <td>{row.taps}</td>
                <td>
                  {row.directTaps} / {row.hubTaps}
                </td>
                <td>{rate(row.tapRatePct)}</td>
                <td>{formatTimestampUtc(row.lastSendAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="adm-hint">
        Tap rate is taps divided by picks offered, so it is per-activity rather than per-message. A
        subscriber sent ten picks who taps one reads as 10%, not 100%.
      </p>
    </main>
  );
}
