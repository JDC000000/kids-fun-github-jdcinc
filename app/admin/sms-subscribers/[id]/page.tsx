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
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveAdminAccess } from '../../_lib/gate';
import { canSeePersonalData } from '@/lib/db/admin-guard';
import { ADMIN_CONSOLE_CSS } from '../../sources/_lib/console-css';
import { formatTimestampUtc } from '@/lib/admin/format';
import {
  getSmsSubscriberDetail,
  displayChildAges,
  displayPostalCode,
  REDACTED_TEXT,
  SMS_SEND_HISTORY_LIMIT,
} from '@/lib/admin/sms-subscribers';
import {
  ineligibilityReason,
  previewWeeklySmsForSubscriber,
  splitPreviewLinks,
  type SmsPreviewResult,
} from '@/lib/admin/sms-preview';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = {
  title: 'KIDS FUN — Admin / SMS subscriber',
  robots: { index: false, follow: false },
};

/** Next hands a repeated query param over as an array; take the first value. */
function firstParam(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export default async function AdminSmsSubscriberDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const grant = await resolveAdminAccess({ surface: 'admin_sms_subscriber_detail' });
  if (!grant.ok) {
    notFound();
  }

  // A read-only 'viewer' gets the personal columns NULLed in SQL, and no SMS preview (below).
  const redact = !canSeePersonalData(grant.admin.role);
  const detail = await getSmsSubscriberDetail(params.id, { redactPersonalData: redact });
  if (!detail) {
    notFound(); // an id that is not a subscriber gets the same 404 as an un-gated caller
  }

  const { subscriber, sends, purged } = detail;
  const carriedOver = sends.filter((s) => !s.linkedToThisRow).length;

  // ONE clock for the whole render: the ages shown, the eligibility reason's 4-day resend window
  // and the preview's own selection must all be answered as of the same instant, or the page can
  // explain a message with a different week's numbers.
  const now = new Date();
  const postal = displayPostalCode(subscriber);
  const ages = displayChildAges(subscriber, now);

  // ON DEMAND. The preview loads the whole search catalogue to build one message, so it runs only
  // when an admin actually asks — never on the plain drill-down.
  //
  // REFUSED for a viewer: the message is built from the subscriber's postal code and children's
  // ages, so its picks and area label are personal data by inference — and it loads the whole
  // catalogue. The refusal is decided here, before any preview work, not by hiding the link.
  const previewRequested = firstParam(searchParams.preview) === '1';
  const previewRefused = previewRequested && redact;
  let preview: SmsPreviewResult | null = null;
  if (previewRequested && !previewRefused) {
    preview = await previewWeeklySmsForSubscriber(subscriber.id, now);
    if (preview.status === 'not_eligible') {
      // The module cannot see the consent row; this page can, so it supplies the specific reason.
      preview = { status: 'not_eligible', reason: ineligibilityReason(subscriber, sends, now) };
    }
  }

  return (
    <main className="adm">
      <style dangerouslySetInnerHTML={{ __html: ADMIN_CONSOLE_CSS }} />
      <div className="adm-head">
        <h1>Subscriber {subscriber.shortRef}</h1>
        <p className="adm-sub">
          {purged ? 'personal data erased' : redact ? REDACTED_TEXT : subscriber.phoneNumber} ·{' '}
          {subscriber.status} ·{' '}
          consented {formatTimestampUtc(subscriber.consentTimestamp)}
        </p>
      </div>

      <div className="adm-nav">
        <Link href="/admin/sms-subscribers">← All subscribers</Link>
        {/* The preview, one click from the top of the page (Jon, 2026-09-24). Not offered to a
            read-only role, which is refused the preview server-side anyway (see below). */}
        {!redact && (
          <>
            {' · '}
            <Link href={`/admin/sms-subscribers/${subscriber.id}?preview=1#this-weeks-sms`}>
              Preview this Friday’s text →
            </Link>
          </>
        )}
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
        <h2>Household</h2>
        <table className="grid">
          <tbody>
            <tr>
              <th>Postal code</th>
              <td>{postal.muted ? <span className="adm-hint">{postal.text}</span> : postal.text}</td>
            </tr>
            <tr>
              <th>Kids’ ages</th>
              <td>
                {ages.muted ? <span className="adm-hint">{ages.text}</span> : ages.text}
                {/* The stored value, beside the derived one. We hold a birth YEAR and never a
                    month, so the age is right only for a child who has already had this year's
                    birthday — showing the year an admin can see what the imprecision is built on
                    instead of having to trust the arithmetic. */}
                {!purged && subscriber.birthYears && subscriber.birthYears.length > 0 && (
                  <span className="adm-hint"> · born {subscriber.birthYears.join(', ')}</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="adm-hint">
          Ages are computed from the stored birth year at today’s date — the same helper the picker
          and the parent’s own preferences page use, so all three agree.
        </p>
      </div>

      <div className="adm-section">
        <h2 id="this-weeks-sms">This week’s SMS</h2>
        {redact && (
          <p className="adm-note">
            The SMS preview is not available to a read-only role: the message is built from this
            subscriber’s postal code and children’s ages, so it would reveal them.
          </p>
        )}

        {!previewRequested && !redact && (
          <p>
            <Link
              href={`/admin/sms-subscribers/${subscriber.id}?preview=1`}
            >
              Preview this Friday’s text →
            </Link>
            <br />
            <span className="adm-hint">
              Builds the exact message this subscriber would receive on Friday, using the real
              weekly job’s own selection and rendering. Read-only: it sends nothing, marks nothing
              as sent and changes no counter.
            </span>
          </p>
        )}

        {preview?.status === 'secret_missing' && (
          <p className="adm-note">
            Cannot preview: SMS_SHORT_LINK_SECRET is not configured in this environment. Every
            activity link in the message would be minted against a placeholder, and those links do
            not 404 — they fail their signature check and land on /link-unavailable, which tells
            the reader their link is broken. A preview that looks like a broken product is worse
            than none, so this refuses rather than rendering one.
          </p>
        )}

        {preview?.status === 'not_eligible' && (
          <p className="adm-note">
            This subscriber is not in this week’s send set: {preview.reason}. Nothing would be sent
            to them on Friday.
          </p>
        )}

        {preview?.status === 'no_message' && (
          <p className="adm-note">
            The weekly job would build no message for this subscriber (outcome:{' '}
            {preview.outcome}). For <code>geocode_failed</code> that means their postal code
            resolves to no covered municipality — staying silent is the intended behaviour, not a
            fault.
          </p>
        )}

        {preview?.status === 'ok' && (
          <>
            <p className="adm-hint">
              outcome {preview.outcome} · {preview.pickCount}{' '}
              {preview.pickCount === 1 ? 'pick' : 'picks'} · area{' '}
              {preview.areaLabel ?? '—'} · {preview.segments}{' '}
              {preview.segments === 1 ? 'segment' : 'segments'} · {preview.characters} characters
            </p>
            {/* pre-wrap: an SMS body is whitespace-significant — its line breaks ARE the layout
                the parent sees, and collapsing them would misrepresent the message. */}
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                padding: '0.75rem',
                border: '1px solid currentColor',
                borderRadius: '4px',
                fontFamily: 'inherit',
              }}
            >
              {/* Only preview-tagged /s/ links become anchors (splitPreviewLinks): opening one goes
                  to the real activity and is NOT counted as this parent's click. */}
              {splitPreviewLinks(preview.body).map((part, i) =>
                part.href ? (
                  <a key={i} href={part.href} target="_blank" rel="noreferrer noopener">
                    {part.text}
                  </a>
                ) : (
                  <span key={i}>{part.text}</span>
                )
              )}
            </pre>
            {preview.tokenRedacted && (
              <p className="adm-hint">
                The ###… above is this subscriber’s live preferences token, masked. That URL opens
                their preferences hub — their child’s ages and household postal code — with no
                sign-in, so it is a credential rather than copy and is not put on screen where a
                screenshot would carry it past this gate. The segment and character counts above
                are measured on the real, unmasked body. Every activity link is real.
              </p>
            )}
            <p className="adm-hint">
              Nothing was sent and nothing was recorded — building this message touches no
              subscriber state. The activity links open the real listing; each carries{' '}
              <code>?via=preview</code> (not part of the text that is sent), so opening one from here
              is not counted as this parent’s click and adds no page view.
            </p>
          </>
        )}
      </div>

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
