// The /search links the front door's "three things" block offers, as data.
//
// SPLIT OUT OF ThreeThings.tsx FOR TWO REASONS, and the second is the load-bearing one.
//
//   1. They are a table, not rendering. Everything else in that component is markup.
//   2. ThreeThings is an ASYNC server component, so a test that wants to check these URLs
//      cannot import it — `renderToStaticMarkup` throws on a promise child, and a test that
//      stubs the module (tests/nav-destinations.test.tsx has to) would get the stub back
//      instead of the real values. Kept here, the links stay assertable BY THE REAL VALUES
//      whatever the component is doing, which is what makes that file's compensating check
//      worth anything.
//
// WHY EVERY ONE OF THEM CARRIES `when=today`. app/_lib/nav-destinations.ts (Track B) made the
// home page stop carrying byte-identical copies of global-nav links — "Free things to do" left
// the quick-start row because `/search?free=1` is already one tap away from every page. These
// are deliberately NOT that: each is scoped to today, which is the block's entire subject, and
// each is the escape hatch for the slot it belongs to rather than standing on its own as
// navigation. The nav's `/search?free=1` means "show me free things". This block's
// `/search?free=1&when=today` means "there is nothing free on today — here is the rest of
// today". The distinction is pinned in tests/nav-destinations.test.tsx.

import { DEFAULT_NEARBY_RADIUS_KM, type SlotKey } from '@/lib/recommend/three-things';

/** Ruling 7.4's default area — downtown Vancouver. Also `docs/answer-before-search-design.md` §2d's. */
export const DEFAULT_AREA_GEO = { lat: 49.2827, lng: -123.1207 } as const;

/** How the surface may NAME that place. Never "near me": a cold page load cannot know that. */
export const DEFAULT_AREA_LABEL = 'downtown Vancouver';

/** Per slot: the same question this slot asked, unfiltered, for a parent who wants the rest. */
export const SLOT_HREF: Record<SlotKey, string> = {
  free: '/search?free=1&when=today',
  indoor: '/search?rainy=1&when=today',
  nearby: `/search?when=today&lat=${DEFAULT_AREA_GEO.lat}&lng=${DEFAULT_AREA_GEO.lng}&radius=${DEFAULT_NEARBY_RADIUS_KM}&sort=distance`,
};

/** The block's footer link — everything on today, no slot constraint. */
export const HOME_TODAY_HREF = '/search?when=today';
