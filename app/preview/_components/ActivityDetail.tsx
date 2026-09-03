import Link from 'next/link';
import { CategoryTile } from './CategoryTile';
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
        <p className="kf-detail__type">{activity.activityName}</p>
        <h1 className="kf-detail__title">{activity.venue}</h1>
        {/* Was a hand-rolled copy of formatDistance's string, which meant the card and the
            detail page could drift — and did, both stating a distance that had been invented
            when none was measurable. One formatter, one reading, both surfaces. */}
        <p className="kf-detail__venue">{formatDistance(activity)}</p>

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

        <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
          <CategoryTile category={activity.category} size={64} />
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
        <Stat label="Booking" value={bookingTag(activity.booking) || meta.label} />
        <Stat label="Distance" value={formatDistanceValue(activity)} />
        <Stat label="Status" value={meta.label} />
      </div>

      <section className="kf-panel">
        <h2 className="kf-panel__title">Overview</h2>
        <p>{activity.descriptionSnippet}</p>
      </section>

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
        {activity.ageNotes && !isAgeNoteRestatement(activity.ageNotes, ages.unspecified) && (
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
        <div className="kf-linkrow">
          <a className="kf-link" href={activity.sourceUrl} target="_blank" rel="noreferrer noopener">
            ↗ View official source
          </a>
          {activity.locationUrl && (
            <a className="kf-link" href={activity.locationUrl} target="_blank" rel="noreferrer noopener">
              ⌖ Open in maps
            </a>
          )}
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
            href={activity.bookingUrl ?? activity.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            {activity.bookingUrl ? bookLabel : 'View official source'}
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
