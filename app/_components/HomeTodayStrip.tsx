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

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ActivityCard } from '../preview/_components/ActivityCard';
import { partitionSections } from '../preview/_data/filter';
import {
  mapSearchResponseToActivities,
  searchApiUrl,
  type SearchApiRequest,
  type SearchResponseDto,
} from '../preview/_data/search-api';
import type { Activity } from '../preview/_data/types';

const MAX_CARDS = 3;

/**
 * Ask for what this strip renders, and nothing more (docs/answer-before-search-design.md §9.1,
 * X2 and X3 — both pre-scoped there, neither touching what class of content the strip may show).
 *
 * `limit: MAX_CARDS` rather than a second literal 3, so the request cannot drift from the render.
 * `minResults: 0` declines the broadening ladder: on a thin day `minResults=100` had the engine
 * relaxing constraints to fill a hundred-row page for a fixed three-card teaser (§2c). Both are
 * about the REQUEST — nothing below changes about which cards qualify or about the strip
 * rendering nothing when none do.
 *
 * Exported so the request this strip actually sends is assertable (tests/preview-format.test.ts)
 * rather than only the builder's ability to accept an override — the values are the fix.
 */
export const STRIP_REQUEST: SearchApiRequest = { limit: MAX_CARDS, minResults: 0 };

export function HomeTodayStrip() {
  const [cards, setCards] = useState<Activity[]>([]);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(searchApiUrl(STRIP_REQUEST), { signal: controller.signal, headers: { accept: 'application/json' } })
      .then((res) => (res.ok ? (res.json() as Promise<SearchResponseDto>) : Promise.reject(new Error(String(res.status)))))
      .then((body) => {
        const { confirmed } = partitionSections(mapSearchResponseToActivities(body));
        setCards(confirmed.slice(0, MAX_CARDS));
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
