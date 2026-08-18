'use client';

// Map view for /search results (Task 37). Client-only: dynamically mounted by
// SearchResultsView so mapbox-gl (and its CSS) never load until a parent opens Map view.
// Markers come straight from the rendered result set (see _lib/markers.ts) — no second
// fetch — and each plots the real coordinate already enriched onto the listing (Task 36).
//
// Token: a PUBLIC Mapbox token (pk.*) is safe in the browser by design; the server
// component resolves it (NEXT_PUBLIC_MAP_KEY, falling back to the verified-public
// geocoding key) and passes it in. A secret (sk.*) token must NEVER reach this file.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap, Marker as MapboxMarker } from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { SearchMarker } from '../_lib/markers';

interface ResultsMapProps {
  markers: SearchMarker[];
  token: string;
}

/** Metro Vancouver — the fallback view when there are no markers to fit to. */
const METRO_VAN_CENTER: [number, number] = [-123.05, 49.23];

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string
  );
}

export function ResultsMap({ markers, token }: ResultsMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!token || !container) return;

    let disposed = false;
    const prefersDark =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

    mapboxgl.accessToken = token;

    let map: MapboxMap;
    try {
      map = new mapboxgl.Map({
        container,
        style: prefersDark ? 'mapbox://styles/mapbox/dark-v11' : 'mapbox://styles/mapbox/light-v11',
        center: METRO_VAN_CENTER,
        zoom: 10,
        cooperativeGestures: true, // don't hijack page scroll on touch
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Map failed to start.');
      return;
    }

    map.on('error', (ev) => {
      if (disposed) return;
      // The common failure is an invalid token or one lacking the maps/tiles scope (401).
      setError('Map tiles could not load — the map key may be missing the right Mapbox scope.');
      // eslint-disable-next-line no-console
      console.warn('[kf-map]', ev?.error?.message ?? ev);
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

    const created: MapboxMarker[] = [];
    const bounds = new mapboxgl.LngLatBounds();

    for (const m of markers) {
      const el = document.createElement('button');
      el.type = 'button';
      // Three sections, three pin treatments — the map must not flatten a distinction the list
      // makes. `--expected` is outlined ("might not be happening"); `--age-unconfirmed` is its
      // own class ("we don't know who it's for"), never folded into the same outline.
      el.className =
        'kf-map__pin' +
        (m.section === 'expected'
          ? ' kf-map__pin--expected'
          : m.section === 'age_unconfirmed'
            ? ' kf-map__pin--age-unconfirmed'
            : '');
      const sectionNote =
        m.section === 'expected'
          ? ' — expected, not yet posted'
          : m.section === 'age_unconfirmed'
            ? ' — age not stated by source'
            : '';
      el.setAttribute('aria-label', `${m.name} at ${m.venue}, ${m.area}${sectionNote}`);

      const popup = new mapboxgl.Popup({ offset: 18, closeButton: true, maxWidth: '260px' }).setHTML(
        `<a class="kf-map__pop" href="/preview/${encodeURIComponent(m.id)}" data-kf-preview="${escapeHtml(m.id)}">` +
          `<span class="kf-map__pop-name">${escapeHtml(m.name)}</span>` +
          `<span class="kf-map__pop-venue">${escapeHtml(m.venue)}</span>` +
          `<span class="kf-map__pop-area">${escapeHtml(m.area)}</span>` +
          `<span class="kf-map__pop-cta">View details →</span>` +
          `</a>`
      );
      // Upgrade the anchor to client-side navigation once the popup is in the DOM; the
      // plain href stays as a no-JS-safe fallback.
      popup.on('open', () => {
        const link = popup.getElement()?.querySelector<HTMLAnchorElement>('[data-kf-preview]');
        link?.addEventListener('click', (clickEv) => {
          clickEv.preventDefault();
          router.push(`/preview/${m.id}`);
        });
      });

      const marker = new mapboxgl.Marker(el).setLngLat([m.lng, m.lat]).setPopup(popup).addTo(map);
      created.push(marker);
      bounds.extend([m.lng, m.lat]);
    }

    if (markers.length === 1) {
      map.setCenter([markers[0].lng, markers[0].lat]);
      map.setZoom(13);
    } else if (markers.length > 1) {
      map.fitBounds(bounds, { padding: 56, maxZoom: 14, duration: 0 });
    }

    return () => {
      disposed = true;
      created.forEach((mk) => mk.remove());
      map.remove();
    };
  }, [markers, token, router]);

  if (!token) {
    // BUG-007: keep this copy plain and non-technical — never surface an internal
    // env-var name (e.g. NEXT_PUBLIC_MAP_KEY) to a parent. The map is simply
    // unavailable here; List view still has every result.
    return (
      <div className="kf-map kf-map--fallback" role="note">
        <p className="kf-map__fallback-title">Map view isn’t available right now.</p>
        <p className="kf-map__fallback-body">
          Every result is still here — switch back to List view.
        </p>
      </div>
    );
  }

  return (
    <div className="kf-map">
      <div ref={containerRef} className="kf-map__canvas" role="region" aria-label="Map of search results" />
      {error && (
        <div className="kf-map__error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
