import './activity-unavailable.css';
import {
  ACTIVITY_GONE_BODY,
  ACTIVITY_GONE_HEADING,
  ACTIVITY_GONE_ONWARD,
  SENDER_IDENTITY,
  SUPPORT_PHONE_HREF,
} from '@/lib/sms/consent-copy';

// /activity-unavailable — where a tapped weekly link goes when the token verified but the activity
// has since been archived (PRD §8 Q3, Jon-approved 2026-08-26).
//
// Round 6 built `occurrence_gone` as a distinct outcome from `invalid_token` and sent BOTH to
// /search, because no such page existed and inventing one was a copy decision rather than an
// implementation one. Jon has now written the copy, so the outcome finally has somewhere of its
// own to go — and the two-outcome split from round 6 is what made wiring it a one-line change.
//
// ── WHY THIS IS A PAGE AND NOT A GENERIC 404 ────────────────────────────────────────────
// A parent tapping "Sat: Story Time (VPL Renfrew)" for a cancelled session and landing on a bare
// 404 concludes the product is broken. Landing on /search with no explanation concludes the same
// thing more slowly. This says what happened, in Jon's own words, and offers the one useful next
// step.
//
// NOT INDEXED. It is reachable only by redirect from a link in a text message; there is nothing
// here for a crawler and a search result pointing at it would be a dead end for whoever clicked.
//
// NO STATE, NO TOKEN, NO IDENTIFIERS. The redirect deliberately carries nothing — no occurrence
// id, no short_ref, no query string at all. See lib/sms/click-through.ts's `GONE_DESTINATION` for
// why: this page's URL ends up in browser history, and it must not say WHICH activity was gone
// for WHOM.

export const dynamic = 'force-static';

export const metadata = {
  title: 'That activity is no longer listed — KIDS FUN',
  robots: { index: false, follow: false },
};

export default function ActivityUnavailablePage() {
  return (
    <main className="kf-gone">
      <div className="kf-gone__panel">
        <h1 className="kf-gone__heading">{ACTIVITY_GONE_HEADING}</h1>

        {/* Jon's wording, verbatim. The one piece of consumer copy on this branch written by the
            product owner rather than drafted and approved — do not smooth it. */}
        <p className="kf-gone__body">{ACTIVITY_GONE_BODY}</p>

        {/* "Let us know if you have any other questions" needs somewhere to be let known. Same
            support contact as every other surface, from the same constant. */}
        <p className="kf-gone__support">
          <a href={SUPPORT_PHONE_HREF}>Text {SENDER_IDENTITY.supportPhone}</a>
        </p>

        <p className="kf-gone__onward">
          <a href="/search">{ACTIVITY_GONE_ONWARD}</a>
        </p>
      </div>
    </main>
  );
}
