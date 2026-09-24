'use client';

import Link from './SearchLink';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Chip } from '@/components/ui';
import { hasNearMeCoords, hrefFor, type SearchState } from '../_lib/params';

// "Near me" is the one control that can't be a plain link: it needs the browser
// geolocation API (client-only). On success it writes the resolved coords into the URL
// (?lat&lng) and navigates, so from that point on the near-me search behaves like every
// other URL-driven filter — shareable, back-button-safe, re-runnable without re-prompting.
//
// Coords are rounded to ~11 m (4 dp) — enough for a 5/10/20 km radius, and we don't put a
// more precise location than necessary into a shareable URL. WCAG: 44 px target, focus
// ring, status announced in text (not colour only).

const COORD_DP = 4;
const round = (n: number): number => Number(n.toFixed(COORD_DP));

export function NearMeButton({ state }: { state: SearchState }) {
  const router = useRouter();
  const [status, setStatus] = useState<'idle' | 'locating' | 'error'>('idle');
  const active = hasNearMeCoords(state);

  function locate() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus('error');
      return;
    }
    setStatus('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setStatus('idle');
        // Browser near-me wins over any saved-location intent (mutually exclusive origins).
        router.push(
          hrefFor(state, {
            lat: round(pos.coords.latitude),
            lng: round(pos.coords.longitude),
            useSavedLocation: false,
          }),
        );
      },
      () => setStatus('error'),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  }

  if (active) {
    return (
      <>
        <Chip as="span" selected aria-current="true">
          Near you
        </Chip>
        <Chip as={Link} href={hrefFor(state, { lat: null, lng: null })} aria-label="Clear near-me location">
          Clear location
        </Chip>
      </>
    );
  }

  return (
    <>
      <Chip action onClick={locate} disabled={status === 'locating'} aria-busy={status === 'locating'}>
        <span aria-hidden="true">📍</span>
        {status === 'locating' ? 'Locating…' : 'Near me'}
      </Chip>
      {status === 'error' && (
        <span className="kf-fchip__hint" role="status">
          Couldn&apos;t get your location — pick an area instead.
        </span>
      )}
    </>
  );
}
