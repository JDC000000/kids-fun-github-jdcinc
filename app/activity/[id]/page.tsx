import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ActivityDetail } from '../../preview/_components/ActivityDetail';
import { loadActivityById } from '../../preview/_data/load-activity';
import { buildDetailMetadata, notFoundDetailMetadata } from '../../preview/_data/detail-metadata';
import { recordListingView } from '@/lib/analytics/record';

// CANONICAL activity detail / source page — /activity/[id] (T24 · G-T24-1/2/3, FR-12,
// NR-02, IR-04). This is the product's stable, shareable, SEO-canonical URL for a
// single occurrence: the same rich, QA'd detail body the interim /preview/[id] shell
// renders (distinct source/booking/location CTAs, last-checked + confidence, honesty
// block, provenance), promoted onto the canonical path with real per-activity
// OpenGraph/Twitter/canonical metadata so a shared link previews and indexes honestly.
//
// The rendered body, the id→occurrence loader and the analytics capture are all
// shared with /preview/[id]; the only differences here are the canonical URL, the
// share metadata (generateMetadata), and back-nav pointing at the scan page.

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const activity = await loadActivityById(params.id);
  return activity ? buildDetailMetadata(activity, params.id) : notFoundDetailMetadata();
}

export default async function CanonicalActivityPage({ params }: { params: { id: string } }) {
  const activity = await loadActivityById(params.id);
  if (!activity) notFound();

  // Analytics (M5): best-effort "listing viewed" capture. Never blocks or breaks the
  // render — recordListingView swallows all failures.
  await recordListingView(params.id, {
    activityName: activity.activityName,
    category: activity.category,
    // `?? undefined` is a TYPE bridge, not a defaulting decision: the analytics meta field is
    // optional-string and `sourceName` is now nullable. recordListingView stores `?? null`
    // either way, so an absent source is recorded as absent rather than as a stand-in.
    sourceName: activity.sourceName ?? undefined,
  });

  return (
    <ActivityDetail
      activity={activity}
      occurrenceId={params.id}
      backHref="/search"
      backLabel="← Back to results"
    />
  );
}
