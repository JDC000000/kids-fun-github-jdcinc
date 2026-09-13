// ThreeThings — the front door's PROOF BLOCK: a sample of what the weekly text looks like.
//
// ═══ WHAT IT IS (Track A, "answer before search"; Jon's rulings 2026-08-19) ═══
// A SERVER COMPONENT that evaluates the search IN PROCESS. It calls `getServerSearchEngine()`
// (the seam /account's saved-search list already used) rather than fetching /api/search from the
// browser, because the whole premise of the feature is that the answer is already there when the
// parent arrives — a client-hydrated version puts it one round trip behind the page it is meant
// to BE. That choice is what makes app/page.tsx dynamic; see the note there.
//
// It does not hide itself: three slots that each say what they are is a claim the page makes on
// purpose, so an unfillable slot says so (ruling 7.5) instead of silently shrinking the block to
// look complete.
//
// ═══ WHAT CHANGED IN M2, AND WHY THE FRAMING IS LOAD-BEARING (TSD v1.2 §6.3, T2.6) ═══
// The home page is now 90% SMS offer and 10% search (Jon: "it should heavily promote SMS. this
// will be 90% of it"). THREE ACTIVITY CARDS ARE VISUALLY SUBSTANTIAL, so the same component
// lands on either side of that ratio depending on one heading:
//
//   "Three things you could do today" + tappable cards  →  reads as SEARCH CONTENT, and spends
//                                                          the entire 10% budget on its own.
//   "A sample of what your weekly text looks like"      →  reads as SMS PROOF, inside the 90%.
//
// So the heading changed, and the RENDERING changed with it, because a heading alone would not
// have held: a grid of bordered, tappable cards is a results list whatever it is called.
//
// ═══ ★ THE BLOCK IS NON-INTERACTIVE — LOCKED AT GATE G1 (Operator ruling, Q1) ═══
// No card anchors, no per-slot "see what is on" links, no "see everything on today" footer into
// /search. It renders a MESSAGE THREAD: sender, timestamp, a lead-in bubble, and the picks as
// entries inside one bubble separated by hairlines. One bubble rather than three cards is the
// point — cards imply tappability and a bubble does not, so "non-interactive" reads as
// intentional rather than broken. The framing is STRUCTURAL rather than editorial for the same
// reason: a heading can be edited back to "browse activities" in one commit; a rendered SMS
// thread cannot. The design carries the decision so re-introducing a link looks wrong rather
// than looking finished, and home.css backs it with a guard rule.
//
// CONSEQUENCE FOR app/_components/three-things-links.ts: `SLOT_HREF` and `HOME_TODAY_HREF` are
// no longer rendered by this component. They are deliberately NOT deleted — they are the record
// of a decision (every escape hatch was scoped to `when=today` so it could not be a byte-identical
// duplicate of a global-nav link), and tests/nav-destinations.test.tsx still asserts that property
// so it survives if the Q1 ruling is ever revisited. `DEFAULT_AREA_GEO`/`DEFAULT_AREA_LABEL` are
// still consumed here.
//
// ── WHAT THIS FILE IS AND IS NOT RESPONSIBLE FOR ────────────────────────────────────────────
// All selection lives in lib/recommend/three-things.ts and is unit-tested there against a fixture
// engine. THAT FILE IS OUT OF SCOPE FOR THIS MILESTONE and is untouched — two other open KIDS FUN
// workstreams (adult-content exclusion, picks diversity) edit it, so what this block DISPLAYS
// will change under them. This file is glue and words: it wires the engine, supplies the default
// area, and turns slots into copy. Keeping the split at exactly that line is what lets the rules
// (`minResults: 0`, results-only, the front-door gates, the cross-slot de-dupe) be tested without
// a DOM — this repo has no jsdom (vitest.config.ts).

import { getServerSearchEngine } from '@/lib/search/server-engine';
import {
  selectThreeThings,
  DEFAULT_NEARBY_RADIUS_KM,
  type SlotKey,
  type ThingSlot,
  type ThreeThingsOrigin,
} from '@/lib/recommend/three-things';
import { FreshnessStamp } from '../preview/_components/FreshnessStamp';
import { formatCardAges, formatCost, formatWhen } from '../preview/_data/format';
import { mapSearchItemToActivity } from '../preview/_data/search-api';
import type { Activity } from '../preview/_data/types';
import { DEFAULT_AREA_GEO, DEFAULT_AREA_LABEL } from './three-things-links';

/**
 * Ruling 7.4's default area — downtown Vancouver, the same coordinate
 * docs/answer-before-search-design.md §2d measured from.
 *
 * A CONSTANT, NEVER A STORED VALUE. The privacy posture this product already runs on is that raw
 * coordinates are never persisted (`FORBIDDEN_KEYS` in app/search/_lib/anon-memory.ts, the
 * `FORBIDDEN_KEY_RE` in lib/profile/child-profile.ts). Nothing here reads or writes storage: the
 * point is a hard-coded default that every visitor gets identically.
 *
 * The label is carried explicitly and is NOT the engine's own — `resolveOrigin`'s `near_me` mode
 * calls its result "Near me", a sentence about the reader that a cold page load cannot know.
 */
const DEFAULT_AREA: ThreeThingsOrigin = { geo: DEFAULT_AREA_GEO, label: DEFAULT_AREA_LABEL };

/**
 * What each slot promises, and what it says when it cannot keep the promise.
 *
 * THE LOCATION CLAIM BELONGS TO THE NEARBY SLOT ALONE (Jon's ruling, 2026-08-19). The indoor slot
 * is deliberately citywide — located, it measured EMPTY on the afternoon the ruling was made (2
 * cards within 5 km of downtown, both with no stated age) — so a heading that scoped the whole
 * block to "near downtown Vancouver" would be making a claim two of its three cards do not keep.
 * Only the nearby slot names the area, and it names it in its own label.
 *
 * THE EMPTY COPY NO LONGER CARRIES AN ESCAPE-HATCH LINK (Q1, above). The sentence is the whole
 * statement now, which is why each one still says WHICH KIND of nothing it found: "nothing free
 * is listed" and "we have free listings but none we can confirm is for children" are different
 * facts about today, and without a link to click the words have to carry all of it.
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
      nothing_on: 'Nothing indoor is listed for today yet.',
      none_showable: 'Today’s indoor listings don’t say who they’re for, so we’re not putting one here.',
    },
  },
  nearby: {
    label: `Something near ${DEFAULT_AREA_LABEL}`,
    empty: {
      nothing_on: `Nothing is listed near ${DEFAULT_AREA_LABEL} today.`,
      none_showable: `We have listings near ${DEFAULT_AREA_LABEL} today, but none we can confirm is for children.`,
      no_origin: 'Pick an area to see what’s on near you.',
    },
  },
};

/**
 * The one-line practical summary a text message would carry: when, who for, what it costs, where.
 *
 * BUILT FROM THE PRODUCT'S OWN FORMATTERS, not from re-derived strings. `formatWhen`,
 * `formatCardAges` and `formatCost` are the same functions every ActivityCard on /search renders
 * through, so a listing reads identically here and there — including the hard-won cases those
 * functions own (a multi-day span never printing as a one-day event, a collapsed group's cost
 * never printing as one session's price, ages that vary by session saying so).
 *
 * Empty parts are dropped rather than printed as blanks, so a listing with no stated area does
 * not render a dangling separator.
 */
function practicalLine(activity: Activity): string {
  const when = formatWhen(activity.startIso, activity.endIso, activity.openHoursLabel);
  return [when.day, when.time, formatCardAges(activity), formatCost(activity), activity.area]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/**
 * One entry in the thread's picks bubble. A `<div>` of `<p>`s and NOTHING ELSE — see the Q1
 * ruling in this file's header. There is no anchor here, and there is no stretched-link
 * ::after either: the absence of an affordance IS the design.
 */
function PickEntry({ slot }: { slot: ThingSlot }) {
  const copy = SLOT_COPY[slot.key];

  if (slot.state !== 'filled') {
    // AN HONEST EMPTY SLOT, NOT A HIDDEN ONE (ruling 7.5). The broadening ladder is never used to
    // fill this — see lib/recommend/three-things.ts, rule 1 — so what a parent reads is the truth
    // about today rather than a relaxed version of the question. It keeps its place in the list
    // because the block claims three things, so it has to account for three.
    return (
      <div className="kf-home__pick kf-home__pick--empty">
        <p className="kf-home__pick-slot">{copy.label}</p>
        <p className="kf-home__pick-title">{copy.empty[slot.reason] ?? copy.empty.nothing_on}</p>
      </div>
    );
  }

  const activity = mapSearchItemToActivity(slot.item);
  return (
    <div className="kf-home__pick">
      <p className="kf-home__pick-slot">{copy.label}</p>
      <p className="kf-home__pick-title">
        {activity.activityName}
        {activity.venue ? ` — ${activity.venue}` : ''}
      </p>
      <p className="kf-home__pick-meta">{practicalLine(activity)}</p>
      {/* The product's signature component, reused rather than re-drawn: status + icon + source
          + last-checked, never colour-only. It is what makes this a sample of OUR text rather
          than a generic list, and it is the one thing a parent is asked to trust. */}
      <p className="kf-home__pick-prov">
        <FreshnessStamp activity={activity} />
      </p>
    </div>
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
    // the profile up on the client, where it exists — and, since M2, /search is also where the
    // profile is CAPTURED (app/page.tsx no longer renders ChildProfilePrompt).
  });

  return (
    <section className="kf-home__proof" aria-labelledby="kf-home-proof">
      <div className="kf-home__proof-inner">
        <h2 className="kf-home__h2" id="kf-home-proof">
          A sample of what your weekly text looks like
        </h2>
        <p className="kf-home__note">
          Three real activities on today across Metro Vancouver — the same kind of thing your
          Friday text contains, each with its source and when we last checked it.
        </p>

        {/* A `<figure>`, because this IS a figure: an illustrative specimen of the product,
            captioned by the heading above it. `role="group"` + a label so a screen reader is
            told what the thread is before it reads three activities out of context.
            ⚠ home.css zeroes the UA `<figure>` margin. Left alone it is 40px each side, which
            silently narrowed this frame by 80px and wrapped every pick title. */}
        <figure
          className="kf-home__msg"
          role="group"
          aria-label="Example of a weekly KIDS FUN text message"
        >
          <div className="kf-home__msg-chrome">
            <span className="kf-home__msg-avatar" aria-hidden="true">
              KF
            </span>
            <span>
              <span className="kf-home__msg-from">KIDS FUN</span>
              <span className="kf-home__msg-when">Friday, 7:30 am</span>
            </span>
          </div>
          <p className="kf-home__msg-bubble">
            Here’s your week. Three things on today near you —
          </p>
          <div className="kf-home__msg-list">
            {three.slots.map((slot) => (
              <PickEntry key={slot.key} slot={slot} />
            ))}
          </div>
        </figure>
      </div>
    </section>
  );
}
