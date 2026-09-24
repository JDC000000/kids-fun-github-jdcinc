import Link from './SearchLink';
import { Button, Chip, Input } from '@/components/ui';
import { SORT_OPTIONS, hiddenStateFields, hrefFor, type SearchState } from '../_lib/params';

// The primary, always-visible search control (Blueprint Screen 1/2, UXR-01). A plain
// GET <form> so a parent can type and search with zero client JavaScript; the sort options are
// tap-to-change chip links that preserve the rest of the state.
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

      {/* Sort only. The "Include unknown cost" toggle that used to sit at the end of this row is
          GONE (Jon's beta feedback): unknown-cost listings are always included now, so there is
          nothing left to opt into. Removing the chip was the easy half — the behaviour is
          enforced in lib/search/filters/cost.ts, because merely deleting the control would have
          stopped the param being sent and the API's opposite default would then have started
          EXCLUDING those listings. "Recently added" is likewise gone from the sort set
          (params.ts SORT_OPTIONS). */}
      <div className="kf-sbar__controls" role="group" aria-label="Sort options">
        <span className="kf-sbar__controls-label">Sort</span>
        {/* Each sort option is a real <a> link (role="link"), so selection is conveyed with
            aria-current="true" — the only selected-state attribute ARIA allows on a link.
            (aria-pressed is button-only and is invalid on an anchor: axe aria-allowed-attr
            / WCAG 4.1.2 — fixed in Round 18.) Fill + ✓ owned by the chip. */}
        {SORT_OPTIONS.map((opt) => {
          const active = state.sort === opt.key;
          return (
            <Chip
              key={opt.key}
              as={Link}
              size="sm"
              href={hrefFor(state, { sort: opt.key })}
              selected={active}
              aria-current={active ? 'true' : undefined}
            >
              {opt.label}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}
