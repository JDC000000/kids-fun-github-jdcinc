import Link from 'next/link';
import { CategoryTile } from './CategoryTile';
import { FreshnessStamp } from './FreshnessStamp';
import { ReportWrongInfo } from './ReportWrongInfo';
import type { Activity } from '../_data/types';
import {
  ageGuide,
  bookingTag,
  formatAges,
  formatChecked,
  formatCost,
  formatWhen,
  practicalFacts,
  statusMeta,
  telHref,
} from '../_data/format';

// Activity detail / source page body (Screen 3) — everything to decide and to trust,
// with source provenance foregrounded. Shared, unchanged markup rendered by BOTH the
// canonical /activity/[id] route and the interim /preview/[id] demo shell; the only
// route-specific bit is the back link (backHref/backLabel), so neither surface
// regresses visually. Presentation only — data loading + analytics stay in the route.

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
  const when = formatWhen(activity.startIso, activity.endIso);
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
        <p className="kf-detail__venue">
          {activity.area} · {activity.driveMinutes} min drive · {activity.distanceKm.toFixed(1)} km
        </p>

        {/* Venue phone — in the hero, above the fold, on purpose (Jon, 2026-08-01: "make
            those phone numbers prominent and easily available"). Renders only when the
            source published one; see the decision note in the Source & freshness panel. */}
        {phoneHref && (
          <div className="kf-detail__contact">
            <a className="kf-phone" href={phoneHref} aria-label={`Call the venue at ${activity.venuePhone}`}>
              <span aria-hidden="true">☎</span>
              <span className="kf-phone__label">Call the venue</span>
              <span className="kf-phone__number">{activity.venuePhone}</span>
            </a>
            <p className="kf-phone__note">
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

      {/* Honesty block — only when relevant, above booking. */}
      {!isBookable && (
        <div className={`kf-honesty ${isBlocked ? 'kf-honesty--cancelled' : ''}`}>
          <span aria-hidden="true">{meta.icon}</span>
          <span>{meta.copy}</span>
        </div>
      )}

      {/* Key stat row — the facts a parent needs, 44px pairs. */}
      <div className="kf-statrow">
        <Stat label="Ages" value={formatAges(activity.ageMin, activity.ageMax)} />
        <Stat label="When" value={`${when.day} · ${when.time}`} />
        <Stat label="Cost" value={formatCost(activity)} />
        <Stat label="Booking" value={bookingTag(activity.booking) || meta.label} />
        <Stat label="Distance" value={`${activity.distanceKm.toFixed(1)} km`} />
        <Stat label="Status" value={meta.label} />
      </div>

      <section className="kf-panel">
        <h2 className="kf-panel__title">Overview</h2>
        <p>{activity.descriptionSnippet}</p>
      </section>

      {/* Who it's for — age-band clarity + honest sibling read from the source's own age range. */}
      <section className="kf-panel">
        <h2 className="kf-panel__title">Who it&apos;s for</h2>
        <p className="kf-guide__band">
          {ages.range} · {ages.band}
        </p>
        <p className="kf-guide__fit">{ages.siblingFit}</p>
        {activity.ageNotes && <p className="kf-guide__note">From the source: {activity.ageNotes}</p>}
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
          Official source: <b>{activity.sourceName}</b> · {meta.label} · {formatChecked(activity.lastCheckedIso)} ·
          Confidence: {activity.confidence}
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

        {/* DECISION, 2026-08-01 — REVERSED THE SAME DAY, and the reversal is the live rule.
            An earlier build captured `venue.phone` (migration 0024) and deliberately did NOT
            render it, for three reasons. Jon overruled two of them directly: "show parents the
            telephone number for all venues… the key user experience is finding information —
            discoverability and details. If they want to convert to a phone call off-platform,
            that's great." The number now renders in the hero above, high on the page on purpose.

            What became of each original reason:
            1. ONLY ONE SOURCE FAMILY OF SEVEN POPULATES IT — accepted, and shown anyway.
               Coverage follows which back-end a municipality bought, so rec-centre listings
               carry a number and library/museum/Eventbrite/city-calendar listings do not. This
               is handled the way `locationUrl` two lines below already handles it: render only
               when present. A listing without a phone shows NOTHING — never a blank field, never
               a placeholder implying one is missing.
            2. THE NUMBER IS A FRONT DESK, NOT A BOOKING LINE — answered by COPY, not by hiding.
               13 of the 36 Vancouver facilities share a line in 6 groups (7 satellites answering
               on a parent centre's main number; Hillcrest contributes two). So the label claims
               only what is true of all 43 captured values: it is THE VENUE's front desk, not this
               session's line, and at multi-facility sites it may ring the main centre. Prominent
               and honest, rather than prominent and misleading.
            3. IT WAS NOT REACHABLE FROM THIS COMPONENT — a real technical fact, now fixed rather
               than cited: `v.phone` flows through the listing SELECT and its GROUP BY
               (lib/search/postgres-repository.ts) → `ListingRecord.venuePhone` →
               mapListingRecordToActivity → `Activity.venuePhone`.

            Full record, including the coverage measurements and the ingest-side guard, in
            docs/source-register.md §6.3.6. */}
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
