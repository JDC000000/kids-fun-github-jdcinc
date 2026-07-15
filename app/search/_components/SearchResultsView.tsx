'use client';

// List/Map view toggle for /search (Task 37). The server-rendered result list is passed
// in as `children`, so with JavaScript disabled the list still renders (default view) and
// the toggle simply does nothing — no blank screen, no lost results. The map is loaded
// lazily (next/dynamic, ssr:false) only when a parent switches to Map view, keeping
// mapbox-gl out of the initial /search payload.

import dynamic from 'next/dynamic';
import { useState, type ReactNode } from 'react';
import type { SearchMarker } from '../_lib/markers';

const ResultsMap = dynamic(() => import('./ResultsMap').then((m) => m.ResultsMap), {
  ssr: false,
  loading: () => (
    <div className="kf-map kf-map--loading" role="status">
      Loading map…
    </div>
  ),
});

interface SearchResultsViewProps {
  markers: SearchMarker[];
  token: string;
  totalResults: number;
  children: ReactNode;
}

export function SearchResultsView({ markers, token, totalResults, children }: SearchResultsViewProps) {
  const [view, setView] = useState<'list' | 'map'>('list');

  const mapped = markers.length;
  const noteText =
    mapped === 0
      ? 'None of these results has a mapped location yet — switch to List to see them all.'
      : `Showing ${mapped} of ${totalResults} result${totalResults === 1 ? '' : 's'} with a mapped location. ` +
        'Confirmed pins are solid; expected pins are outlined.';

  return (
    <>
      <div className="kf-viewtoggle" role="group" aria-label="Choose how to view results">
        <button
          type="button"
          className={`kf-viewtoggle__btn${view === 'list' ? ' kf-viewtoggle__btn--on' : ''}`}
          aria-pressed={view === 'list'}
          onClick={() => setView('list')}
        >
          <span className="kf-viewtoggle__glyph" aria-hidden="true">
            ▤
          </span>
          List
        </button>
        <button
          type="button"
          className={`kf-viewtoggle__btn${view === 'map' ? ' kf-viewtoggle__btn--on' : ''}`}
          aria-pressed={view === 'map'}
          onClick={() => setView('map')}
        >
          <span className="kf-viewtoggle__glyph" aria-hidden="true">
            ◉
          </span>
          Map
        </button>
      </div>

      {view === 'map' ? (
        <div>
          <p className="kf-map__note">{noteText}</p>
          <ResultsMap markers={markers} token={token} />
        </div>
      ) : (
        children
      )}
    </>
  );
}
