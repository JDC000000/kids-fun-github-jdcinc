// app/admin/sms-subscribers/page.tsx — the SMS subscriber list (page 1 of the subscriber console).
//
// Jon's need, as scoped by the Operator: "see everything about a subscriber in one place." This is
// the index; the per-subscriber send history is a separate drill-down page.
//
// ACCESS CONTROL: the shared choke point app/admin/_lib/gate.ts resolveAdminAccess() — real
// session/role primary, interim shared-secret token fallback — identical to every other admin
// route. An un-gated caller gets a 404 and the route's existence is never advertised.
//
// ═══ THIS PAGE RENDERS REAL PHONE NUMBERS. WHAT KEEPS THEM OFF THE WIRE ═══
// It is a SERVER COMPONENT with no 'use client' anywhere in its tree, and it must stay one. The
// numbers are read, formatted and serialised to HTML on the server; no phone number is ever handed
// to a browser-side handler, so there is nothing for a client-side analytics or error-capture call
// to pick up. app/layout.tsx wires no global client analytics today, but this page must not depend
// on that staying true — being server-only is the guarantee that survives someone adding one.
// A test asserts the absence of 'use client' for exactly that reason.
//
// Nothing here puts a number in an error either: a failure on this page must be diagnosable from
// the subscriber id, because ids are safe to send to Sentry and numbers are not.
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { ADMIN_TOKEN_HEADER, ADMIN_TOKEN_QUERY_PARAM } from '@/lib/admin/access';
import { resolveAdminAccess } from '../_lib/gate';
import { ADMIN_CONSOLE_CSS } from '../sources/_lib/console-css';
import { formatTimestampUtc } from '@/lib/admin/format';
import {
  getSmsSubscribers,
  summariseSubscribers,
  SMS_SUBSCRIBER_LIST_LIMIT,
} from '@/lib/admin/sms-subscribers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.
export const metadata = {
  title: 'KIDS FUN — Admin / SMS subscribers',
  robots: { index: false, follow: false },
};

export default async function AdminSmsSubscribersPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const grant = await resolveAdminAccess({
    surface: 'admin_sms_subscribers',
    headerToken: headers().get(ADMIN_TOKEN_HEADER),
    queryToken: searchParams[ADMIN_TOKEN_QUERY_PARAM],
  });
  if (!grant.ok) {
    notFound(); // 404 — do not reveal that this route exists to un-gated callers.
  }

  const rows = await getSmsSubscribers();
  const summary = summariseSubscribers(rows);

  return (
    <main className="adm">
      <style dangerouslySetInnerHTML={{ __html: ADMIN_CONSOLE_CSS }} />
      <div className="adm-head">
        <h1>SMS subscribers</h1>
        <p className="adm-sub">
          Every consent record, newest first. Capped at {SMS_SUBSCRIBER_LIST_LIMIT}.
        </p>
      </div>

      <div className="adm-nav">
        <span>
          {summary.total} total · {summary.active} active · {summary.pending} pending ·{' '}
          {summary.paused} paused · {summary.stopped} stopped
        </span>
      </div>

      {summary.purged > 0 && (
        <p className="adm-note">
          {summary.purged} of these {summary.purged === 1 ? 'record has' : 'records have'} had their
          personal data erased by the 30-day post-stop retention purge. The consent record is kept
          deliberately; the phone number, postal code and ages are gone. That is the retention
          promise working, not missing data.
        </p>
      )}

      <div className="adm-section">
        {rows.length === 0 ? (
          <p className="adm-hint">No subscribers yet.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Ref</th>
                <th>Phone</th>
                <th>Status</th>
                <th>Method</th>
                <th>Consented</th>
                <th>Confirmed</th>
                <th>Empty wks</th>
                <th>Stopped</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.shortRef}</td>
                  <td>
                    {row.purged ? <span className="adm-hint">purged</span> : row.phoneNumber}
                  </td>
                  <td>{row.status}</td>
                  <td>{row.consentMethod}</td>
                  <td>{formatTimestampUtc(row.consentTimestamp)}</td>
                  <td>{formatTimestampUtc(row.confirmedTimestamp)}</td>
                  <td>{row.consecutiveEmptyWeeks}</td>
                  <td>{formatTimestampUtc(row.stoppedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* NO DRILL-DOWN LINK YET, DELIBERATELY. Page 2 (per-subscriber send history) is on hold
          pending the Operator's ruling on whether it shows subscriber_id-linked history only or
          also the phone_hash-keyed history that survives a purge. Linking to a route that does
          not exist would 404 an admin mid-task, and the link needs to carry ?token= forward
          anyway — see app/admin/operating/trends.tsx:234, which drops it and 404s a token-authed
          admin today. Both land together when the ruling arrives. */}
      <p className="adm-foot">
        Per-subscriber send history is a separate page, pending an audit-completeness ruling.
      </p>
    </main>
  );
}
