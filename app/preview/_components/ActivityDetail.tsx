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
