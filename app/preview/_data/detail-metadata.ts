// Canonical share/SEO metadata for the activity detail page (T24 / G-T24-1).
//
// The detail page is the product's shareable, linkable unit — a parent copies the
// URL into a group chat, or it surfaces from search. For that to work honestly it
// needs real, per-activity <title>/description/OpenGraph/Twitter tags and, above
// all, a single CANONICAL url so the interim /preview/[id] shell never competes
// with the canonical /activity/[id] route for the same content.
//
// One builder, used by BOTH routes: on /activity/[id] the canonical points at self;
// on /preview/[id] it points AWAY to /activity/[id]. Copy is composed only from real
// occurrence fields (no invented claims) — the same honesty bar as the visible page.

import type { Metadata } from 'next';
import { siteUrl } from '@/lib/email/config';
import { formatAges, formatChecked, formatCost, formatWhen } from './format';
import type { Activity } from './types';

const SITE_NAME = 'KIDS FUN';

/** The canonical, stable path for an occurrence's detail page. */
export function canonicalActivityPath(id: string): string {
  return `/activity/${encodeURIComponent(id)}`;
}

/** "Public skate — Trout Lake Rink · KIDS FUN" — venue/activity first (matches card voice). */
export function activityTitle(activity: Activity): string {
  return `${activity.activityName} — ${activity.venue} · ${SITE_NAME}`;
}

/**
 * One honest, share-length description built ONLY from real fields a parent scans:
 * ages · when · area · cost, plus the trust line (source + last-checked). Capped so
 * it stays inside the ~160–200 char window search/social previews respect.
 */
export function describeActivity(activity: Activity): string {
  const when = formatWhen(activity.startIso, activity.endIso);
  const lead = [
    formatAges(activity.ageMin, activity.ageMax),
    `${when.day} · ${when.time}`,
    activity.area,
    formatCost(activity),
  ].join(' · ');
  const trust = `Source: ${activity.sourceName} · ${formatChecked(activity.lastCheckedIso)}.`;
  // Strip a trailing period from the composed lead before the sentence join so a
  // cost segment that already ends in a period (e.g. "$7 approx.") does not produce
  // a double period ("…$7 approx.. Source:") in the share meta-description. (R15/Task R F1)
  const full = `${lead.replace(/\.$/, '')}. ${trust}`;
  return full.length > 200 ? `${full.slice(0, 199).trimEnd()}…` : full;
}

/**
 * Full Next.js Metadata for a detail page. Always sets the canonical to the
 * /activity/[id] route, so this is correct whether rendered on the canonical route
 * (self-referential) or on the interim /preview/[id] shell (points to canonical).
 * metadataBase makes the relative canonical/OG urls resolve to absolute ones.
 */
export function buildDetailMetadata(activity: Activity, id: string): Metadata {
  const title = activityTitle(activity);
  const description = describeActivity(activity);
  const path = canonicalActivityPath(id);
  return {
    metadataBase: new URL(siteUrl()),
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: path,
      siteName: SITE_NAME,
      type: 'website',
      locale: 'en_CA',
    },
    twitter: {
      card: 'summary',
      title,
      description,
    },
  };
}

/** Fallback metadata for a detail URL whose occurrence can't be found (noindex). */
export function notFoundDetailMetadata(): Metadata {
  return {
    metadataBase: new URL(siteUrl()),
    title: `Activity not found · ${SITE_NAME}`,
    description: 'This activity is no longer listed. Search KIDS FUN for what’s on today.',
    robots: { index: false, follow: true },
  };
}
