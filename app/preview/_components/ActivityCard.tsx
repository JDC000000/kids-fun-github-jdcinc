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
import { CategoryTile } from './CategoryTile';
import { FreshnessStamp } from './FreshnessStamp';
import {
  REGISTRATION_REQUIRED_TAG,
  bookingTag,
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
  const when = formatWhen(activity.startIso, activity.endIso, activity.openHoursLabel);
  // One card can stand for several same-day slots of the same series; when it does, the when-line
  // becomes "15 slots, 3:15 PM–7:30 PM" instead of fifteen near-identical cards (search/collapse.ts).
  const slotSummary = formatSlotSummary(activity);
  const whenTime = slotSummary ?? when.time;
  const meta = statusMeta(activity.status, activity.seasonLabel);
  const cardClass =['kf-card', meta.tone === 'muted' ? 'kf-card--muted' : '', meta.tone === 'cancelled' ? 'kf-card--cancelled' : '']
    .filter(Boolean)
    .join(' ');
  // External-source cards leave the site to the official listing; internal cards open the
  // in-app detail. The CTA states which, honestly, so the whole-card link has a visible,
  // predictable destination (G-T22-1 "source CTA"; Blueprint screen-2 item 9).
  const external = Boolean(activity.detailUrl);
  const ctaLabel = external ? `View on ${activity.sourceName} ↗` : 'See details →';
  // The accessible name mirrors what is VISIBLE on the card and nothing more. The old
  // source-authority read ("Official source") was dropped from it along with the badge below —
  // announcing a label a sighted parent can no longer see is exactly the kind of drift that
  // makes an aria-label wrong over time.
  //
  // `meta.label` STAYS IN THIS LIST even though the stamp below can now hide it, and that is
  // not an oversight — it is the same rule applied. The stamp only hides the label when the
  // booking pill prints the IDENTICAL string (see `statusLabelDuplicatedByTag`), so the label
  // remains visible on the face in every case; announcing it announces something a sighted
  // parent can still read. If anything the parity improved: the string used to be visible
  // twice and announced once, and is now visible once and announced once.
  const label = [
    `${activity.activityName} at ${activity.venue}`,
    `${when.day} ${whenTime}`,
    formatAges(activity.ageMin, activity.ageMax),
    meta.label,
    // Screen-reader parity with the visible tag — a course must never read as a drop-in.
    activity.registrationRequired ? REGISTRATION_REQUIRED_TAG : null,
  ]
    .filter(Boolean)
    .join(', ');
  const bookingLabel = activity.registrationRequired ? REGISTRATION_REQUIRED_TAG : bookingTag(activity.booking);
  // A `bookable_open` occurrence printed "Bookable now" TWICE on the face: once as the booking
  // pill, once inside the freshness stamp. Two different fields drive them — `activity.booking`
  // through bookingTag(), `activity.status` through statusMeta() — so this is a collision, not
  // one value rendered twice, and "Bookable now" is the only exact string the two vocabularies
  // share (search-api's mapBooking maps status `bookable_open` → booking `bookable_now`, which is
  // why it collides on every such card rather than occasionally).
  //
  // The de-duplication is therefore an EQUALITY TEST, not a `status === 'bookable_open'` special
  // case. That matters: statusMeta covers all 16 canonical statuses and most of them ('May be
  // stale', 'Unverified', 'Full', 'Out of season', 'Suspended') have NO pill at all, so the stamp
  // is their only status text on the card. Suppressing on equality keeps every one of those
  // untouched — the honesty invariant (UXR-06 / T-07) cannot be broken by this branch, because it
  // only ever fires when the same words are still on screen. It also stays correct on its own if
  // either vocabulary gains or loses a label later.
  //
  // The pill wins and the stamp yields, per Jon's beta feedback ("keep only source credit +
  // freshness" inside the dashed box). `Boolean(bookingLabel)` is load-bearing: no pill is
  // rendered for an empty booking label, so without it an empty statusMeta label would suppress
  // the stamp's text with nothing left to state the status.
  const statusLabelDuplicatedByTag = Boolean(bookingLabel) && bookingLabel === meta.label;
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
        {/* THE "Official source" BADGE IS GONE (Jon's beta feedback on the search result tile).
            It was the source-AUTHORITY read (BR-13 / G-T22-2) — "Official source" / "Editorial
            listing" / "Community-listed" — rendered as a <Badge> right here. The whole card is a
            single anchor, so it was also a second thing to click that went exactly where "See
            details →" already goes; that CTA is now the only affordance in this zone.

            WHAT IS DELIBERATELY STILL HERE: the <FreshnessStamp> below. It is the light-green,
            dashed-border "✓ Confirmed · <source> · Checked today" chip, and it is the closest
            thing on this card to what the feedback described — but removing it is NOT a styling
            decision this component can take alone. On an INTERNAL card (no external detailUrl)
            it is the only place the source is named, and naming the source on the rendered card
            is a licensing obligation, not a preference: tests/compliance/attribution.test.ts
            (G-T35-3, "attribute and summarise") asserts exactly that, and card-completeness
            (G-T22-4 / KPI #5) requires the freshness field. Removing it needs a compliance
            ruling and a replacement attribution, so it is flagged rather than quietly dropped. */}
        {bookingLabel && (
          <div className="kf-card__tags">
            <BookingTag activity={activity} />
          </div>
        )}
        <FreshnessStamp activity={activity} hideStatusLabel={statusLabelDuplicatedByTag} />
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
