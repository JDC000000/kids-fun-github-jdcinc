// app/_lib/nav-destinations.ts — the ONE list of places KIDS FUN says it can take you.
//
// WHY THIS EXISTS
// The same set of destinations was maintained by hand in two places — SiteNav's `LINKS`
// and the home page's `CATEGORIES` — and the two had already drifted apart in three
// measurable ways before this file was written:
//   • "Classes" (nav) vs "Classes & programs" (home) for the identical query.
//   • `/search?q=family+swim` (nav) vs `/search?q=family%20swim` (home) — the same search,
//     two different URLs, so they cache, share and analyse as two destinations.
//   • "Festivals" was on the home page and NOT in the nav. SiteNav carried a
//     `DEAD_CATEGORY = '/search?q=festival'` filter meant to enforce that, but its own
//     `LINKS` never contained that href, so the filter removed nothing — the exclusion was
//     real only on the surface that happened to be written last.
// Two hand-maintained lists cannot be kept in step by care. One list can.
//
// WHY FESTIVALS IS DATA RATHER THAN DELETED
// `festivals` stays in this list with `status: 'retired'`. Deleting it would make the
// exclusion invisible again: the next person to add a tile has nothing telling them the
// query is dead, and nothing to test. As data, it is (a) filtered out of every surface by
// the one `status` check, and (b) checkable — tests/nav-destinations.test.tsx runs a REAL
// search for every entry here and fails if a retired destination starts returning results
// (it should come back) or a live one stops returning them (it should not be offered).
// The query returned 6 real listings on 2026-07-14 and returns none today; that is a data
// regression tracked elsewhere, not a decision to drop the category.
//
// SCOPE: this file owns the shared VOCABULARY (label, caption, glyph, href) of the
// destinations. It deliberately does NOT own how any surface lays them out — SiteNav
// renders a text row, the home page renders glyph tiles, and both read the same entries.
import type { Category } from '@/app/preview/_data/types';

/**
 * `live` — offered to visitors on every surface.
 * `retired` — kept as data so the exclusion is enforceable and testable, rendered nowhere.
 */
export type DestinationStatus = 'live' | 'retired';

export interface CategoryDestination {
  /** Stable id for keys and tests; never shown to a visitor. */
  key: string;
  /** The one label every surface uses. Changing it here changes it everywhere, by design. */
  label: string;
  /**
   * Home-page tile caption. Describes the KIND OF ACTIVITY only — never which sources it
   * comes from. Some sources named in docs/source-register.md are staged off, so a caption
   * like "from city rec calendars" would claim coverage the product does not have.
   */
  caption: string;
  /** Illustration-system glyph (D4); matches how /search renders the same rows. */
  glyph: Category;
  /**
   * The free-text query behind the destination. `/search` has no structured category
   * param — free text is the only category mechanism it actually supports.
   */
  query: string;
  status: DestinationStatus;
}

export const CATEGORY_DESTINATIONS: readonly CategoryDestination[] = [
  {
    key: 'swimming',
    label: 'Swimming',
    caption: 'Family and public swim times',
    glyph: 'swim',
    query: 'family swim',
    status: 'live',
  },
  {
    key: 'storytime',
    label: 'Storytime',
    caption: 'Storytimes and early-years sessions',
    glyph: 'storytime',
    query: 'storytime',
    status: 'live',
  },
  {
    key: 'indoor-play',
    label: 'Indoor play',
    caption: 'Soft play and indoor playgrounds',
    glyph: 'indoor_play',
    query: 'soft play',
    status: 'live',
  },
  {
    key: 'classes',
    label: 'Classes',
    caption: 'Classes and registered programs',
    glyph: 'museum_arts',
    query: 'program',
    status: 'live',
  },
  {
    // Rendered nowhere while retired — see the header note. Kept so the exclusion is one
    // flag on one list instead of an omission repeated (and forgotten) per surface.
    key: 'festivals',
    label: 'Festivals',
    caption: 'Community festivals and events',
    glyph: 'festival',
    query: 'festival',
    status: 'retired',
  },
];

/** The destinations any surface may render. The ONLY sanctioned way to read the list. */
export function liveCategoryDestinations(): CategoryDestination[] {
  return CATEGORY_DESTINATIONS.filter((d) => d.status === 'live');
}

/**
 * ONE encoding for a destination URL, so the same search is the same string everywhere.
 * `URLSearchParams` (space → `+`) is the encoding `/search`'s own param layer already
 * emits (app/search/_lib/params.ts), so a tile href and a search the page builds itself
 * are byte-identical rather than `%20`/`+` variants of each other.
 */
export function destinationHref(destination: CategoryDestination): string {
  return `/search?${new URLSearchParams({ q: destination.query }).toString()}`;
}

/**
 * Shortcuts that MODIFY a search rather than name a place. They are deliberately a
 * different kind of thing from a destination — no glyph, no tile — because a parent
 * reading a row of them is answering "what constraint am I under?", not "where do I want
 * to go?". Keeping them in the same list as the categories is what produced the home
 * page's duplicate pills in the first place.
 */
export interface SearchShortcut {
  key: string;
  label: string;
  href: string;
}

export const SEARCH_SHORTCUTS: Record<'onNow' | 'free' | 'rainy', SearchShortcut> = {
  /** Structural: /search with nothing applied. The nav's one non-query destination. */
  onNow: { key: 'on-now', label: 'What’s on now', href: '/search' },
  /**
   * Lives in the global nav and NOWHERE else. It is the only route to the free filter from
   * most pages, so it stays in the nav; a second copy on the home page was a byte-identical
   * duplicate of this link and was removed rather than kept in sync.
   */
  free: { key: 'free', label: 'Free', href: '/search?free=1' },
  rainy: { key: 'rainy', label: 'Rainy-day and indoor', href: '/search?rainy=1' },
};

/**
 * The home page's "Quick starts" row: search CONSTRAINTS, not categories.
 *
 * Just one today, and that is the honest size of it. The row used to carry three, two of
 * which were byte-identical duplicates of nav links ("Free things to do" → `/search?free=1`,
 * "Browse everything on now" → `/search`), which made it read as a second, worse copy of the
 * navigation. `when=weekend` is the obvious next member and is deliberately absent: it is
 * non-empty against the fixture catalogue at the pinned test clock, but nobody has confirmed
 * it is non-empty on live data, and shipping an unverified shortcut is the exact failure this
 * unit exists to remove.
 */
export const QUICK_START_FILTERS: readonly SearchShortcut[] = [SEARCH_SHORTCUTS.rainy];
