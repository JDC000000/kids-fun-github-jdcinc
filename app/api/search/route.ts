// app/api/search/route.ts — Search API route (G-T16-7, TSD §5A, FR-02).
//
// STUB: fixture-backed until live ingestion (M1) + the Postgres search repository land.
// The route contract (query params → SearchResponse JSON) is stable; only the engine's
// injected repository/geocoder change when live data arrives. Responses carry
// `meta.fixtureBacked: true` and an `x-data-source: fixture` header so nothing mistakes
// this for production data.

import { NextResponse } from 'next/server';
import { makeFixtureEngine } from '@/lib/search/__fixtures__/engine';
import type { OriginRequest } from '@/lib/geo/origin';
import type { SortKey } from '@/lib/search/types';

export const dynamic = 'force-dynamic';

const VALID_SORTS: SortKey[] = ['best_match', 'distance', 'soonest', 'lowest_cost', 'newest'];

const { engine } = makeFixtureEngine();

/** GET /api/search?q=open+gym&lat=..&lng=..&sort=..&region=van,bby&includeUnknownCost=1&limit=20 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const p = url.searchParams;
  const q = p.get('q') ?? '';

  const sortParam = p.get('sort');
  const sort = sortParam && (VALID_SORTS as string[]).includes(sortParam) ? (sortParam as SortKey) : undefined;

  const origin = buildOriginRequest(p);
  const regionChipIds = (p.get('region') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const includeUnknownCost = ['1', 'true', 'yes'].includes((p.get('includeUnknownCost') ?? '').toLowerCase());
  const limit = clampInt(p.get('limit'), 1, 100);
  const minResults = clampInt(p.get('minResults'), 0, 100);

  const response = engine.search({
    q,
    origin,
    signedIn: p.get('signedIn') === '1',
    regionChipIds,
    sort,
    includeUnknownCost,
    ...(limit != null ? { limit } : {}),
    ...(minResults != null ? { minResults } : {}),
  });

  return NextResponse.json(response, { headers: { 'x-data-source': 'fixture' } });
}

/** Derive an origin resolution request from query params (near me / area chip / saved home). */
function buildOriginRequest(p: URLSearchParams): OriginRequest | null {
  const lat = Number(p.get('lat'));
  const lng = Number(p.get('lng'));
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { mode: 'near_me', coords: { lat, lng } };
  }
  const area = p.get('area');
  if (area) return { mode: 'area_chip', areaChipId: area };
  const postal = p.get('postal');
  if (postal) return { mode: 'saved_home', homePostal: postal };
  return null;
}

function clampInt(raw: string | null, min: number, max: number): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
