// app/admin/sms-subscribers/page.tsx — the SMS subscriber list (page 1 of the subscriber console).
//
// Jon's need, as scoped by the Operator: "see everything about a subscriber in one place." This is
// the index; the per-subscriber send history is a separate drill-down page.
//
// ACCESS CONTROL: the shared choke point app/admin/_lib/gate.ts resolveAdminAccess() — a
// signed-in admin session, no token path — identical to every other admin
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
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveAdminAccess } from '../_lib/gate';
import { canSeePersonalData } from '@/lib/db/admin-guard';
import { ADMIN_CONSOLE_CSS } from '../sources/_lib/console-css';
import { formatTimestampUtc } from '@/lib/admin/format';
import {
  getSmsSubscribers,
  summariseSubscribers,
  displayChildAges,
  displayPostalCode,
  REDACTED_TEXT,
  SMS_SUBSCRIBER_LIST_LIMIT,
} from '@/lib/admin/sms-subscribers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.
export const metadata = {
  title: 'KIDS FUN — Admin / SMS subscribers',
  robots: { index: false, follow: false },
};

export default async function AdminSmsSubscribersPage() {
  const grant = await resolveAdminAccess({ surface: 'admin_sms_subscribers' });
  if (!grant.ok) {
    notFound(); // 404 — do not reveal that this route exists to un-gated callers.
  }

  // A read-only 'viewer' gets the same rows with the personal columns NULLed in SQL.
  const rows = await getSmsSubscribers({ redactPersonalData: !canSeePersonalData(grant.admin.role) });
  const summary = summariseSubscribers(rows);
  // ONE clock for the whole table. Ages are derived from a birth year against "this year", so
  // taking the date per row would let a render that straddles midnight on December 31st print two
  // different ages for two children of the same age.
  const now = new Date();

  return (
    <main className="adm">
      <style dangerouslySetInnerHTML={{ __html: ADMIN_CONSOLE_CSS }} />
      <div className="adm-head">
        <h1>SMS subscribers</h1>
        <p className="adm-sub">
            Every consent record, newest first. Capped at {SMS_SUBSCRIBER_LIST_LIMIT}. Ages are
          computed from the stored birth year at today’s date, the same way the picker and the
          parent’s own preferences page compute them.
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
                <th>Postal</th>
                <th>Kids’ ages</th>
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
                  <td>
                    <Link href={`/admin/sms-subscribers/${row.id}`}>
                      {row.shortRef}
                    </Link>
                  </td>
                  <td>
                    {row.purged ? (
                      <span className="adm-hint">purged</span>
                    ) : row.redacted ? (
                      <span className="adm-hint">{REDACTED_TEXT}</span>
                    ) : (
                      row.phoneNumber
                    )}
                  </td>
                  {/* Postal code and ages resolve their own purged/absent/present tri-state in
                      lib/admin/sms-subscribers.ts, so a blank cell never has to stand for both
                      "erased on purpose" and "never given". */}
                  {[displayPostalCode(row), displayChildAges(row, now)].map((cell, i) => (
                    <td key={i}>
                      {cell.muted ? <span className="adm-hint">{cell.text}</span> : cell.text}
                    </td>
                  ))}
                  <td>
                    {row.status}
                    {/* MARKED, NOT FILTERED (Operator, 2026-09-03). This list is ground truth —
                        every row that exists, with the test ones labelled. Filtering them would
                        make the page silently disagree with the database. The engagement METRICS
                        surface takes the opposite default and excludes them, deliberately. */}
                    {row.isTest && <span className="adm-hint"> · test handset</span>}
                  </td>
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

      <p className="adm-foot">
        The reference number links to that subscriber’s full send history.
      </p>
    </main>
  );
}
