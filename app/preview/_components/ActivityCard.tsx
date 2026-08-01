// The activity card — the atomic unit. Answers the six parent questions on the
// face (what / who / when / where / cost / bookable) plus the freshness stamp,
// so a parent can judge it without opening the source. Capped for one-glance scan.
//
// NO PHONE NUMBER HERE, and the reason is structural rather than editorial. When the
// 2026-08-01 decision to surface `venue.phone` prominently was made, this card and the
// map popup (app/search/_components/ResultsMap.tsx) were both evaluated as candidate
// surfaces. Both are ONE anchor wrapping their ENTIRE body — see the <Link>/<a> below
// and the popup's `setHTML('<a class="kf-map__pop" …>')`. A `tel:` link nested inside
// another anchor is invalid HTML: the parser closes the outer anchor at the inner one,
// so the tail of the card stops being clickable and the primary "See details" action
// breaks. Restructuring the card to escape that is a redesign of the scan unit, not a
// phone-number change. The number therefore lives on the detail page (ActivityDetail),
// which is exactly one tap away behind this card's own explicit CTA, and sits in that
// page's hero where it is the first thing under the venue name.

import Link from 'next/link';
import { Badge } from '@/components/ui';
import { CategoryTile } from './CategoryTile';
import { FreshnessStamp } from './FreshnessStamp';
import { bookingTag, confidenceMeta, formatAges, formatCost, formatDistance, formatWhen, statusMeta } from '../_data/format';
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
  // Source-authority read (BR-13) — surfaced on the card face so "source confidence" is
  // visible with a text label + tone (never colour-only), G-T22-2.
  const conf = confidenceMeta(activity.confidence);
  const cardClass = ['kf-card', meta.tone === 'muted' ? 'kf-card--muted' : '', meta.tone === 'cancelled' ? 'kf-card--cancelled' : '']
    .filter(Boolean)
    .join(' ');
  // External-source cards leave the site to the official listing; internal cards open the
  // in-app detail. The CTA states which, honestly, so the whole-card link has a visible,
  // predictable destination (G-T22-1 "source CTA"; Blueprint screen-2 item 9).
  const external = Boolean(activity.detailUrl);
  const ctaLabel = external ? `View on ${activity.sourceName} ↗` : 'See details →';
  const label = `${activity.activityName} at ${activity.venue}, ${when.day} ${when.time}, ${formatAges(activity.ageMin, activity.ageMax)}, ${meta.label}, ${conf.label}`;
  const body = (
    <>
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
          <Badge variant={conf.tone}>{conf.label}</Badge>
        </div>
        <FreshnessStamp activity={activity} />
        <span className="kf-card__cta">{ctaLabel}</span>
      </div>
    </>
  );

  if (activity.detailUrl) {
    return (
      <a href={activity.detailUrl} className={cardClass} aria-label={`${label}; opens official source`} target="_blank" rel="noreferrer noopener">
        {body}
      </a>
    );
  }

  return (
    <Link href={`/preview/${activity.id}`} className={cardClass} aria-label={label}>
      {body}
    </Link>
  );
}
