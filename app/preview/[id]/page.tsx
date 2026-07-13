import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CategoryTile } from '../_components/CategoryTile';
import { FreshnessStamp } from '../_components/FreshnessStamp';
import { ReportWrongInfo } from '../_components/ReportWrongInfo';
import { getPool } from '@/lib/db/client';
import { loadPostgresListingById } from '@/lib/search/postgres-repository';
import { FIXTURE_LISTINGS } from '@/lib/search/__fixtures__/listings';
import { ACTIVITIES, findActivity } from '../_data/fixtures';
import { mapListingRecordToActivity, mapSearchItemToActivity } from '../_data/search-api';
import {
  ageGuide,
  bookingTag,
  formatAges,
  formatChecked,
  formatCost,
  formatDistance,
  formatWhen,
  practicalFacts,
  statusMeta,
} from '../_data/format';

// Activity detail / source page (Screen 3) — everything to decide and to trust,
// with source provenance foregrounded. Fixture-backed locally, and DB-backed in
// staging when the approved live search backend surfaces real occurrence IDs.

export const dynamic = 'force-dynamic';

async function findAnyActivity(id: string) {
  const visualFixture = findActivity(id);
  if (visualFixture) return visualFixture;

  const searchFixture = FIXTURE_LISTINGS.find((listing) => listing.id === id);
  if (searchFixture) return mapSearchItemToActivity({ listing: searchFixture, distanceKm: null });

  if (process.env.KIDS_FUN_SEARCH_BACKEND !== 'database') return null;

  try {
    const listing = await loadPostgresListingById(getPool(), id);
    return listing ? mapListingRecordToActivity(listing) : null;
  } catch {
    // Detail pages must fail closed rather than leaking DB errors to parents.
    return null;
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="kf-stat">
      <div className="kf-stat__label">{label}</div>
      <div className="kf-stat__value">{value}</div>
    </div>
  );
}

export default async function DetailPage({ params }: { params: { id: string } }) {
  const activity = await findAnyActivity(params.id);
  if (!activity) notFound();

  const when = formatWhen(activity.startIso, activity.endIso);
  const meta = statusMeta(activity.status, activity.seasonLabel);
  const isBookable = activity.status === 'confirmed' || activity.status === 'bookable_open';
  const isBlocked = activity.status === 'cancelled' || activity.status === 'postponed';
  const bookLabel = bookingTag(activity.booking) || 'View booking page';
  const ages = ageGuide(activity.ageMin, activity.ageMax);
  const facts = practicalFacts(activity);

  return (
    <div className="kf-detail">
      <Link href="/preview" className="kf-detail__back">
        ← Back to today
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
          <ReportWrongInfo />
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
