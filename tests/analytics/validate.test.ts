// tests/analytics/validate.test.ts — request-body validation for analytics events.
import { describe, it, expect } from 'vitest';
import { parseAnalyticsEventBody } from '../../lib/analytics/validate';
import { MAX_JSON_FIELD_BYTES } from '../../lib/analytics/types';

const UUID = '11111111-1111-1111-1111-111111111111';

describe('parseAnalyticsEventBody', () => {
  it('accepts a well-formed listing_viewed event', () => {
    const r = parseAnalyticsEventBody({ eventType: 'listing_viewed', occurrenceId: UUID });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.eventType).toBe('listing_viewed');
      expect(r.value.occurrenceId).toBe(UUID);
    }
  });

  it('accepts snake_case keys too', () => {
    const r = parseAnalyticsEventBody({ event_type: 'search_performed', search_context_json: { q: 'swim' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.searchContext).toEqual({ q: 'swim' });
  });

  it('rejects a non-object body', () => {
    expect(parseAnalyticsEventBody('nope').ok).toBe(false);
    expect(parseAnalyticsEventBody(null).ok).toBe(false);
    expect(parseAnalyticsEventBody([1, 2]).ok).toBe(false);
  });

  it('rejects an unknown eventType', () => {
    const r = parseAnalyticsEventBody({ eventType: 'drop_table' });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-UUID occurrenceId', () => {
    const r = parseAnalyticsEventBody({ eventType: 'listing_viewed', occurrenceId: 'fixture-open-gym' });
    expect(r.ok).toBe(false);
  });

  it('rejects an oversized json field', () => {
    const big = { blob: 'x'.repeat(MAX_JSON_FIELD_BYTES + 100) };
    const r = parseAnalyticsEventBody({ eventType: 'listing_viewed', resultSummary: big });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-object json field', () => {
    const r = parseAnalyticsEventBody({ eventType: 'listing_viewed', resultSummary: 'not-an-object' });
    expect(r.ok).toBe(false);
  });
});
