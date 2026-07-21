import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// BUG-007 (bug bash G-T39-3, Round 27): when no Mapbox key is configured, the map-view
// fallback literally printed the internal env-var name (NEXT_PUBLIC_MAP_KEY) to parents.
// The copy must stay plain and non-technical and never expose an env-var name.
//
// mapbox-gl touches `window` at import time, so it (and its CSS) are stubbed — the token=""
// fallback branch never constructs a map anyway.
vi.mock('mapbox-gl', () => ({
  default: { accessToken: '' },
  Map: class {},
  Marker: class {},
  Popup: class {},
  LngLatBounds: class {},
  NavigationControl: class {},
}));
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

import { ResultsMap } from '../../app/search/_components/ResultsMap';

describe('BUG-007: map fallback copy is non-technical', () => {
  const html = renderToStaticMarkup(<ResultsMap markers={[]} token="" />);

  it('never leaks an internal env-var name to users', () => {
    expect(html).not.toContain('NEXT_PUBLIC_MAP_KEY');
    expect(html).not.toContain('GEOCODING_API_KEY');
    expect(html).not.toMatch(/env[\s-]?var/i);
    expect(html).not.toContain('<code>');
  });

  it('still tells the parent every result is available in List view', () => {
    expect(html).toContain('List view');
  });
});
