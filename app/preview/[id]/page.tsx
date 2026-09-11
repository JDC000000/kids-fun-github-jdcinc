import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ActivityDetail } from '../_components/ActivityDetail';
import { loadActivityById } from '../_data/load-activity';
import { buildDetailMetadata, notFoundDetailMetadata } from '../_data/detail-metadata';
import { recordListingView } from '@/lib/analytics/record';

// Activity detail on the interim fixture/demo shell (Screen 3). The canonical,
// shareable route is /activity/[id] (T24) — this shell stays for the built-out demo
// flows and the many links that still point at it, but its metadata canonical points
// AT /activity/[id] so the two never compete for the same content in search.
//
// Loading, analytics and the rendered body are shared with the canonical route
// (loadActivityById + ActivityDetail), so both surfaces stay byte-for-byte in sync.

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const activity = await loadActivityById(params.id);
  return activity ? buildDetailMetadata(activity, params.id) : notFoundDetailMetadata();
}

export default async function DetailPage({ params }: { params: { id: string } }) {
  const activity = await loadActivityById(params.id);
  if (!activity) notFound();

  // Analytics (M5): best-effort "listing viewed" capture. Never blocks or breaks
  // the render — recordListingView swallows all failures.
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
      backHref="/preview"
      backLabel="← Back to today"
    />
  );
}
