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
import { mapSearchResponseToActivities, searchApiUrl, type SearchResponseDto } from '../preview/_data/search-api';
import type { Activity } from '../preview/_data/types';

const MAX_CARDS = 3;

export function HomeTodayStrip() {
  const [cards, setCards] = useState<Activity[]>([]);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(searchApiUrl(), { signal: controller.signal, headers: { accept: 'application/json' } })
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
