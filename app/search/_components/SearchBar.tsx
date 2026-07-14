import Link from 'next/link';
import { SORT_OPTIONS, hrefFor, type SearchState } from '../_lib/params';

// The primary, always-visible search control (Blueprint Screen 1/2, UXR-01). A plain
// GET <form> so a parent can type and search with zero client JavaScript; sort and the
// unknown-cost toggle are tap-to-change chip links that preserve the rest of the state.
// Everything is URL-driven, so a search is shareable and back-button-safe.

export function SearchBar({ state }: { state: SearchState }) {
  return (
    <div className="kf-sbar">
      <form className="kf-sbar__form" action="/search" method="get" role="search">
        <div className="kf-sbar__field">
          <label className="kf-sbar__label" htmlFor="kf-q">
            What are you looking for?
          </label>
          <input
            id="kf-q"
            className="kf-sbar__input"
            type="search"
            name="q"
            defaultValue={state.q}
            placeholder="open gym, family swim, storytime…"
            autoComplete="off"
            enterKeyHint="search"
            aria-label="Search kids' activities"
          />
        </div>
        {/* Preserve current sort / cost choice when submitting a new query. */}
        <input type="hidden" name="sort" value={state.sort} />
        <input type="hidden" name="includeUnknownCost" value={state.includeUnknownCost ? '1' : '0'} />
        <button className="kf-sbar__submit" type="submit">
          Search
        </button>
      </form>

      <div className="kf-sbar__controls" role="group" aria-label="Sort and cost options">
        <span className="kf-sbar__controls-label">Sort</span>
        {SORT_OPTIONS.map((opt) => {
          const active = state.sort === opt.key;
          return (
            <Link
              key={opt.key}
              className="kf-sbar__chip"
              href={hrefFor(state, { sort: opt.key })}
              aria-current={active ? 'true' : undefined}
            >
              {active && (
                <span className="kf-sbar__check" aria-hidden="true">
                  ✓
                </span>
              )}
              {opt.label}
            </Link>
          );
        })}
        <Link
          className="kf-sbar__chip"
          href={hrefFor(state, { includeUnknownCost: !state.includeUnknownCost })}
          aria-pressed={state.includeUnknownCost}
        >
          {state.includeUnknownCost && (
            <span className="kf-sbar__check" aria-hidden="true">
              ✓
            </span>
          )}
          Include unknown cost
        </Link>
      </div>
    </div>
  );
}
