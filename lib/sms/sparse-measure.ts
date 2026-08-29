// lib/sms/sparse-measure.ts — the server-side measurement behind the sparse-area notice.
//
// ═══ WHY THIS IS A NEW MODULE AND NOT A FUNCTION IN sparse-areas.ts ═══
// sparse-areas.ts is deliberately PURE — its own header: "Pure: postal code + a set of thin
// municipalities in, a notice or null out. No engine, no database, no clock — so the copy decision
// is unit-testable." Importing the search engine into it to save a file would trade that away for
// nothing.
//
// ═══ AND WHY IT DUPLICATES app/sms/signup/page.tsx's LOCAL COPY, DELIBERATELY AND VISIBLY ═══
// That page has an identical `measureSparseRegionIds`, unexported. The correct move would be for
// both callers to share this one — but /sms/signup is under an explicit instruction not to be
// touched while it awaits its own iteration, and quietly editing it to satisfy a DRY preference
// would be exactly the kind of unasked-for change that instruction exists to prevent.
//
// So the duplication is recorded rather than hidden: >>> WHEN app/sms/signup/page.tsx IS NEXT
// LEGITIMATELY EDITED, DELETE ITS LOCAL COPY AND IMPORT THIS ONE. <<< The genuinely load-bearing
// logic — the engine, `sparseRegionIdsFrom`, the fallback list — is already shared; what is
// duplicated is twelve lines of glue around them.
import { REGION_CHIPS } from '@/app/search/_lib/params';
import { getServerSearchEngine } from '@/lib/search/server-engine';
import { SPARSE_FALLBACK_REGION_IDS, sparseRegionIdsFrom } from '@/lib/sms/sparse-areas';

/**
 * Which covered municipalities are currently thin, measured over the live catalogue.
 *
 * ONE search, no query constraint, all area chips selected — `regionCoverage` is the engine's own
 * count and its own `sparse` verdict, the same one /search's notice runs on. Nothing re-derived.
 *
 * Falls back to the last-known static list when the engine cannot be built (no database, failed
 * load): see SPARSE_FALLBACK_REGION_IDS for why the fallback warns rather than going quiet.
 */
export async function measureSparseRegionIds(): Promise<{
  ids: readonly string[];
  measured: boolean;
}> {
  try {
    const engine = await getServerSearchEngine();
    if (!engine) return { ids: SPARSE_FALLBACK_REGION_IDS, measured: false };
    const response = engine.search({
      q: '',
      regionChipIds: REGION_CHIPS.map((c) => c.id),
      minResults: 0,
    });
    const ids = sparseRegionIdsFrom(response.regionCoverage);
    return ids == null
      ? { ids: SPARSE_FALLBACK_REGION_IDS, measured: false }
      : { ids, measured: true };
  } catch {
    return { ids: SPARSE_FALLBACK_REGION_IDS, measured: false };
  }
}
