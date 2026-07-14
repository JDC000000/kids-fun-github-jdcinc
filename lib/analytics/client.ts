// lib/analytics/client.ts — fire-and-forget browser event helper.
//
// Posts a typed event to /api/analytics/event without blocking the UI. Uses
// navigator.sendBeacon when available (survives page unload), else a keepalive
// fetch. It is BEST-EFFORT: every failure is swallowed so analytics can never
// break a parent's flow. Not wired into a component in this first slice (the
// proof-of-concept `listing_viewed` event is recorded server-side), but this is
// the intended caller for future client-side events (search, outbound click).
'use client';

import type { AnalyticsEventType } from './types';

export interface TrackEventPayload {
  occurrenceId?: string;
  sourceId?: string;
  searchContext?: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
}

const ENDPOINT = '/api/analytics/event';

/** Fire an analytics event from the browser. Returns immediately; never throws. */
export function trackEvent(eventType: AnalyticsEventType, payload: TrackEventPayload = {}): void {
  try {
    if (typeof window === 'undefined') return;
    const body = JSON.stringify({ eventType, ...payload });

    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(ENDPOINT, blob);
      return;
    }

    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      /* best-effort: ignore network failures */
    });
  } catch {
    /* best-effort: analytics must never break the UI */
  }
}
