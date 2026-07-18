// lib/email/digest.ts — build the weekly-digest DATA model for one user.
//
// This is the heart of the feature and is deliberately PURE over its inputs: given
// a wired SearchEngine, the user's saved searches, and the set of occurrence ids
// that are NEW since the user's last email, it produces the digest with no DB or
// network access. That makes it exhaustively unit-testable against the fixture
// engine, and lets the DB glue (lib/email/weekly.ts) own all the I/O.
//
// Matching REUSES the real search pipeline (SearchEngine) rather than
// re-implementing matching in SQL — so what a parent gets in the digest is exactly
// what they'd get on /search. Each saved search's stored `params` (the /search URL
// shape, Task B) is turned back into a SearchRequest with the SAME pure helpers the
// page uses (parseSearchState + intentPhrases), so the two can never drift.
//
// "New/upcoming since last email": the engine's DB read model only returns
// non-expired occurrences (postgres-repository visibleOccurrenceWhereSql), so every
// candidate is already UPCOMING; we then keep only those whose occurrence id is in
// `newOccurrenceIds` (created since the watermark), i.e. genuinely NEW since we last
// wrote. Broadening is disabled (minResults: 0) so the digest never pads itself with
// non-matching "expected/seasonal" suggestions — only real matches.
import type { SearchEngine, SearchRequest } from '@/lib/search/engine';
import type { ListingRecord } from '@/lib/search/types';
import type { OriginRequest } from '@/lib/geo/origin';
import { parseSearchState, intentPhrases, hrefForParams } from '@/app/search/_lib/params';
import { appUrl } from './config';
import { formatWhen, formatCost, savedSearchLabel } from './format';

export const DEFAULT_PER_SEARCH_LIMIT = 6;

/** A saved search as consumed by the digest (unwrapped envelope). */
export interface DigestSavedSearch {
  id: string;
  name: string | null;
  params: Record<string, unknown>;
}

/** One matching activity as it appears in the email. */
export interface DigestActivity {
  id: string;
  seriesId: string;
  name: string;
  venue: string;
  when: string;
  cost: string;
  url: string;
}

/** One saved search's block in the digest (only present when it has new matches). */
export interface DigestSection {
  savedSearchId: string;
  label: string;
  searchUrl: string;
  activities: DigestActivity[];
}

/** The full per-user digest data model. */
export interface WeeklyDigest {
  userId: string;
  sections: DigestSection[];
  totalActivities: number;
  /** True iff there is at least one new matching activity worth emailing. */
  shouldSend: boolean;
}

export interface BuildDigestInput {
  userId: string;
  engine: SearchEngine;
  savedSearches: DigestSavedSearch[];
  /** The signed-in user's saved home postal, for saved-location ("home=1") searches. */
  homePostal: string | null;
  now: Date;
  /** Occurrence ids created since this user's last email (the "new" set). */
  newOccurrenceIds: Set<string>;
  perSearchLimit?: number;
}

/** Next.js searchParams shape parseSearchState expects. */
type RawParams = Record<string, string | string[] | undefined>;

/** Coerce a stored params envelope (values may be any JSON) into clean URL-param strings. */
function toRawParams(params: Record<string, unknown>): RawParams {
  const out: RawParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    // objects/arrays/null are ignored — not part of the /search URL contract.
  }
  return out;
}

/** Turn a saved search's stored params into a SearchRequest (mirrors app/search apiQuery intent). */
function savedSearchToRequest(
  params: Record<string, unknown>,
  homePostal: string | null,
  now: Date
): { request: SearchRequest; query: string } {
  const state = parseSearchState(toRawParams(params));
  const query = [state.q, ...intentPhrases(state)].filter(Boolean).join(' ').trim();

  // The only durable origin a saved search can carry is the saved-location intent
  // (home=1). Raw near-me coordinates are never persisted (Task B privacy rule), so
  // there is nothing else to resolve. saved_home requires signedIn=true in
  // resolveOrigin; the digest is inherently for a known, signed-up user.
  const origin: OriginRequest | null =
    state.useSavedLocation && homePostal ? { mode: 'saved_home', homePostal } : null;

  return {
    query,
    request: {
      q: query,
      now,
      origin,
      signedIn: origin != null,
      regionChipIds: state.regions,
      sort: state.sort,
      includeUnknownCost: state.includeUnknownCost,
      minResults: 0, // never broaden — a digest must contain only genuine matches
      limit: 100, // generous; we filter to "new" and cap per-search below
    },
  };
}

/** Start-time key for soonest-first ordering; open-hours / undated sort last. */
function startKey(l: ListingRecord): number {
  if (l.openHours || !l.startDatetimeUtc) return Number.POSITIVE_INFINITY;
  const t = new Date(l.startDatetimeUtc).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** Keep the soonest upcoming occurrence per series, so a weekly series is one row, not five. */
function dedupeSoonestPerSeries(listings: ListingRecord[]): ListingRecord[] {
  const sorted = [...listings].sort((a, b) => startKey(a) - startKey(b));
  const seen = new Set<string>();
  const out: ListingRecord[] = [];
  for (const l of sorted) {
    if (seen.has(l.seriesId)) continue;
    seen.add(l.seriesId);
    out.push(l);
  }
  return out;
}

function toActivity(listing: ListingRecord): DigestActivity {
  return {
    id: listing.id,
    seriesId: listing.seriesId,
    name: listing.activityName,
    venue: listing.venueName,
    when: formatWhen(listing),
    cost: formatCost(listing),
    url: appUrl(`/preview/${encodeURIComponent(listing.id)}`),
  };
}

/**
 * Build the weekly digest for one user. Pure: no DB/network. Sections with no new
 * matches are omitted; `shouldSend` is false when nothing new matches any saved
 * search (the caller must NOT send — and must NOT advance the watermark — in that
 * case, so nothing new is missed next week).
 */
export function buildWeeklyDigest(input: BuildDigestInput): WeeklyDigest {
  const perSearchLimit = input.perSearchLimit ?? DEFAULT_PER_SEARCH_LIMIT;
  const sections: DigestSection[] = [];

  for (const ss of input.savedSearches) {
    const { request, query } = savedSearchToRequest(ss.params, input.homePostal, input.now);
    const response = input.engine.search(request);

    const fresh = response.results
      .map((r) => r.listing)
      .filter((l) => input.newOccurrenceIds.has(l.id));

    const deduped = dedupeSoonestPerSeries(fresh).slice(0, perSearchLimit);
    if (deduped.length === 0) continue; // no empty sections

    sections.push({
      savedSearchId: ss.id,
      label: savedSearchLabel(ss.name, query),
      searchUrl: appUrl(hrefForParams(ss.params)),
      activities: deduped.map(toActivity),
    });
  }

  const totalActivities = sections.reduce((n, s) => n + s.activities.length, 0);
  return {
    userId: input.userId,
    sections,
    totalActivities,
    shouldSend: totalActivities > 0,
  };
}
