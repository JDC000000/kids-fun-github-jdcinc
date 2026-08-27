import './preferences.css';
import {
  CARRIER_DISCLOSURES,
  SENDER_IDENTITY,
  SENDER_IDENTITY_LEAD,
  SUPPORT_LINE,
  SUPPORT_PHONE_HREF,
  PREFS_HEADING,
  PREFS_LAST_WEEK_EMPTY,
  PREFS_LAST_WEEK_HEADING,
  PREFS_LAST_WEEK_NONE,
  PREFS_PURGED,
  PREFS_STATUS_ACTIVE,
  PREFS_STATUS_PAUSED,
  PREFS_STATUS_PENDING,
  PREFS_STATUS_STOPPED,
  PREFS_UNKNOWN_TOKEN_BODY,
  PREFS_UNKNOWN_TOKEN_HEADING,
} from '@/lib/sms/consent-copy';
import { resolvePreferences, type PreferencesView } from '@/lib/sms/preferences';
import { PreferencesForm } from './_components/PreferencesForm';

// /u/[preferencesToken] — the no-login preferences / hub page (PRD §2.4), linked in the footer of
// every message. It is the CASL unsubscribe path and the PIPEDA access/correction mechanism at the
// same time, which is why it must render even when almost everything else has failed.
//
// ═══ THIS PAGE RENDERS PERSONAL DATA AND MUTATES CONSENT. ITS HEADERS ARE NOT BOILERPLATE.
//
// WHERE EACH ONE ACTUALLY COMES FROM — stated because an earlier version of this block described
// all three as though they were set here, and TWO OF THEM WERE NOT SET ANYWHERE AT ALL. A Server
// Component cannot set response headers the way a Route Handler can, so `no-store` and
// `no-referrer` are configured declaratively in next.config.mjs's `headers()`, matched on
// `/u/:preferencesToken`; only `noindex` is a meta tag and belongs to `metadata` below.
// tests/sms/preferences_headers.test.ts asserts all of it, and the round-17 notes record the
// check against a real `next start` response.
//
// `noindex, nofollow` — THE MOST IMPORTANT ONE. If a token URL ever reaches a crawler (a parent
//   pastes it into a public forum asking for help, a link shortener expands it, a browser
//   extension phones URLs home), an indexed copy of this page would put a child's ages and a
//   household postal code into a search engine. There is no undoing that. `noindex` is the
//   difference between a leaked link and a published one.
// `no-store` — the rendered HTML contains those same values. On a shared or family computer the
//   back button should not resurrect them.
// `no-referrer` — every outbound link on this page (an activity's own booking page) would
//   otherwise send the full URL, TOKEN INCLUDED, to that third party in the Referer header. This
//   single header is what stops a rec centre's analytics from receiving a working credential for
//   somebody's subscription.
//
// The remaining exposure is inherent to a no-login link in a text message and cannot be closed
// here: browser history, screenshots, forwarding, and access logs. CASL positively wants the
// unsubscribe to be this frictionless, so the tradeoff is the design rather than an oversight —
// but see §ah of the feasibility notes for the one part of it I am not comfortable leaving silent.
//
// NO FEATURE FLAG, same reasoning as the click-through route: the token IS the authorization, and
// a token that has never been minted cannot be guessed. What this page needs instead is that an
// unrecognised token can do nothing at all — which is what `resolvePreferences` guarantees by
// never throwing and by having exactly one failure outcome.

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your KIDS FUN texts',
  robots: { index: false, follow: false, nocache: true },
};

function statusLine(view: PreferencesView): string {
  if (view.purged) return PREFS_PURGED;
  switch (view.status) {
    case 'active':
      return PREFS_STATUS_ACTIVE;
    case 'paused':
      return PREFS_STATUS_PAUSED;
    case 'pending':
      return PREFS_STATUS_PENDING;
    case 'stopped':
      return PREFS_STATUS_STOPPED;
  }
}

/**
 * What last Friday produced.
 *
 * The empty and paused states get REAL SENTENCES rather than an absent panel, because they are
 * the states a subscriber most needs explained — a parent whose last text said "nothing this week"
 * arriving at a blank panel would reasonably read it as the site being broken too.
 */
function lastWeekLine(view: PreferencesView): string {
  switch (view.lastWeek.kind) {
    case 'weekly':
      return `${view.lastWeek.picks.length} ${view.lastWeek.picks.length === 1 ? 'pick' : 'picks'}.`;
    case 'empty_week':
      return PREFS_LAST_WEEK_EMPTY;
    case 'pause_notice':
      return PREFS_STATUS_PAUSED;
    default:
      return PREFS_LAST_WEEK_NONE;
  }
}

export default async function PreferencesPage({
  params,
}: {
  params: { preferencesToken: string };
}) {
  const resolution = await resolvePreferences(params.preferencesToken, new Date());

  // ONE FAILURE PAGE FOR EVERY REASON — never existed, deleted, mistyped, truncated by a
  // messaging app. Distinguishing them would tell a prober which guess was close, and would tell
  // anyone holding an old link whether that person is still a subscriber. The second is
  // information about somebody else.
  //
  // A rendered notice rather than notFound(), and this is the ONE place this branch deviates from
  // the click-through route's posture — deliberately. That route redirects a tap it cannot resolve
  // to /search, which is a fine answer for "go find something to do". This link's whole purpose is
  // to reach the unsubscribe and delete controls, so a bare 404 would leave someone trying to opt
  // out with nowhere to go. Saying "this link is not working, here is how to sign up again" is the
  // honest version. It is NOT a fix for the missing not-found experience the click-through round
  // flagged — that gap is Jon's/the Operator's (§8 Q3) and this does not pre-empt it.
  if (resolution.outcome !== 'found') {
    return (
      <main className="kf-prefs">
        <div className="kf-prefs__panel">
          <h1 className="kf-prefs__heading">{PREFS_UNKNOWN_TOKEN_HEADING}</h1>
          <p className="kf-prefs__intro">{PREFS_UNKNOWN_TOKEN_BODY}</p>
          <p className="kf-prefs__legal">
            <a href="/sms/signup">Sign up for weekly picks</a>
          </p>
        </div>
      </main>
    );
  }

  const { view } = resolution;

  return (
    <main className="kf-prefs">
      <div className="kf-prefs__panel">
        <h1 className="kf-prefs__heading">{PREFS_HEADING}</h1>
        <p className="kf-prefs__status" data-status={view.status}>
          {statusLine(view)}
        </p>

        <section className="kf-prefs__section">
          <h2 className="kf-prefs__subheading">{PREFS_LAST_WEEK_HEADING}</h2>
          <p className="kf-prefs__intro">{lastWeekLine(view)}</p>
          {view.lastWeek.kind === 'weekly' && view.lastWeek.picks.length > 0 && (
            <ol className="kf-prefs__picks">
              {view.lastWeek.picks.map((pick) => (
                // The hub's own links to the picks, minted in lib/sms/preferences.ts so this
                // component holds no reference of its own. Each goes through `/s/{token}?via=hub`,
                // which is what makes `sms_click_event.link_origin = 'hub'` (migration 0036)
                // writable at all — PRD §6's click-through metric splits on that column, and it
                // could never have shown a hub click while this linked to /activity directly.
                // It also means a pick whose activity has since been archived now reaches the
                // "activity unavailable" interstitial instead of a bare 404.
                // `attributed` is false only when no token could be minted; the link still works.
                <li key={pick.occurrenceId} data-attributed={pick.attributed}>
                  <a href={pick.href}>Pick {pick.rank}</a>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* A purged or stopped subscriber has nothing to edit, and offering the form would imply
            a subscription that no longer exists. The unsubscribe/delete controls stay available
            for a stopped-but-not-purged row, because "delete it now" is still a live request. */}
        <PreferencesForm
          token={params.preferencesToken}
          view={view}
          editable={!view.purged && view.status !== 'stopped'}
        />

        {/* ── CASL sender identification (§1.4), Jon-approved 2026-08-26. ──
            This block and the support line REPLACED a visible draft banner that stood here while
            the legal name, mailing address and support contact did not exist. They exist now.
            Shared from lib/sms/consent-copy.ts with the other surface that needs them, so the
            address can never be right in one place and stale in the other. */}
        <section className="kf-prefs__identity">
          <p className="kf-prefs__identity-lead">{SENDER_IDENTITY_LEAD}</p>
          <address className="kf-prefs__identity-block">
            {SENDER_IDENTITY.legalName}, operating as {SENDER_IDENTITY.operatingAs}
            <br />
            {SENDER_IDENTITY.mailingAddress}
            <br />
            {SENDER_IDENTITY.businessRegistration}
          </address>
          <p className="kf-prefs__identity-support">
            {SUPPORT_LINE.split(SENDER_IDENTITY.supportPhone)[0]}
            <a href={SUPPORT_PHONE_HREF}>{SENDER_IDENTITY.supportPhone}</a>
            {SUPPORT_LINE.split(SENDER_IDENTITY.supportPhone)[1]}
          </p>
        </section>

        <ul className="kf-prefs__disclosures">
          {CARRIER_DISCLOSURES.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <p className="kf-prefs__legal">
          <a href="/privacy">Privacy Policy</a>
          {' · '}
          <a href="/terms">Terms of Service</a>
        </p>
      </div>
    </main>
  );
}
