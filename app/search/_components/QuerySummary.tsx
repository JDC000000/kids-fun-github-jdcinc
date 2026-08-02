import Link from 'next/link';
import { hrefFor, type SearchState } from '../_lib/params';
import type { AppliedFilterToken } from '../_lib/filter-summary';

/**
 * QuerySummary — "here is exactly what you are looking at", in one line.
 *
 * This is the one idea worth keeping from Proposal B (the composer-bar concept the desktop
 * scope decision otherwise set aside): state the query in plain language rather than making
 * a parent reverse-engineer it from which chips happen to be filled in. Grafted onto the
 * rail rather than built as its own surface.
 *
 * It replaces three separate things at once, which is most of the "consolidate the header
 * block" half of the chrome cleanup:
 *   • the results count line,
 *   • the "Sorted by …" line,
 *   • the "Filtered by a · b · c. Clear filters" line.
 *
 * IT DOUBLES AS THE APPLIED-FILTER ROW. Each stated filter is a link that removes exactly
 * that one constraint — so the line is not just a readout, it is the fastest way to undo a
 * filter without hunting for its chip in the rail. The tokens come from
 * `filter-summary.appliedFilterTokens`, the SAME derivation the mobile sticky bar's summary
 * uses, so the phone and the desktop can never disagree about what is applied. The pattern
 * was designed for the phone (where the sheet hides the chips entirely) and adopted here —
 * that direction of travel is deliberate.
 *
 * IT ALSO CARRIES THE PAGE'S <h1>. The /search hero band that used to hold it was a
 * duplicate of the home page's, restating the value proposition to someone who has already
 * bought in, at a measured 193px above the results (audit Quick Win #7). Deleting it without
 * moving the h1 somewhere real would have left the page headingless, so the h1 became the
 * thing a parent actually wants at the top of a results page: their own query.
 */

export interface QuerySummaryProps {
  state: SearchState;
  /** Applied constraints, each with the patch that removes just itself. */
  tokens: AppliedFilterToken[];
  confirmed: number;
  expected: number;
  /**
   * Sort NAME, e.g. "Best match" (SORT_OPTIONS[].label). The long `sentence` form the old
   * three-line header used ("confirmed first, then closest and soonest for your kids") is
   * the wrong length for a line whose whole job is to be scannable in one glance; the sort
   * control itself still carries the full explanation.
   */
  sortLabel: string;
  /** URL that clears every filter while keeping the query and sort. */
  clearHref: string;
  /**
   * False when the search itself failed. The counts are then unknown, not zero — printing
   * "0 confirmed" over a network error would be the page inventing a fact about the
   * catalogue, which is the one thing this product's honesty framing rules out.
   */
  countsKnown?: boolean;
}

export function QuerySummary({
  state,
  tokens,
  confirmed,
  expected,
  sortLabel,
  clearHref,
  countsKnown = true,
}: QuerySummaryProps) {
  const query = state.q.trim();
  // "across Metro Vancouver" is the honest default scope — but it stops being true the
  // moment a parent narrows to an area or a radius, so it is dropped rather than restated.
  const scoped = tokens.some((t) => t.scope === 'where');

  return (
    <div className="kf-qsum">
      <div className="kf-qsum__line">
        <h1 className="kf-qsum__title">
          {query ? <>“{query}”</> : <>Everything on now</>}
          {!scoped && <span className="kf-qsum__scope"> across Metro Vancouver</span>}
        </h1>

        {tokens.length > 0 && (
          <>
            <ul className="kf-qsum__tokens" aria-label="Applied filters">
              {tokens.map((token) => (
                <li key={token.key}>
                  {/* A real <Link>, like every other filter control on this page: the URL is
                      the state, so removing a filter is a navigation and stays shareable and
                      back-button-safe. The accessible name says what the link DOES; the ✕ is
                      decorative, because "Ages 5–9 ✕" read aloud is not an instruction. */}
                  <Link
                    className="kf-qsum__tok"
                    href={hrefFor(state, token.clear)}
                    aria-label={`Remove filter: ${token.label}`}
                  >
                    {token.label}
                    <span className="kf-qsum__tok-x" aria-hidden="true">
                      ✕
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <Link className="kf-qsum__clear" href={clearHref}>
              Clear all
            </Link>
          </>
        )}
      </div>

      {/* Counts and sort, in one line instead of three. `role="status"` so a parent using a
          screen reader hears the new result count after a filter navigation without having to
          go looking for it. Confirmed and expected stay separately named — never blurred. */}
      {countsKnown && (
        <p className="kf-qsum__meta" role="status">
          <b>{confirmed}</b> confirmed
          {expected > 0 && (
            <>
              {' · '}
              <b>{expected}</b> expected
            </>
          )}
          {sortLabel && <span className="kf-qsum__sort"> · sorted by {sortLabel.toLowerCase()}</span>}
        </p>
      )}
    </div>
  );
}
