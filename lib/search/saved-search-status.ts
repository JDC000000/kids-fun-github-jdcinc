// lib/search/saved-search-status.ts — run ONE saved search against the live engine and,
// when it matches nothing, name the constraint that emptied it.
//
// WHY THIS IS SHARED. There were two empty-state policies and nothing asserting which one
// wins. /search always climbs the broadening ladder and prints the engine's explanation
// (app/search/page.tsx). The weekly digest disables broadening — correctly, an email must
// not pad itself with non-matches — and, because broadening and explaining were the same
// condition in the engine, it also never computed the explanation: a saved search that
// matched nothing was silently dropped and the parent was told nothing. The engine now
// separates the two (lib/search/engine.ts), and this module is the shared half that turns
// its explanation into something a surface can show, so the email and /account can never
// describe the same saved search differently again.
//
// PURE — it takes an already-wired SearchEngine and does no DB/network of its own, the same
// contract lib/email/digest.ts keeps, so both stay unit-testable against the fixture engine.

import type { SearchEngine, SearchRequest, SearchResponse } from './engine';
import { CONSTRAINT_LABELS, type ConstraintKey } from './broaden';
import type { OriginRequest } from '../geo/origin';
import { parseSearchState, intentPhrases } from '@/app/search/_lib/params';

/** Next.js searchParams shape parseSearchState expects. */
type RawParams = Record<string, string | string[] | undefined>;

/**
 * Coerce a stored saved-search params envelope (values may be any JSON) into the clean
 * URL-param strings `parseSearchState` expects. Exported because any surface that wants to
 * DESCRIBE a saved search has to read it through the same parser that EXECUTES it — that is
 * what stops a row's summary from outliving the behaviour it claims.
 */
export function savedSearchRawParams(params: Record<string, unknown>): RawParams {
  const out: RawParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    // objects/arrays/null are ignored — not part of the /search URL contract.
  }
  return out;
}

/**
 * Turn a saved search's stored params into a SearchRequest (mirrors app/search apiQuery
 * intent). Uses the SAME pure helpers /search uses (parseSearchState + intentPhrases), so
 * what a saved search means here can never drift from what it means on the page.
 */
export function savedSearchRequest(
  params: Record<string, unknown>,
  homePostal: string | null,
  now: Date,
): { request: SearchRequest; query: string } {
  const state = parseSearchState(savedSearchRawParams(params));
  const query = [state.q, ...intentPhrases(state)].filter(Boolean).join(' ').trim();

  // The only durable origin a saved search can carry is the saved-location intent
  // (home=1). Raw near-me coordinates are never persisted (Task B privacy rule), so
  // there is nothing else to resolve. saved_home requires signedIn=true in
  // resolveOrigin; a saved search is inherently for a known, signed-up user.
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
      minResults: 0, // never broaden — a saved search's answer must be its genuine matches
      limit: 100, // generous; callers narrow further (e.g. the digest's "new since" filter)
    },
  };
}

/** Why a saved search currently matches nothing. */
export interface SavedSearchEmptyState {
  /** The single constraint whose removal would unlock results, per the engine's own probe. */
  blockingConstraint: ConstraintKey | null;
  /** That constraint's human label, e.g. "price limit", "time of day". Null when none unlocks. */
  blockingLabel: string | null;
}

export interface SavedSearchRun {
  /** The composed query text the engine actually ran (text + intent phrases). */
  query: string;
  response: SearchResponse;
  /** PRIMARY matches, un-broadened and before any caller-side narrowing. */
  matchCount: number;
  /**
   * Present ONLY when the saved search matched nothing at all. A search with matches that
   * a caller then narrows to nothing (the digest's "new since last email" filter) is NOT
   * blocked by a constraint, and naming one there would be false.
   */
  emptyState: SavedSearchEmptyState | null;
}

/** Run one saved search and report its match count plus, if zero, the blocking constraint. */
export function runSavedSearch(
  engine: SearchEngine,
  params: Record<string, unknown>,
  homePostal: string | null,
  now: Date,
): SavedSearchRun {
  const { request, query } = savedSearchRequest(params, homePostal, now);
  const response = engine.search(request);
  const matchCount = response.total;

  let emptyState: SavedSearchEmptyState | null = null;
  if (matchCount === 0) {
    const blockingConstraint = response.broadening.emptyState?.blockingConstraint ?? null;
    emptyState = {
      blockingConstraint,
      blockingLabel: blockingConstraint != null ? CONSTRAINT_LABELS[blockingConstraint] : null,
    };
  }

  return { query, response, matchCount, emptyState };
}

/**
 * The one short factual line a surface shows for an empty saved search. Deliberately plain:
 * it states what the engine measured (relaxing this one constraint would return results),
 * not product voice. Shared so the email and /account cannot word the same fact differently.
 */
export function emptyStateSentence(blockingLabel: string | null): string {
  return blockingLabel
    ? `No matches right now — removing the ${blockingLabel} would show results.`
    : 'No matches right now — relaxing any single filter still shows none.';
}
