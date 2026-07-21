'use client';

// The interactive results surface: sticky date/area bar, scroll-snap filter chips,
// a transparent sort control (D6), the confirmed/expected split (D7), and the
// empty/broadening fork. Client-side because filtering/sorting the fixtures is
// instant local state on top of an API response. The API can be live-DB backed
// in staging and still falls back safely to fixtures when needed.

import { useEffect, useMemo, useState } from 'react';
import { ActivityCard } from './ActivityCard';
import { EmptyState } from './EmptyState';
import {
  BOOL_CHIPS,
  DEFAULT_FILTERS,
  RADIUS_OPTIONS,
  SORT_OPTIONS,
  TIME_OF_DAY_OPTIONS,
  activeFilterCount,
  applyFilters,
  partitionSections,
  sortActivities,
  sortSentence,
  type BoolChipKey,
  type FilterState,
  type SortKey,
} from '../_data/filter';
import { mapSearchResponseToActivities, searchApiUrl, type SearchResponseDto } from '../_data/search-api';
import type { Activity, TimeOfDay } from '../_data/types';

function Section({ title, note, items }: { title: string; note?: string; items: Activity[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <div className="kf-section__head">
        <h2 className="kf-section__title">{title}</h2>
        <span className="kf-section__count">{items.length}</span>
        <span className="kf-section__rule" aria-hidden="true" />
      </div>
      {note && <p className="kf-section__note">{note}</p>}
      {items.map((a) => (
        <ActivityCard key={a.id} activity={a} />
      ))}
    </section>
  );
}

function sourceNote(body: SearchResponseDto): string {
  if (body.meta.backend === 'database' && !body.meta.fixtureBacked) {
    return 'Data source: live staging database — approved public sources only.';
  }
  if (body.meta.fallbackReason) {
    return `Data source: fixture fallback — ${body.meta.fallbackReason}.`;
  }
  return 'Data source: fixture-backed /api/search.';
}

export function ResultsShell() {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortKey>('best_match');
  const [sortOpen, setSortOpen] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataSourceNote, setDataSourceNote] = useState('Data source: loading /api/search…');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(searchApiUrl(), { signal: controller.signal, headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Search API returned ${res.status}`);
        const body = (await res.json()) as SearchResponseDto;
        setActivities(mapSearchResponseToActivities(body));
        setDataSourceNote(sourceNote(body));
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setDataSourceNote('Data source: unavailable — cards could not load.');
        setActivities([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const { confirmed, expected, total } = useMemo(() => {
    const matched = applyFilters(activities, filters);
    const parts = partitionSections(matched);
    return {
      confirmed: sortActivities(parts.confirmed, sort),
      expected: sortActivities(parts.expected, sort),
      total: matched.length,
    };
  }, [activities, filters, sort]);

  const toggleBool = (key: BoolChipKey) => setFilters((f) => ({ ...f, [key]: !f[key] }));
  const setTimeOfDay = (t: TimeOfDay | 'any') =>
    setFilters((f) => ({ ...f, timeOfDay: f.timeOfDay === t ? 'any' : t }));
  const setRadius = (radiusKm: FilterState['radiusKm']) => setFilters((f) => ({ ...f, radiusKm }));
  const clearFilters = () => setFilters(DEFAULT_FILTERS);
  const widenRadius = () =>
    setFilters((f) => ({ ...f, radiusKm: f.radiusKm === 5 ? 10 : 20 }));

  const activeCount = activeFilterCount(filters);
  const confirmedCount = confirmed.length;
  const expectedCount = expected.length;

  return (
    <>
      {/* Sticky date + area bar — the two things a parent changes most (Elevation 200). */}
      <div className="kf-sticky">
        <div className="kf-dateArea">
          <div className="kf-control" role="group" aria-label="Date: Today">
            <span>
              <span className="kf-control__label">When</span>
              <span className="kf-control__value">Today</span>
            </span>
            <span className="kf-control__caret" aria-hidden="true">
              ▾
            </span>
          </div>
          <div className="kf-control" role="group" aria-label={`Area: Metro Vancouver, within ${filters.radiusKm} km`}>
            <span>
              <span className="kf-control__label">Where</span>
              <span className="kf-control__value">Metro Van · {filters.radiusKm} km</span>
            </span>
            <span className="kf-control__caret" aria-hidden="true">
              ▾
            </span>
          </div>
        </div>

        <div className="kf-radius" role="group" aria-label="Travel radius">
          <span className="kf-radius__label">Within</span>
          {RADIUS_OPTIONS.map((km) => (
            <button
              key={km}
              type="button"
              className="kf-seg"
              aria-pressed={filters.radiusKm === km}
              onClick={() => setRadius(km)}
            >
              {km} km
            </button>
          ))}
        </div>

        {/* Scroll-snap filter chips — pinned INSIDE the sticky filter bar so the
            live filters stay reachable after the first results load. Bug fix: this
            chip row used to be a non-sticky sibling of .kf-sticky, so once a parent
            scrolled into their first set of results it scrolled off-screen and never
            came back. The only controls left pinned were the display-only date/area
            stubs (see README "Not yet wired") + the radius — so changing search
            criteria appeared to do nothing. Keeping the chips in the sticky cluster
            makes every live filter reachable while browsing. Selected = fill AND
            checkmark, never colour alone. */}
        <div className="kf-chips kf-chips--filters" role="group" aria-label="Quick filters">
          {BOOL_CHIPS.map(({ key, label }) => {
            const on = filters[key];
            return (
              <button key={key} type="button" className="kf-chip" aria-pressed={on} onClick={() => toggleBool(key)}>
                {on && (
                  <span className="kf-chip__check" aria-hidden="true">
                    ✓
                  </span>
                )}
                {label}
              </button>
            );
          })}
          {TIME_OF_DAY_OPTIONS.filter((t) => t.key !== 'any').map((t) => {
            const on = filters.timeOfDay === t.key;
            return (
              <button
                key={t.key}
                type="button"
                className="kf-chip"
                aria-pressed={on}
                onClick={() => setTimeOfDay(t.key)}
              >
                {on && (
                  <span className="kf-chip__check" aria-hidden="true">
                    ✓
                  </span>
                )}
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="kf-results">
        {/* Transparent sort (D6) — an explainable ranking, not magic. */}
        <div className="kf-sort">
          <p className="kf-sort__text" aria-live="polite">
            {total > 0 ? (
              <>
                <b>
                  {confirmedCount} confirmed
                  {expectedCount > 0 ? ` · ${expectedCount} expected` : ''}
                </b>{' '}
                — sorted by {SORT_OPTIONS.find((o) => o.key === sort)?.label.toLowerCase()}: {sortSentence(sort)}.
              </>
            ) : (
              <>No matches for this combination{activeCount > 0 ? ` (${activeCount} filters on)` : ''}.</>
            )}
          </p>
          {total > 0 && (
            <button
              type="button"
              className="kf-sort__change"
              aria-expanded={sortOpen}
              onClick={() => setSortOpen((o) => !o)}
            >
              Change
            </button>
          )}
        </div>

        {sortOpen && total > 0 && (
          <div className="kf-chips" role="group" aria-label="Sort by" style={{ padding: '0 0 8px' }}>
            {SORT_OPTIONS.map((o) => (
              <button
                key={o.key}
                type="button"
                className="kf-chip"
                aria-pressed={sort === o.key}
                onClick={() => {
                  setSort(o.key);
                  setSortOpen(false);
                }}
              >
                {sort === o.key && (
                  <span className="kf-chip__check" aria-hidden="true">
                    ✓
                  </span>
                )}
                {o.label}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <div className="kf-empty" aria-live="polite">
            <p className="kf-empty__eyebrow">Loading search…</p>
            <h2 className="kf-empty__title">Getting today’s cards.</h2>
            <p className="kf-empty__copy">This is using /api/search, with live database rows when available.</p>
          </div>
        ) : error ? (
          <div className="kf-empty" role="alert">
            <p className="kf-empty__eyebrow">Search API issue</p>
            <h2 className="kf-empty__title">Couldn’t load activities.</h2>
            <p className="kf-empty__copy">{error}</p>
          </div>
        ) : total === 0 ? (
          <EmptyState
            radiusKm={filters.radiusKm}
            canWiden={filters.radiusKm < 20}
            hasActiveFilters={activeCount > 0}
            onWidenRadius={widenRadius}
            onClearFilters={clearFilters}
          />
        ) : (
          <>
            <p className="kf-section__note">{dataSourceNote}</p>
            <Section title="Confirmed from approved sources" items={confirmed} />
            <Section
              title="Expected / not yet posted"
              note="Kept separate from confirmed — we never blur the two. Recheck dates and seasonal notes are on each card."
              items={expected}
            />
          </>
        )}
      </div>
    </>
  );
}
