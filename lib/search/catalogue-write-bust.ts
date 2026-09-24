// lib/search/catalogue-write-bust.ts — make an admin write reach every catalogue surface NOW,
// rather than at the shared catalogue cache's next 6-hour probe.
//
// WHY THIS EXISTS. The shared catalogue cache (./shared-catalogue-cache.ts) re-derives the
// catalogue only every 6 hours (Jon, 2026-09-23). Admin sign-in is live (/admin/auth/signin, on
// main since 2026-09-21), so an admin taking a listing down through the corrections queue would
// otherwise see it stay up on search, the homepage picks, SMS instant picks, signup and account for
// up to 6 hours — where the pre-cache 10-minute TTL showed it within 10 minutes. Each admin server
// action whose write changes what the catalogue query returns calls this after the write succeeds;
// every instance then serves the change within about two re-check intervals (~2 minutes).
//
// WHICH WRITES CALL IT, AND WHICH DELIBERATELY DO NOT (checked against the SQL each one runs):
//   calls it   corrections resolve        activity_occurrence.status_state / confidence_label
//              manual listing create      a new activity_occurrence
//              QA-queue confirm / reject  status_state → confirmed, or archived_at
//              dedup merge / keep both    archived_at on the duplicate, or status_state
//              source UPDATE              source.name and authority_tier are read-model columns
//              category UPDATE            category.key is the listing's primary_category_key
//   does not   source / category CREATE   no listing references a row that did not exist
//              region create / update     the region hierarchy is its own per-instance 60s cache
//              alias save / delete        the synonym_alias dictionary is its own 60s cache
//
// NEVER THROWS. It runs after the admin's write has committed; failing the action at that point
// would tell the admin "nothing was changed" about a change that was made. A failed bust is logged
// and sent to Sentry, and the change still arrives with the next probe — or with the manual bust,
// POST /api/admin/catalogue-cache/bust.
import { captureAndFlush } from '@/lib/observability/route-handler';
import { bustSharedCatalogueCache } from './postgres-repository';

/** @param action  a short audit-style label for the log line, e.g. `correction.resolve` */
export async function bustCatalogueAfterAdminWrite(action: string): Promise<void> {
  try {
    await bustSharedCatalogueCache();
    console.info(`[catalogue-cache] auto-bust after admin ${action}`);
  } catch (err) {
    console.error(
      `[catalogue-cache] auto-bust after admin ${action} FAILED (${(err as Error)?.message ?? 'unknown error'}). ` +
        'The change is saved; it reaches search at the next catalogue probe, or run the manual bust ' +
        '(POST /api/admin/catalogue-cache/bust) to publish it now.'
    );
    await captureAndFlush(err, undefined, { operation: 'catalogue_auto_bust', admin_action: action });
  }
}
