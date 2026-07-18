import Link from 'next/link';
import { Button, Input } from '@/components/ui';
import { SORT_OPTIONS, hiddenStateFields, hrefFor, type SearchState } from '../_lib/params';

// The primary, always-visible search control (Blueprint Screen 1/2, UXR-01). A plain
// GET <form> so a parent can type and search with zero client JavaScript; sort and the
// unknown-cost toggle are tap-to-change chip links that preserve the rest of the state.
// Everything is URL-driven, so a search is shareable and back-button-safe.

export function SearchBar({ state }: { state: SearchState }) {
  // Carry the active filter state (areas/when/ages/quick filters/near-me/sort/cost) through
  // a new text search so typing a query never silently drops the filters already applied.
  const carried = hiddenStateFields(state);
  return (
    <div className="kf-sbar">
      <form className="kf-sbar__form" action="/search" method="get" role="search">
        <div className="kf-sbar__field">
          <label className="kf-sbar__label" htmlFor="kf-q">
            What are you looking for?
          </label>
          <Input
            id="kf-q"
            type="search"
            name="q"
            defaultValue={state.q}
            placeholder="open gym, family swim, storytime…"
            autoComplete="off"
            enterKeyHint="search"
            aria-label="Search kids' activities"
          />
        </div>
        {/* Preserve every active filter (sort, cost, areas, when, ages, quick filters, near-me)
            when submitting a new query — derived from the same URL serialization as the chips. */}
        {carried.map((field) => (
          <input key={field.name} type="hidden" name={field.name} value={field.value} />
        ))}
        {/* The shared components/ui Button (Leaf fill + Forest-ink text, D10) owns the visual
            styling; .kf-sbar__submit is layout-only (bottom-aligns it with the input). */}
        <Button variant="primary" type="submit" className="kf-sbar__submit">
          Search
        </Button>
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
