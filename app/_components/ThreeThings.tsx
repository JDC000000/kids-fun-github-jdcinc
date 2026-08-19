// ThreeThings — the front door's answer to a parent who has typed nothing (Track A,
// "answer before search"; Jon's rulings 2026-08-19, docs/answer-before-search-design.md §9.2).
//
// A SERVER COMPONENT that evaluates the search IN PROCESS. It calls `getServerSearchEngine()`
// (the seam /account's saved-search list already uses) rather than fetching /api/search from the
// browser, because the whole premise of the feature is that the answer is already there when the
// parent arrives — a client-hydrated version puts it one round trip behind the page it is meant
// to BE. That choice is what makes app/page.tsx dynamic; see the note there.
//
// It REPLACES app/_components/HomeTodayStrip.tsx, which fetched after hydration, showed the first
// three confirmed cards, and hid itself when it had nothing. This does not hide itself: three
// slots that each say what they are is a claim the page makes on purpose, so an unfillable slot
// says so (ruling 7.5) instead of silently shrinking the block to look complete.
//
// ── WHAT THIS FILE IS AND IS NOT RESPONSIBLE FOR ────────────────────────────────────────────
// All selection lives in lib/recommend/three-things.ts and is unit-tested there against a fixture
// engine. This file is glue and words: it wires the engine, supplies the default area, and turns
// slots into copy. Keeping the split at exactly that line is what lets the rules
// (`minResults: 0`, results-only, the front-door gates, the cross-slot de-dupe) be tested without
// a DOM — this repo has no jsdom (vitest.config.ts).

import Link from 'next/link';
import { getServerSearchEngine } from '@/lib/search/server-engine';
import {
  selectThreeThings,
  DEFAULT_NEARBY_RADIUS_KM,
  type SlotKey,
  type ThingSlot,
  type ThreeThingsOrigin,
} from '@/lib/recommend/three-things';
import { ActivityCard } from '../preview/_components/ActivityCard';
import { mapSearchItemToActivity } from '../preview/_data/search-api';

/**
 * Ruling 7.4's default area — downtown Vancouver, the same coordinate
 * docs/answer-before-search-design.md §2d measured from.
 *
 * A CONSTANT, NEVER A STORED VALUE. The privacy posture this product already runs on is that raw
 * coordinates are never persisted (`FORBIDDEN_KEYS` in app/search/_lib/anon-memory.ts, the
 * `FORBIDDEN_KEY_RE` in lib/profile/child-profile.ts). Nothing here reads or writes storage: the
 * point is a hard-coded default that every visitor gets identically, and the "change area"
 * affordance below hands the parent to /search, which owns location as a first-class control.
 *
 * The label is carried explicitly and is NOT the engine's own — `resolveOrigin`'s `near_me` mode
 * calls its result "Near me", a sentence about the reader that a cold page load cannot know.
 */
const DEFAULT_AREA: ThreeThingsOrigin = {
  geo: { lat: 49.2827, lng: -123.1207 },
  label: 'downtown Vancouver',
};

/**
 * What each slot promises, and what it says when it cannot keep the promise.
 *
 * THE LOCATION CLAIM BELONGS TO THE NEARBY SLOT ALONE (Jon's ruling, 2026-08-19). The indoor slot
 * is deliberately citywide — located, it measured EMPTY on the afternoon the ruling was made (2
 * cards within 5 km of downtown, both with no stated age) — so a heading that scoped the whole
 * block to "near downtown Vancouver" would be making a claim two of its three cards do not keep.
 * Only the nearby slot names the area, and it names it in its own label.
 */
const SLOT_COPY: Record<SlotKey, { label: string; empty: Record<string, string> }> = {
  free: {
    label: 'Something free',
    empty: {
      nothing_on: 'Nothing free is listed for today yet.',
      none_showable: 'We have free listings today, but none we can confirm is for children.',
    },
  },
  indoor: {
    label: 'Something indoors',
    empty: {
      nothing_on: 'Nothing indoor is on today — here’s what else.',
      none_showable: 'Today’s indoor listings don’t say who they’re for, so we’re not putting one here.',
    },
  },
  nearby: {
    label: `Something near ${DEFAULT_AREA.label}`,
    empty: {
      nothing_on: `Nothing is listed near ${DEFAULT_AREA.label} today.`,
      none_showable: `We have listings near ${DEFAULT_AREA.label} today, but none we can confirm is for children.`,
      no_origin: 'Pick an area to see what’s on near you.',
    },
  },
};

/** The `/search` URL each slot's "see them all" link points at — the same question, unfiltered. */
const SLOT_HREF: Record<SlotKey, string> = {
  free: '/search?free=1&when=today',
  indoor: '/search?rainy=1&when=today',
  nearby: `/search?when=today&lat=${DEFAULT_AREA.geo.lat}&lng=${DEFAULT_AREA.geo.lng}&radius=${DEFAULT_NEARBY_RADIUS_KM}&sort=distance`,
};

function SlotBlock({ slot }: { slot: ThingSlot }) {
  const copy = SLOT_COPY[slot.key];
  return (
    <li className="kf-three__slot">
      <p className="kf-three__slot-label">{copy.label}</p>
      {slot.state === 'filled' ? (
        <ActivityCard activity={mapSearchItemToActivity(slot.item)} />
      ) : (
        // AN HONEST EMPTY SLOT, NOT A HIDDEN ONE (ruling 7.5). The broadening ladder is never used
        // to fill this — see lib/recommend/three-things.ts, rule 1 — so what a parent reads here
        // is the truth about today rather than a relaxed version of the question.
        <p className="kf-three__slot-empty">
          {copy.empty[slot.reason] ?? copy.empty.nothing_on}{' '}
          <Link className="kf-three__slot-link" href={SLOT_HREF[slot.key]}>
            See what is on →
          </Link>
        </p>
      )}
    </li>
  );
}

export async function ThreeThings() {
  const engine = await getServerSearchEngine();

  // "WE COULD NOT CHECK" AND "THERE IS NOTHING" ARE DIFFERENT STATEMENTS, and server-engine.ts
  // returns null rather than an empty engine precisely so this caller cannot conflate them. On a
  // genuine load failure the block renders nothing at all and the front door stands without it —
  // the same posture the strip had, and the right one here too, because three slots all reading
  // "nothing today" would be an assertion about the catalogue that we have not earned.
  if (!engine) return null;

  const three = selectThreeThings({
    engine,
    now: new Date(),
    origin: DEFAULT_AREA,
    radiusKm: DEFAULT_NEARBY_RADIUS_KM,
    // NO AGE IS PASSED, deliberately. The child profile is on-device (localStorage), so a server
    // render cannot read it, and ruling 7.6 is that this surface may not claim "for your kid"
    // until an age is actually known. The pre-age framing below is the honest one; /search picks
    // the profile up on the client, where it exists.
  });

  const filled = three.slots.filter((s) => s.state === 'filled').length;

  return (
    <section className="kf-home__section kf-three" aria-labelledby="kf-three-heading">
      <div className="kf-section__head">
        <h2 className="kf-section__title" id="kf-three-heading">
          {/* Pre-age wording, per ruling 7.6: "on today near you", never "for your kid". */}
          Three things you could do today
        </h2>
        <span className="kf-section__rule" aria-hidden="true" />
      </div>
      <p className="kf-home__note">
        On today across Metro Vancouver — confirmed listings only, each with its source and
        last-checked date.
      </p>
      <ul className="kf-three__slots">
        {three.slots.map((slot) => (
          <SlotBlock key={slot.key} slot={slot} />
        ))}
      </ul>
      {filled > 0 ? (
        <Link className="kf-home__more" href="/search?when=today">
          See everything on today →
        </Link>
      ) : null}
    </section>
  );
}
