// app/api/admin/catalogue-cache/bust/route.ts — force every surface to drop the cached catalogue
// NOW, for the rare correction that cannot wait for the shared cache's cycle.
//
// WHY THIS EXISTS. The shared catalogue cache (lib/search/shared-catalogue-cache.ts) re-derives the
// catalogue's content version only every 6 hours and fully reloads only every 24 (Jon, 2026-09-23:
// the listings rarely change, and frequent checks cost database load). A listing that has to come
// down or change for accuracy or safety cannot wait that long; this skips the wait. Every instance
// serves the corrected catalogue within about two re-check intervals (~2 minutes at the defaults).
// It costs one database probe and, if the catalogue did change, one catalogue load.
//
// Fix the data FIRST (hide / edit / archive the listing), then call this. Busting before the fix
// lands just re-caches the old content.
//
// AUTH, either of:
//   · `Authorization: Bearer $CATALOGUE_CACHE_BUST_SECRET` (or `x-cron-secret`) — the operator path:
//       curl -X POST -H "Authorization: Bearer $SECRET" https://kidsfunapp.ca/api/admin/catalogue-cache/bust
//   · a signed-in admin session (the same resolver the admin write actions use).
// POST only, for the same reason as the snapshot refresh route: nothing that changes shared state
// should be reachable by a method the web treats as safe and prefetchable.
import { NextResponse } from 'next/server';
import { resolveSessionAdmin } from '@/app/admin/_lib/gate';
import { presentedSecret, secretMatches } from '@/lib/http/bearer-secret';
import { LISTING_CACHE_DEFAULT_MS, bustSharedCatalogueCache } from '@/lib/search/postgres-repository';
import { resolveCacheTtlMs } from '@/lib/search/ttl-cache';
import {
  catalogueCacheBustSecret,
  catalogueRecheckIntervalMs,
  sharedCatalogueCacheEnabled,
} from '@/lib/search/shared-catalogue-cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function authorised(request: Request): Promise<'secret' | 'admin' | null> {
  const expected = catalogueCacheBustSecret();
  if (expected && secretMatches(presentedSecret(request), expected)) return 'secret';
  // Only consult the session when no secret was presented: a wrong secret is a 401, full stop.
  if (presentedSecret(request) == null && (await resolveSessionAdmin())) return 'admin';
  return null;
}

export async function POST(request: Request): Promise<NextResponse> {
  const by = await authorised(request);
  if (!by) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  try {
    await bustSharedCatalogueCache();
  } catch (err) {
    console.error(`[catalogue-cache] manual bust failed: ${(err as Error)?.message ?? 'unknown error'}`);
    return NextResponse.json({ ok: false, error: 'bust failed' }, { status: 500 });
  }

  const enabled = sharedCatalogueCacheEnabled();
  console.info(`[catalogue-cache] manual bust by ${by}`);
  return NextResponse.json({
    ok: true,
    busted: true,
    sharedCacheEnabled: enabled,
    // Shared cache on: an instance re-reads the shared version once per re-check interval, and a
    // stale-while-revalidate store may serve the old version one more time. Kill switch on: the
    // bust can only clear THIS instance; every other one keeps its per-instance TTL copy.
    propagatesWithinMs: enabled
      ? 2 * catalogueRecheckIntervalMs()
      : resolveCacheTtlMs('KIDS_FUN_LISTING_CACHE_MS', LISTING_CACHE_DEFAULT_MS),
  });
}
