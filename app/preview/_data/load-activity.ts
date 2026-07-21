// Shared occurrence loader for the detail page(s).
//
// Extracted verbatim from app/preview/[id]/page.tsx so the canonical /activity/[id]
// route and the interim /preview/[id] shell resolve an id through IDENTICAL logic:
//   1) visual fixtures (the demo shell's hand-authored activities),
//   2) the search fixtures (so ids surfaced by /api/search in fixture mode resolve),
//   3) the real Postgres listing — only when the approved live search backend is on.
// Detail pages FAIL CLOSED (return null → notFound) rather than leak a DB error to a
// parent. No network/DB is touched unless KIDS_FUN_SEARCH_BACKEND === 'database'.

import { getPool } from '@/lib/db/client';
import { loadPostgresListingById } from '@/lib/search/postgres-repository';
import { FIXTURE_LISTINGS } from '@/lib/search/__fixtures__/listings';
import { findActivity } from './fixtures';
import { mapListingRecordToActivity, mapSearchItemToActivity } from './search-api';
import type { Activity } from './types';

export async function loadActivityById(id: string): Promise<Activity | null> {
  // LIVE database mode resolves ONLY from Postgres. The fixture lookups below must not run
  // here: the canonical, shareable /activity/[id] route (and the interim /preview/[id])
  // would otherwise resolve a test id like `l-rank-confirmed` ("Rank Test Gym") to a fake
  // detail page for a real visitor — the same test-data leak fixed in /api/search. This
  // matches the documented intent (README: detail pages are "DB-backed in staging").
  if (process.env.KIDS_FUN_SEARCH_BACKEND === 'database') {
    try {
      const listing = await loadPostgresListingById(getPool(), id);
      return listing ? mapListingRecordToActivity(listing) : null;
    } catch {
      // Detail pages must fail closed rather than leaking DB errors to parents.
      return null;
    }
  }

  // Fixture/demo mode (KIDS_FUN_SEARCH_BACKEND !== 'database'): local dev and the /preview
  // demo shell resolve ids from the hand-authored + search fixtures (no DB, no network).
  const visualFixture = findActivity(id);
  if (visualFixture) return visualFixture;

  const searchFixture = FIXTURE_LISTINGS.find((listing) => listing.id === id);
  if (searchFixture) return mapSearchItemToActivity({ listing: searchFixture, distanceKm: null });

  return null;
}
