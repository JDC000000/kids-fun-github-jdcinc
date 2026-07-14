// tests/analytics/client.test.ts — browser trackEvent is fire-and-forget + safe.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { trackEvent } from '../../lib/analytics/client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('trackEvent (browser helper)', () => {
  it('uses navigator.sendBeacon when available', () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { sendBeacon });
    vi.stubGlobal('Blob', class {});

    trackEvent('listing_viewed', { occurrenceId: '11111111-1111-1111-1111-111111111111' });

    expect(sendBeacon).toHaveBeenCalledOnce();
    expect(sendBeacon.mock.calls[0][0]).toBe('/api/analytics/event');
  });

  it('falls back to a keepalive fetch when sendBeacon is absent', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', fetchMock);

    trackEvent('search_performed', { searchContext: { q: 'swim' } });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/analytics/event');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
  });

  it('never throws even if the transport blows up', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {
      sendBeacon: () => {
        throw new Error('boom');
      },
    });
    vi.stubGlobal('Blob', class {});
    expect(() => trackEvent('outbound_source_click')).not.toThrow();
  });

  it('is a no-op server-side (no window)', () => {
    vi.stubGlobal('window', undefined);
    expect(() => trackEvent('listing_viewed')).not.toThrow();
  });
});
