// app/admin/sms-subscribers/[id]/page.tsx — one subscriber's full send history (page 2).
//
// Reached only by drilling down from /admin/sms-subscribers. Same gate, same 404-on-refusal
// posture, same Server-Component-only rule as page 1 — see that file's header for why the last of
// those is a PII guarantee rather than a style preference.
//
// ═══ NO LOOKUP BY NUMBER, AND NO phone_hash ON SCREEN ═══
// SMS_PHONE_HASH_SALT is one global salt, and phone numbers are a small keyspace, so a displayed
// hash is guess-and-checkable by anyone who can read this page. The hash is used inside the query
// in lib/admin/sms-subscribers.ts and never leaves it: no field rendered here contains it, there
// is no search box, and there is no route that takes a number. An admin arrives here from a row
// they already had.
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ADMIN_TOKEN_HEADER, ADMIN_TOKEN_QUERY_PARAM } from '@/lib/admin/access';
import { resolveAdminAccess } from '../../_lib/gate';
import { ADMIN_CONSOLE_CSS } from '../../sources/_lib/console-css';
import { formatTimestampUtc } from '@/lib/admin/format';
import { adminHref } from '../_lib/href';
import { getSmsSubscriberDetail, SMS_SEND_HISTORY_LIMIT } from '@/lib/admin/sms-subscribers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = {
  title: 'KIDS FUN — Admin / SMS subscriber',
  robots: { index: false, follow: false },
};

export default async function AdminSmsSubscriberDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const grant = await resolveAdminAccess({
    surface: 'admin_sms_subscriber_detail',
    headerToken: headers().get(ADMIN_TOKEN_HEADER),
    queryToken: searchParams[ADMIN_TOKEN_QUERY_PARAM],
  });
  if (!grant.ok) {
    notFound();
  }

  const detail = await getSmsSubscriberDetail(params.id);
  if (!detail) {
    notFound(); // an id that is not a subscriber gets the same 404 as an un-gated caller
  }

  const { subscriber, sends, purged } = detail;
  const carriedOver = sends.filter((s) => !s.linkedToThisRow).length;

  return (
    <main className="adm">
      <style dangerouslySetInnerHTML={{ __html: ADMIN_CONSOLE_CSS }} />
      <div className="adm-head">
        <h1>Subscriber {subscriber.shortRef}</h1>
        <p className="adm-sub">
          {purged ? 'personal data erased' : subscriber.phoneNumber} · {subscriber.status} ·{' '}
          consented {formatTimestampUtc(subscriber.consentTimestamp)}
        </p>
      </div>

      <div className="adm-nav">
        <Link href={adminHref('/admin/sms-subscribers', searchParams)}>← All subscribers</Link>
      </div>

      {purged && (
        <p className="adm-note">
          This subscriber’s personal data has been deleted. The history below is the anonymized
          send record only.
        </p>
      )}

      {carriedOver > 0 && (
        <p className="adm-note">
          {carriedOver} of these {carriedOver === 1 ? 'row is' : 'rows are'} not attached to this
          consent record. They were sent to the same phone number under an earlier signup, and are
          shown because the question this page answers is what happened to this person, not what
          happened to this row.
        </p>
      )}

      <div className="adm-section">
        <h2>Send history</h2>
        {sends.length === 0 ? (
          <p className="adm-hint">Nothing has been sent to this subscriber.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Sent</th>
                <th>Type</th>
                <th>Outcome</th>
                <th>Delivery</th>
                <th>Twilio SID</th>
                <th>This record</th>
              </tr>
            </thead>
            <tbody>
              {sends.map((s) => (
                <tr key={s.id}>
                  <td>{formatTimestampUtc(s.createdAt)}</td>
                  <td>{s.sendType}</td>
                  <td>{s.outcome}</td>
                  <td>{s.deliveryStatus ?? '—'}</td>
                  <td>{s.twilioSid ?? '—'}</td>
                  <td>{s.linkedToThisRow ? 'yes' : 'earlier signup'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="adm-hint">Capped at {SMS_SEND_HISTORY_LIMIT} rows.</p>
      </div>
    </main>
  );
}
