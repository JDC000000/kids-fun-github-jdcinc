// The activity card — the atomic unit. Answers the six parent questions on the
// face (what / who / when / where / cost / bookable) plus the freshness stamp,
// so a parent can judge it without opening the source. Capped for one-glance scan.

import Link from 'next/link';
import { CategoryTile } from './CategoryTile';
import { FreshnessStamp } from './FreshnessStamp';
import { bookingTag, formatAges, formatCost, formatDistance, formatWhen, statusMeta } from '../_data/format';
import type { Activity } from '../_data/types';

function BookingTag({ activity }: { activity: Activity }) {
  const label = bookingTag(activity.booking);
  if (!label) return null;
  const cls =
    activity.booking === 'bookable_now'
      ? 'kf-tag--book'
      : activity.booking === 'registration'
        ? 'kf-tag--reg'
        : 'kf-tag--dropin';
  return <span className={`kf-tag ${cls}`}>{label}</span>;
}

export function ActivityCard({ activity }: { activity: Activity }) {
  const when = formatWhen(activity.startIso, activity.endIso);
  const meta = statusMeta(activity.status, activity.seasonLabel);
  const cardClass = ['kf-card', meta.tone === 'muted' ? 'kf-card--muted' : '', meta.tone === 'cancelled' ? 'kf-card--cancelled' : '']
    .filter(Boolean)
    .join(' ');
  const label = `${activity.activityName} at ${activity.venue}, ${when.day} ${when.time}, ${formatAges(activity.ageMin, activity.ageMax)}, ${meta.label}`;

  return (
    <Link href={`/preview/${activity.id}`} className={cardClass} aria-label={label}>
      <CategoryTile category={activity.category} />
      <div className="kf-card__body">
        <p className="kf-card__type">{activity.activityName}</p>
        <h3 className="kf-card__title">{activity.venue}</h3>
        <div className="kf-card__meta">
          <span>
            <b>{when.day}</b> · {when.time}
          </span>
          <span>
            {formatAges(activity.ageMin, activity.ageMax)} · {formatCost(activity)}
          </span>
          <span>{formatDistance(activity)}</span>
        </div>
        <div className="kf-card__tags">
          <BookingTag activity={activity} />
        </div>
        <FreshnessStamp activity={activity} />
      </div>
    </Link>
  );
}
