// The activity card — the atomic unit. Answers the six parent questions on the
// face (what / who / when / where / cost / bookable) plus the freshness stamp,
// so a parent can judge it without opening the source. Capped for one-glance scan.
//
// NO PHONE NUMBER HERE. This card and the map popup (ResultsMap.tsx) are each ONE anchor
// wrapping their ENTIRE body, and a `tel:` link nested inside another anchor is invalid
// HTML — the parser closes the outer anchor at the inner one, so the tail of the card
// stops being clickable and the primary "See details" action breaks. NOT impossible,
// though: the stretched-link pattern (plain <div>, invisible ::after full-cover anchor for
// details, normal higher-stacking anchor for the phone) would work. That is a redesign of
// the scan unit, declined for scope — see docs/source-register.md §6.3.6. The number lives
// on the detail page, one tap away behind this card's own CTA.

import Link from 'next/link';
import { Badge } from '@/components/ui';
import { CategoryTile } from './CategoryTile';
import { FreshnessStamp } from './FreshnessStamp';
import {
  REGISTRATION_REQUIRED_TAG,
  bookingTag,
  confidenceMeta,
  formatAges,
  formatCost,
  formatDistance,
  formatSlotSummary,
  formatWhen,
  statusMeta,
} from '../_data/format';
import type { Activity } from '../_data/types';

/**
 * The booking affordance, or — for a registration-required course — an explicit label saying so.
 *
 * Registration content is excluded from results by default and only appears when a parent turned
 * the filter on; when it does appear it must be unmistakable, never quietly mixed in with drop-in
 * cards. The explicit tag supersedes the generic booking tag rather than sitting beside it, so the
 * card never shows two near-identical pills.
 */
function BookingTag({ activity }: { activity: Activity }) {
  if (activity.registrationRequired) {
    return <span className="kf-tag kf-tag--reg">{REGISTRATION_REQUIRED_TAG}</span>;
  }
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
  // One card can stand for several same-day slots of the same series; when it does, the when-line
  // becomes "15 slots, 3:15 PM–7:30 PM" instead of fifteen near-identical cards (search/collapse.ts).
  const slotSummary = formatSlotSummary(activity);
  const whenTime = slotSummary ?? when.time;
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
  const label = [
    `${activity.activityName} at ${activity.venue}`,
    `${when.day} ${whenTime}`,
    formatAges(activity.ageMin, activity.ageMax),
    meta.label,
    conf.label,
    // Screen-reader parity with the visible tag — a course must never read as a drop-in.
    activity.registrationRequired ? REGISTRATION_REQUIRED_TAG : null,
  ]
    .filter(Boolean)
    .join(', ');
  const body = (
    <>
      <CategoryTile category={activity.category} />
      <div className="kf-card__body">
        <p className="kf-card__type">{activity.activityName}</p>
        <h3 className="kf-card__title">{activity.venue}</h3>
        <div className="kf-card__meta">
          <span>
            <b>{when.day}</b> · {whenTime}
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
