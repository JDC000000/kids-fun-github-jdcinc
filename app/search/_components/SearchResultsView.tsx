'use client';

// List/Map view toggle for /search (Task 37). The server-rendered result list is passed
// in as `children`, so with JavaScript disabled the list still renders (default view) and
// the toggle simply does nothing — no blank screen, no lost results. The map is loaded
// lazily (next/dynamic, ssr:false) only when a parent switches to Map view, keeping
// mapbox-gl out of the initial /search payload.

import dynamic from 'next/dynamic';
import { useState, type ReactNode } from 'react';
import { Chip } from '@/components/ui';
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
      {/* List/Map view toggle. The segmented on-state is the shared Chip primitive:
          Forest-ink on Leaf (7.61:1, both schemes) — replaces the old white-on-Leaf
          .kf-viewtoggle__btn--on, which was 2.17:1 and failed WCAG AA. aria-pressed
          selection semantics + keyboard behaviour are unchanged. */}
      <div className="kf-viewtoggle" role="group" aria-label="Choose how to view results">
        <Chip
          variant="segmented"
          selected={view === 'list'}
          aria-pressed={view === 'list'}
          onClick={() => setView('list')}
        >
          <span className="kf-viewtoggle__glyph" aria-hidden="true">
            ▤
          </span>
          List
        </Chip>
        <Chip
          variant="segmented"
          selected={view === 'map'}
          aria-pressed={view === 'map'}
          onClick={() => setView('map')}
        >
          <span className="kf-viewtoggle__glyph" aria-hidden="true">
            ◉
          </span>
          Map
        </Chip>
      </div>

      {/* Reserve the map's vertical footprint the moment Map view mounts — the SAME box the
          real Mapbox canvas fills (see .kf-map__canvas: 62vh, clamped 340–560px). Without this,
          switching from a long result list to the compact map (or its "not available" fallback /
          loading state) collapses the page height by thousands of pixels; the browser then clamps
          the scroll offset and drops the parent into the middle of the filter rail, half-hidden
          behind the tall sticky search bar — the reported "blank gap + missing filter pills" on
          List→Map. Reserving the footprint keeps the page height stable, so the toggle no longer
          yanks the scroll (and it removes the layout shift when a real map key IS configured). */}
      {view === 'map' ? (
        <div className="kf-map-region" style={{ minHeight: 'clamp(340px, 62vh, 560px)' }}>
          <p className="kf-map__note">{noteText}</p>
          <ResultsMap markers={markers} token={token} />
        </div>
      ) : (
        children
      )}
    </>
  );
}
