'use client';

// HomeTodayStrip — a small live "taste" of what's on now, for the front door (Screen 1
// payoff, D5). It calls the same /api/search the product uses (live DB rows in staging,
// fixture fallback otherwise), maps the response with the shared mappers, and shows up
// to three CONFIRMED cards — the same ActivityCard a parent scans in /search, each
// linking to its built /preview/[id] detail page.
//
// It is intentionally minimal (no filters, sort, or sticky chrome — that is /search's
// job) and fully defensive: on any error, or when there is nothing confirmed to show,
// it renders nothing so the front door is always complete without it.
//
// The ONE thing it does filter on is whether a row's age is actually known — see
// `isFrontDoorCandidate`. That is not a filter in the /search sense (there is still no chrome to
// change it, and no parent input feeds it); it is the minimum this surface needs to be honest,
// because it has nowhere to put the caveat /search prints instead.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { isAdultOrSeniorOnly } from '@/lib/search/filters/audience';
import { ActivityCard } from '../preview/_components/ActivityCard';
import { partitionSections } from '../preview/_data/filter';
import {
  mapSearchResponseToActivities,
  searchApiUrl,
  type SearchApiRequest,
  type SearchItemDto,
  type SearchResponseDto,
} from '../preview/_data/search-api';
import type { Activity } from '../preview/_data/types';

const MAX_CARDS = 3;

/**
 * How many rows to ask for so three cards can be PICKED from them.
 *
 * This is a candidate pool, not the render count, and it has to be: `frontDoorCards` below drops
 * every row whose age the source never stated, and that filter runs HERE rather than in the API
 * (see its header for why), so the response has to carry more rows than the strip will show.
 * Asking for exactly `MAX_CARDS` — which is what §9.1's X2 literally proposes — would have made
 * the strip go blank on the very data that motivated the fix: the four top-ranked confirmed rows
 * measured live on 2026-08-19 (Zumba, Step and Strength, Group Fitness: Strength and Core, Muay
 * Thai Kickboxing) ALL carry `ageMinMonths: null`, so a three-row response would have been
 * filtered to nothing.
 *
 * 8× the cards, chosen against the measured null rate: 41 of 100 sampled listings hold
 * (null, null) ages (docs/answer-before-search-design.md §1a, 2026-08-16), and only `confirmed`
 * and `bookable_open` reach the confirmed section at all — so roughly half a pool survives both
 * gates on today's data, and 24 rows leaves real headroom. It still cuts the payload by ~75%
 * against the old `limit=100` (165,596 bytes measured), which is all X2 was ever about.
 */
const CANDIDATE_LIMIT = MAX_CARDS * 8;

/**
 * What this strip asks /api/search for (docs/answer-before-search-design.md §9.1, X2 and X3).
 *
 * `minResults: 0` declines the broadening ladder: on a thin day `minResults=100` had the engine
 * relaxing constraints to fill a hundred-row page for a fixed teaser (§2c). Explicitly `0` and
 * not omitted — see `SearchApiRequest`.
 *
 * Exported so the request this strip actually sends is assertable (tests/preview-format.test.ts)
 * rather than only the builder's ability to accept an override — the values are the fix.
 */
export const STRIP_REQUEST: SearchApiRequest = { limit: CANDIDATE_LIMIT, minResults: 0 };

/**
 * Is this a row the FRONT DOOR may show, with no section heading and no caveat to carry it?
 *
 * THE DEFECT THIS CLOSES. Measured live on 2026-08-19, the top confirmed rows behind "On now
 * across Metro Vancouver" — on a page headed "See what's on for your kids today" — were Zumba,
 * Step and Strength, Group Fitness: Strength and Core and Muay Thai Kickboxing. None of them is
 * an `isAdultOrSeniorOnly` miss: "Zumba" carries no adult word, no adult-audience tag and no
 * open-ended high floor, so there is nothing for that filter to catch. What they all carry is
 * `ageMinMonths: null` with `ageNotes` beginning `unresolved:` — the source never said who the
 * programme is for, and nobody has resolved it since.
 *
 * `/search` shows those rows too, and that is fine THERE: it puts them under an explicit
 * `ageUnconfirmed` heading that says the age is unconfirmed. This strip has no heading, no
 * caveat and no room for one — three bare cards under a claim about kids. So the honest move on
 * this surface is to show only rows we can actually stand behind, and the /api/search default
 * for everyone else stays exactly as it is (that policy is not this component's to change).
 *
 * TWO GATES, and neither subsumes the other:
 *   1. `ageMinMonths == null` — "the source never stated an age". A genuinely resolved all-ages
 *      listing holds `0`, a real number, so all-ages content stays visible; only the true unknown
 *      is dropped. `ageMinMonths`/`ageMaxMonths` are what this DTO carries — `ageBandMatches` is
 *      not on it, so it is not an option here even though the engine has one.
 *   2. `isAdultOrSeniorOnly` — belt-and-suspenders, and REDUNDANT on today's data by design:
 *      `passesAllFilters` (lib/search/filters/predicate.ts:55) already applies it unconditionally
 *      to every row either backend returns, and tests/search/engine-registration-audience.test.ts
 *      pins that. It is asserted here anyway because this component does not otherwise depend on
 *      that upstream guarantee, and because gate 1 would not catch it: "Adult 19yrs+ Swim" is
 *      stored with `age_min_months = 0` (audience.ts's own note), so it clears gate 1 on a real
 *      number and is caught only by the title signal.
 */
function isFrontDoorCandidate(item: SearchItemDto): boolean {
  const { listing } = item;
  if (listing.ageMinMonths == null) return false;
  return !isAdultOrSeniorOnly(listing);
}

/**
 * Every card this strip is ALLOWED to show, in rank order and NOT yet capped — the gate on its
 * own, separated from the cap so each can be tested for what it actually does.
 *
 * That separation is not cosmetic. Asserting only on the capped list cannot distinguish "the
 * filter removed this row" from "the row ranked 4th anyway", so a test written against
 * `frontDoorCards` alone passes whether or not the gate exists. The gate's invariant lives here.
 *
 * Filtering happens on the RAW response, before `mapSearchResponseToActivities`: the mapped
 * `Activity` keeps `ageNotes` but drops the numeric `ageMinMonths`/`ageMaxMonths` that both gates
 * read. `ageUnconfirmed` is filtered by the same rule and therefore empties completely, which is
 * the correct reading of it rather than a special case — it is BY DEFINITION the section for rows
 * whose age the source never stated.
 */
export function frontDoorCandidates(body: SearchResponseDto): Activity[] {
  const vetted: SearchResponseDto = {
    ...body,
    results: (body.results ?? []).filter(isFrontDoorCandidate),
    expected: (body.expected ?? []).filter(isFrontDoorCandidate),
    ...(body.ageUnconfirmed ? { ageUnconfirmed: body.ageUnconfirmed.filter(isFrontDoorCandidate) } : {}),
  };
  return partitionSections(mapSearchResponseToActivities(vetted)).confirmed;
}

/**
 * The cards this strip renders — the candidates above, capped. One pure function over a response
 * so the whole selection is testable without a DOM (this repo has no jsdom; see vitest.config.ts).
 */
export function frontDoorCards(body: SearchResponseDto): Activity[] {
  return frontDoorCandidates(body).slice(0, MAX_CARDS);
}

export function HomeTodayStrip() {
  const [cards, setCards] = useState<Activity[]>([]);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(searchApiUrl(STRIP_REQUEST), { signal: controller.signal, headers: { accept: 'application/json' } })
      .then((res) => (res.ok ? (res.json() as Promise<SearchResponseDto>) : Promise.reject(new Error(String(res.status)))))
      .then((body) => {
        setCards(frontDoorCards(body));
      })
      .catch(() => {
        // Silent: the taste strip is optional. Never surface an error on the front door.
        if (!controller.signal.aborted) setCards([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSettled(true);
      });
    return () => controller.abort();
  }, []);

  // Render nothing until we have real confirmed cards to show.
  if (!settled || cards.length === 0) return null;

  return (
    <section className="kf-home__section" aria-labelledby="kf-home-today">
      <div className="kf-section__head">
        <h2 className="kf-section__title" id="kf-home-today">
          On now across Metro Vancouver
        </h2>
        <span className="kf-section__rule" aria-hidden="true" />
      </div>
      <p className="kf-home__note">A few confirmed listings on right now — the same source-checked cards you scan in search.</p>
      <div className="kf-home__today">
        {cards.map((a) => (
          <ActivityCard key={a.id} activity={a} />
        ))}
      </div>
      <Link className="kf-home__more" href="/search">
        See everything on now →
      </Link>
    </section>
  );
}
