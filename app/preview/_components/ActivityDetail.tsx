import Link from 'next/link';
import { FreshnessStamp } from './FreshnessStamp';
import { ReportWrongInfo } from './ReportWrongInfo';
import type { Activity } from '../_data/types';
import {
  ageGuide,
  bookingTag,
  confidenceSentence,
  formatAges,
  formatChecked,
  formatCost,
  formatDistance,
  formatDistanceValue,
  formatWhen,
  practicalFacts,
  statusMeta,
  telHref,
  isAgeNoteRestatement,
  isInternalAgeMarker,
  formatVenueAddress,
  addressRepeatsVenueName,
} from '../_data/format';

// Activity detail / source page body (Screen 3) — everything to decide and to trust,
// with source provenance foregrounded. Shared, unchanged markup rendered by BOTH the
// canonical /activity/[id] route and the interim /preview/[id] demo shell; the only
// route-specific bit is the back link (backHref/backLabel), so neither surface
// regresses visually. Presentation only — data loading + analytics stay in the route.

/* Ties the front-desk caveat to the call link via aria-describedby, so a screen-reader
   user who lands on the link hears the "not this session" qualifier with it rather than
   only on the next read. The caveat is the whole reason the number could ship at all. */
const PHONE_NOTE_ID = 'kf-phone-note';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="kf-stat">
      <div className="kf-stat__label">{label}</div>
      <div className="kf-stat__value">{value}</div>
    </div>
  );
}

export interface ActivityDetailProps {
  activity: Activity;
  /** The occurrence id, threaded to "Report wrong info" for the corrections keying. */
  occurrenceId: string;
  /** Where the back link points (e.g. "/search" for canonical, "/preview" for the shell). */
  backHref: string;
  /** Back link copy (e.g. "← Back to results"). */
  backLabel: string;
}

export function ActivityDetail({ activity, occurrenceId, backHref, backLabel }: ActivityDetailProps) {
  const when = formatWhen(activity.startIso, activity.endIso, activity.openHoursLabel);
  const meta = statusMeta(activity.status, activity.seasonLabel);
  const isBookable = activity.status === 'confirmed' || activity.status === 'bookable_open';
  const isBlocked = activity.status === 'cancelled' || activity.status === 'postponed';
  const bookLabel = bookingTag(activity.booking) || 'View booking page';
  // C1 (Jon, 2026-09-03): the source/booking link now appears in the HERO as well as the sticky
  // action bar. Href and label are derived ONCE, here, and rendered twice — the same reason
  // formatDistance is shared by the card and this page: two hand-written copies of a link are
  // two things that drift, and the one that drifts is the one nobody re-reads.
  const sourceHref = activity.bookingUrl ?? activity.sourceUrl;
  const sourceLabel = activity.bookingUrl ? bookLabel : 'View official source';
  const ages = ageGuide(activity.ageMin, activity.ageMax);
  const facts = practicalFacts(activity);
  // Null for the majority of listings (no source family but ActiveNet publishes a facility
  // number) and also for the pathological "stored but undialable" case — one gate, because
  // both mean the same thing to a parent: there is no number to offer, so offer none.
  const phoneHref = activity.venuePhone ? telHref(activity.venuePhone) : null;

  return (
    <div className="kf-detail">
      <Link href={backHref} className="kf-detail__back">
        {backLabel}
      </Link>

      <div className="kf-detail__hero">
        {/* ═══ THE ACTIVITY NAME IS THE H1 (Jon, 2026-09-03) ═══
            The venue held the h1 and the activity name was an eyebrow above it, which had the
            page announcing itself as being ABOUT a building. The subject is the session; the
            venue is where it happens. The page already presented itself this way to search
            engines — detail-metadata.ts has always emitted "{activityName} — {venue}" — so this
            aligns the document with the title it was already shipping.

            The venue is PLAIN TEXT, not an h2. An h2 would put it at the same level as Overview
            and Source & freshness, implying it heads a section of the page; it heads nothing,
            it is an attribute of the h1. Visual order is unchanged — activity name first, venue
            directly under it — so only the tag and the weight moved, not the reading order. */}
        <h1 className="kf-detail__title">{activity.activityName}</h1>
        <p className="kf-detail__place">{activity.venue}</p>
        {/* Was a hand-rolled copy of formatDistance's string, which meant the card and the
            detail page could drift — and did, both stating a distance that had been invented
            when none was measurable. One formatter, one reading, both surfaces. */}
        <p className="kf-detail__venue">{formatDistance(activity)}</p>
        {/* ═══ THE STREET ADDRESS, IN THE HERO (Jon, 2026-09-03) ═══
            venue.address is populated on ~100% of live occurrences and had never been SELECTed,
            so it never left the database. It sits under the venue name because "which of the four
            community centres with this name" is the question a parent asks before anything else
            on this page — and until now the only answer was a map link that 99.6% of listings did
            not have. Plain text, not a link: the map link is separate and already has two homes
            below, and an address that is also a link invites a tap that opens the same thing. */}
        {activity.address &&
          !addressRepeatsVenueName(activity.address, activity.venue) && (
            <p className="kf-detail__address">{formatVenueAddress(activity.address)}</p>
          )}

        {/* Venue phone — in the hero, above the fold, on purpose (Jon, 2026-08-01: "make
            those phone numbers prominent and easily available"). Renders only when the
            source published one; see the decision note in the Source & freshness panel. */}
        {phoneHref && (
          <div className="kf-detail__contact">
            <a
              className="kf-phone"
              href={phoneHref}
              aria-label={`Call the venue at ${activity.venuePhone}`}
              aria-describedby={PHONE_NOTE_ID}
            >
              <span aria-hidden="true">☎</span>
              <span className="kf-phone__label">Call the venue</span>
              <span className="kf-phone__number">{activity.venuePhone}</span>
            </a>
            <p className="kf-phone__note" id={PHONE_NOTE_ID}>
              The venue&apos;s front desk — not a line for this specific session. At sites with more
              than one facility it may ring the main centre.
            </p>
          </div>
        )}

        {/* DUPLICATED, not moved (Jon asked for it "near Call the venue"; duplicate-vs-move was
            left to me). The sticky bar is the thumb-zone do-action and stays visible the whole
            way down the page; moving the link up here would trade an always-reachable CTA for
            one that scrolls away. The hero copy answers a different question than the bar does —
            "who actually says this, and how do I reach them" — which is the same question the
            phone number above it answers, so the two belong side by side.

            SHOWN FOR CANCELLED AND POSTPONED SESSIONS TOO (Jon, 2026-09-03). This was originally
            gated on `!isBlocked` to match the action bar, which deliberately renders a DISABLED
            "not available" button for those two statuses, on the reasoning that a live link above
            a refusal is the page arguing with itself. Jon has ruled the other way, and the reason
            is the stronger one: a parent whose session was cancelled is the parent who MOST needs
            the official page, because it is the only place that can tell them what replaced it or
            when it returns. The bar's disabled button is about the ACTION (you cannot book this);
            this link is about the SOURCE (here is who says so). Those are different claims, so
            the two are not in fact contradicting each other.

            The action bar is deliberately untouched — this change is scoped to the hero link. */}
        <a
          className="kf-detail__source"
          href={sourceHref}
          target="_blank"
          rel="noreferrer noopener"
        >
          {sourceLabel}
        </a>

        <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
          <FreshnessStamp activity={activity} />
        </div>
      </div>

      {/* Honesty block — only when relevant, above booking.
          Icon removed 2026-09-03 (Jon): remove entirely, not shrink or hide on desktop. It was
          aria-hidden, so it carried nothing for anyone using a screen reader and only decorated a
          sentence that already says the thing plainly. */}
      {!isBookable && (
        <div className={`kf-honesty ${isBlocked ? 'kf-honesty--cancelled' : ''}`}>
          <span>{meta.copy}</span>
        </div>
      )}

      {/* Key stat row — the facts a parent needs, 44px pairs. */}
      <div className="kf-statrow">
        <Stat label="Ages" value={formatAges(activity.ageMin, activity.ageMax)} />
        <Stat label="When" value={`${when.day} · ${when.time}`} />
        <Stat label="Cost" value={formatCost(activity)} />
        {/* Booking is DROPPED, not defaulted, when the source states no booking type.
            bookingTag() returns '' for booking type 'none', and the old `|| meta.label` fallback
            then printed the Status value — so on 100 of 113 sampled listings this stat and the
            Status stat both read "Confirmed", side by side, saying the same thing twice under
            two different headings. An absent stat is honest; a duplicated one is noise that
            looks like data. */}
        {/* AND SUPPRESSED WHEN IT MERELY REPEATS STATUS (Operator, 2026-09-03). The guard above
            handles the empty-tag case; this handles the second cause found while verifying it —
            a REAL booking value that happens to read identically to the status label, e.g. both
            "Bookable now". A visitor cannot see provenance, only that the same word appears
            twice, so the distinction between "defaulted" and "genuinely equal" is invisible to
            them and irrelevant to the complaint. */}
        {bookingTag(activity.booking) && bookingTag(activity.booking) !== meta.label && (
          <Stat label="Booking" value={bookingTag(activity.booking)} />
        )}
        {/* C2: DROPPED, not defaulted, when nothing was measured — the same rule the Booking
            stat above already follows. It used to read "Unavailable" under a "Distance" label,
            which spends a stat slot to tell a parent we have nothing. */}
        {activity.distanceKm != null && (
          <Stat label="Distance" value={formatDistanceValue(activity)} />
        )}
        {/* C4: the Status stat is GONE (Jon, 2026-09-03), unconditionally. For every status that
            is not bookable, the honesty block above this row already states the same thing in a
            full sentence with the reason attached; the stat repeated its label two inches lower
            under a heading that added nothing. For the bookable ones it read "Confirmed", which
            is what a listing being on the page already means. See the note in the report about
            the two statuses where this is a genuine loss. */}
      </div>

      {/* Overview renders ONLY when the source actually described the activity. The mapper used
          to substitute "{name} at {venue}." whenever descriptionSnippet was empty, which fired on
          113 of 113 sampled listings across all five sources — so this panel was, in practice,
          always a restatement of the h1 and the venue line under a heading promising more. */}
      {activity.descriptionSnippet && (
        <section className="kf-panel">
          <h2 className="kf-panel__title">Overview</h2>
          <p>{activity.descriptionSnippet}</p>
        </section>
      )}

      {/* Who it's for — age-band clarity + honest sibling read from the source's own age range. */}
      <section className="kf-panel">
        <h2 className="kf-panel__title">Who it&apos;s for</h2>
        {/* ═══ THE AGE RANGE IS NOT REPEATED HERE (Jon, 2026-09-03) ═══
            The top-row stat already states it. This panel used to open "{range} · {band}", so a
            parent read the same span twice within a screen of each other, and on an all-ages
            listing the source echo below made it three times. Only the BAND stays — it is the
            one thing this panel adds that the stat does not. */}
        <p className="kf-guide__band">{ages.band}</p>
        <p className="kf-guide__fit">{ages.siblingFit}</p>
        {activity.ageNotes &&
          !isInternalAgeMarker(activity.ageNotes) &&
          !isAgeNoteRestatement(activity.ageNotes, ages.unspecified) && (
          <p className="kf-guide__note">From the source: {activity.ageNotes}</p>
        )}
      </section>

      {/* Good to know — scannable practical qualities pulled straight from real fields. */}
      {facts.length > 0 && (
        <section className="kf-panel">
          <h2 className="kf-panel__title">Good to know</h2>
          <ul className="kf-facts" aria-label="Practical details">
            {facts.map((fact) => (
              <li key={fact} className="kf-fact">
                {fact}
              </li>
            ))}
          </ul>
        </section>
      )}

      {activity.parentNotes.length > 0 && (
        <section className="kf-panel">
          <h2 className="kf-panel__title">Parent notes</h2>
          <ul>
            {activity.parentNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Source & freshness panel — provenance foregrounded; consistent help. */}
      <section className="kf-panel">
        <h2 className="kf-panel__title">Source &amp; freshness</h2>
        <p>
          Official source: <b>{activity.sourceName}</b> · {meta.label} · {formatChecked(activity.lastCheckedIso)} ·{' '}
          {confidenceSentence(activity.confidence)}
        </p>
        {/* The "View official source" and "Open in maps" links that used to sit here were
            DUPLICATES — same hrefs as the action-bar buttons at the foot of the page, different
            labels, both rendering on every listing. Removed 2026-09-03 (copy audit); the buttons
            are the canonical affordance. ReportWrongInfo stays: it is the only thing in this row
            that appears nowhere else. */}
        <div className="kf-linkrow">
          <ReportWrongInfo occurrenceId={occurrenceId} />
        </div>
        {/* NOTE (G-VENUE-3, QA F1): a per-venue open-data licence notice used to render
            here and was REMOVED — it matched on venue NAME, and a name is not
            provenance, so it claimed OGL licensing for coordinates that never came
            from the City. The attribution now lives site-wide in SiteFooter, where it
            is unconditionally true. Do not reintroduce a per-record version without a
            provenance column on `venue`. See docs/source-register.md §6.6. */}

        {/* Venue phone renders in the hero above (Jon, 2026-08-01), reversing the same-day
            decision to capture `venue.phone` but hold it back from parents. Full record —
            the three original reasons and what became of each — in docs/source-register.md
            §6.3.6; not restated here.
            THE COPY IS A CONTRACT, NOT A DRAFT. "Call the venue" must never become
            "Call {venue}", and the caveat must keep saying front-desk / not-this-session:
            7 of the 36 Vancouver facilities answer on a PARENT centre's number, so the
            named-facility phrasing is false for exactly those. It is asserted, including
            negatively, in tests/ui/venue-phone.test.tsx — reword only with that file. */}
      </section>

      {/* Sticky bottom action bar (thumb zone) — booking is the primary do-action. */}
      <div className="kf-actionbar">
        {isBlocked ? (
          <button type="button" className="kf-btn kf-btn--ghost" style={{ flex: 1 }} disabled>
            {meta.label} — not available
          </button>
        ) : (
          <a
            className="kf-btn kf-btn--primary"
            href={sourceHref}
            target="_blank"
            rel="noreferrer noopener"
          >
            {sourceLabel}
          </a>
        )}
        {activity.locationUrl && (
          <a className="kf-btn kf-btn--ghost" href={activity.locationUrl} target="_blank" rel="noreferrer noopener">
            Maps
          </a>
        )}
      </div>
    </div>
  );
}
