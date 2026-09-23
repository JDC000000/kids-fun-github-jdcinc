// lib/search/next-data-cache-store.ts — the production `SharedCatalogueStore`: Next.js's
// `unstable_cache`, which on Vercel is backed by the Data Cache, shared by every instance of a
// project. Self-hosted (`next start`) it is the file-system cache under .next/cache, shared by
// every process on that host.
//
// Kept to this one adapter so the cache's logic (./shared-catalogue-cache.ts) stays testable
// without a Next.js runtime, and so a later move to a different store (Vercel Blob, a KV) is a
// change here only.
//
// Behaviour this module relies on, as implemented in next@14.2 (server/web/spec-extension/
// unstable-cache.js, server/lib/incremental-cache/*):
//   · The value is stored as JSON.stringify(result), which is why the snapshot is a JSON-safe
//     object with its bytes in base64 (./catalogue-snapshot.ts).
//   · A missing incremental cache (any call outside a Next.js request: vitest, scripts, the evals
//     harness) THROWS. The shared cache treats that as "store unavailable" and serves the direct
//     load, which is exactly the right behaviour outside Next.
//   · Past `revalidate`, an entry is served once more while it refreshes in the background. The
//     staleness bounds in shared-catalogue-cache.ts account for that.
//   · Every entry carries CATALOGUE_CACHE_TAG, so `revalidateTag` invalidates all of them at once.
//     On Vercel that is applied server-side for every instance (each instance's in-memory copy of
//     the fetch cache is reset at the end of every request); on the file-system cache the next read
//     is a miss. revalidateTag must be called inside a route handler or server action.
import { revalidateTag, unstable_cache } from 'next/cache';
import type { SharedCatalogueStore } from './shared-catalogue-cache';

/** The one tag on every shared catalogue entry (version probes and snapshots). */
export const CATALOGUE_CACHE_TAG = 'kids-fun:catalogue';

export const nextDataCacheStore: SharedCatalogueStore = {
  memo<T>(key: readonly string[], ttlMs: number, compute: () => Promise<T>): Promise<T> {
    // `revalidate` is whole seconds, and 0 is an invariant violation in unstable_cache.
    const revalidate = Math.max(1, Math.ceil(ttlMs / 1000));
    return unstable_cache(compute, [...key], { revalidate, tags: [CATALOGUE_CACHE_TAG] })();
  },
  async invalidate(): Promise<void> {
    revalidateTag(CATALOGUE_CACHE_TAG);
  },
};
