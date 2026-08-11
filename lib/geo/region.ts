// lib/geo/region.ts — Region hierarchy chip logic (G-T18-3, BR-07/08, FR-06/07, TSD §5B).
//
// Metro Vancouver → Municipality → Sub-area, held as a `parent_id` tree. Area chips
// are MULTI-SELECT and additive (FR-07): selecting Vancouver includes its sub-areas
// (BR-08); two chips union their results. Radius ranking can still surface adjacent
// municipalities within distance even when not chip-selected (FR-06) — that lives in
// radius.ts and stays independent of these chips. Never a 30-item single-select (BR-07).

import type { GeoPoint } from '../search/types';
import { REGION_LABEL, type CoveredRegionId } from './postal-fsa';

export type RegionLevel = 'metro' | 'municipality' | 'sub_area';

/** One `region` row (TSD §6.1). */
export interface Region {
  id: string;
  name: string;
  level: RegionLevel;
  parentId: string | null;
  centroid: GeoPoint;
}

/**
 * The five region-chip slugs the product has always used in URLs, analytics and the
 * saved-postal path (`lib/geo/postal-fsa.ts` `CoveredRegionId`). Kept here as the ONE list this
 * module will translate, so no new alias vocabulary is invented — see `resolveChipId`.
 */
const COVERED_SLUGS = Object.keys(REGION_LABEL) as CoveredRegionId[];

/** Case/space-insensitive key for matching a region's real name. */
function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Region tree with descendant/ancestor resolution for chip logic. */
export class RegionHierarchy {
  private byId = new Map<string, Region>();
  private childrenOf = new Map<string, string[]>();
  /** Lazily built on first slug resolution — most searches never need it. */
  private byName: Map<string, string> | null = null;

  constructor(regions: Region[]) {
    for (const r of regions) {
      this.byId.set(r.id, r);
      if (r.parentId) {
        if (!this.childrenOf.has(r.parentId)) this.childrenOf.set(r.parentId, []);
        this.childrenOf.get(r.parentId)!.push(r.id);
      }
    }
  }

  get(id: string): Region | undefined {
    return this.byId.get(id);
  }

  /**
   * Translate a caller-supplied region-chip id into an id THIS hierarchy actually knows, or
   * null if it knows no such region.
   *
   * ────────────────────────────────────────────────────────────────────────────────────────
   * THE PROBLEM THIS SOLVES — one question, two answers, nothing asserting which wins.
   *
   * `region=` has always carried two incompatible id vocabularies depending on which backend
   * is mounted. In fixture mode the hierarchy is keyed by SLUGS ('van', 'bby'). In live
   * database mode it is keyed by the `region` table's UUIDs. And the slugs are not a naive
   * guess a user might make: they are an exported typed union (`CoveredRegionId`), they are
   * the documented example in this API's own doc comment, they are what the saved-postal path
   * (`regionIdForPostal`) produces, and they are what every REGION_CHIPS link in the rail puts
   * in the URL.
   *
   * So in database mode `region=van` resolved to a set containing the literal string 'van',
   * no listing was tagged 'van' (they carry UUIDs), and `matchesRegion` returned false for
   * EVERY listing — a search with real matching content returned zero. Not a narrowed result:
   * a total suppression, from a value the product itself emits.
   *
   * `lib/geo/postal-fsa.ts` already documented this exact hazard for the saved-home path and
   * routed around it. The search region filter had the same hazard, unguarded.
   *
   * ────────────────────────────────────────────────────────────────────────────────────────
   * HOW IT RESOLVES, in strict order:
   *   1. An id this hierarchy knows is returned unchanged. This is the common path in BOTH
   *      backends (slugs in fixture mode, UUIDs in database mode) and costs one map lookup.
   *   2. A known slug is translated via its real name (`REGION_LABEL`, the same labels the
   *      chips and the `region` table's `name` column share) to whatever id this hierarchy
   *      uses for that region. This deliberately reuses the two vocabularies that already
   *      exist rather than adding a third: no hard-coded UUIDs, no new alias table. If the
   *      live `region` table is ever renamed or reseeded, the lookup follows it.
   *   3. Anything else → null. Callers must treat that as "ignore this chip", NEVER as
   *      "match nothing" (see `matchesRegion`).
   */
  resolveChipId(chipId: string): string | null {
    if (this.byId.has(chipId)) return chipId;
    const label = REGION_LABEL[chipId as CoveredRegionId];
    if (!label) return null;
    if (this.byName == null) {
      this.byName = new Map<string, string>();
      for (const r of this.byId.values()) {
        // First writer wins, so a sub_area that happens to share a municipality's name can
        // never displace it; municipalities are what the five covered slugs denote.
        const key = nameKey(r.name);
        if (r.level === 'municipality' && !this.byName.has(key)) this.byName.set(key, r.id);
      }
    }
    return this.byName.get(nameKey(label)) ?? null;
  }

  /** The covered slugs this hierarchy can translate — diagnostics/tests, not a hot path. */
  static coveredSlugs(): CoveredRegionId[] {
    return [...COVERED_SLUGS];
  }

  centroid(id: string): GeoPoint | null {
    return this.byId.get(id)?.centroid ?? null;
  }

  /**
   * Every region at one level, ordered by name. Lets consumers derive the chip vocabulary
   * from the hierarchy itself — the area facet counts (lib/search/facets.ts) use this so the
   * rail's area options can come from the data rather than a hard-coded list in the UI.
   *
   * The ordering is this method's own, deliberately NOT the source's: the live `region`
   * query carries no ORDER BY, so row order there is whatever Postgres returns and could
   * differ between cache refreshes — which would silently reshuffle the area chips in front
   * of a parent. Sorted by name (id as tie-break) it is stable everywhere; a UI that wants a
   * different order (by size, by proximity) has the names and can impose its own.
   */
  atLevel(level: RegionLevel): Region[] {
    return [...this.byId.values()]
      .filter((r) => r.level === level)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /** A region id + all transitive descendants (Vancouver → its sub-areas). */
  descendantIds(id: string): string[] {
    const out: string[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      out.push(cur);
      for (const child of this.childrenOf.get(cur) ?? []) stack.push(child);
    }
    return out;
  }

  /**
   * Resolve selected chips (multi-select, additive) to the full set of region ids a
   * listing may be tagged to. Union of each chip's subtree (BR-08). Empty selection →
   * empty set (no region constraint).
   *
   * Chip ids are translated through `resolveChipId` first, so this is vocabulary-agnostic:
   * below this line exactly one id vocabulary exists — this hierarchy's own.
   */
  resolveSelectedIds(selectedChipIds: string[]): Set<string> {
    const out = new Set<string>();
    for (const chip of selectedChipIds) {
      const resolved = this.resolveChipId(chip);
      if (resolved == null) continue;
      for (const id of this.descendantIds(resolved)) out.add(id);
    }
    return out;
  }

  /**
   * The subset of `chipIds` this hierarchy recognises, translated to its own ids. Callers that
   * need to know whether a chip selection means anything (rather than just which listings it
   * admits) use this — e.g. to distinguish "no filter asked for" from "a filter was asked for
   * in a vocabulary we could not read".
   */
  knownChipIds(chipIds: string[]): string[] {
    const seen = new Set<string>();
    for (const chip of chipIds) {
      const resolved = this.resolveChipId(chip);
      if (resolved != null) seen.add(resolved);
    }
    return [...seen];
  }
}

/**
 * Region predicate for a listing given selected chips. A listing matches when any of
 * its region tags (municipality / neighbourhood / display area) is in the resolved set.
 * No chips selected → matches everything (region is a refinement, not a gate).
 *
 * AN UNRECOGNISED CHIP IS IGNORED, NEVER TREATED AS "MATCH NOTHING". This is the second half
 * of the region fix and it is load-bearing on its own. Slug translation (`resolveChipId`)
 * fixes the ids the product currently emits; this fixes everything else — a typo, a shared
 * link from a build with a different vocabulary, a municipality renamed in the `region` table,
 * a chip retired from the rail. Any of those previously produced an empty `allowed` set, which
 * `some()` turned into "no listing matches" and the page rendered as "Nothing matches your
 * search" — a data-shaped answer to what is really a "we did not understand that filter"
 * problem. Degrading to an unfiltered search is wrong in the permissive direction, which is
 * recoverable by the parent; suppressing everything is not.
 *
 * NOTE what this does NOT do: when at least one chip IS recognised, that filter applies in
 * full and non-matching listings are excluded normally. Ignoring unknown values is not the
 * same as disabling region filtering, and tests/geo/region-vocabulary.test.ts pins both halves
 * precisely so a future "simplification" to `return true` can't pass as this behaviour.
 */
export function matchesRegion(
  listingRegionTags: Array<string | null>,
  hierarchy: RegionHierarchy,
  selectedChipIds: string[],
): boolean {
  if (selectedChipIds.length === 0) return true;
  const allowed = hierarchy.resolveSelectedIds(selectedChipIds);
  // Nothing in the selection named a region this hierarchy knows → no constraint to apply.
  if (allowed.size === 0) return true;
  return listingRegionTags.some((t) => t != null && allowed.has(t));
}
