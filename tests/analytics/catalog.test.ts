// tests/analytics/catalog.test.ts — the event catalog is internally consistent.
import { describe, it, expect } from 'vitest';
import {
  EVENT_CATALOG,
  DEFERRED_EVENT_TYPES,
  catalogEntry,
} from '../../lib/analytics/catalog';
import {
  KNOWN_EVENT_TYPES,
  CLIENT_EVENT_TYPES,
  SERVER_EVENT_TYPES,
  isClientFireableEvent,
} from '../../lib/analytics/types';

describe('analytics event catalog', () => {
  it('has exactly one catalog entry per known event type (and no extras)', () => {
    const catalogued = EVENT_CATALOG.map((e) => e.type).sort();
    expect(catalogued).toEqual([...KNOWN_EVENT_TYPES].sort());
    expect(new Set(catalogued).size).toBe(catalogued.length); // no duplicates
  });

  it('CLIENT ∪ SERVER partitions the known event types', () => {
    const union = [...CLIENT_EVENT_TYPES, ...SERVER_EVENT_TYPES].sort();
    expect(union).toEqual([...KNOWN_EVENT_TYPES].sort());
    for (const t of CLIENT_EVENT_TYPES) expect(SERVER_EVENT_TYPES).not.toContain(t);
  });

  it('catalog origin agrees with the client/server split', () => {
    for (const e of EVENT_CATALOG) {
      expect(e.origin === 'client').toBe(isClientFireableEvent(e.type));
    }
  });

  it('every entry carries provenance + a firedFrom location', () => {
    for (const e of EVENT_CATALOG) {
      expect(e.provenance.length).toBeGreaterThan(0);
      expect(e.firedFrom.length).toBeGreaterThan(0);
      expect(['wired', 'capture_ready', 'deferred']).toContain(e.wiring);
    }
  });

  it('the two proof-of-concept events are wired; the rest are capture-ready', () => {
    const wired = EVENT_CATALOG.filter((e) => e.wiring === 'wired').map((e) => e.type).sort();
    expect(wired).toEqual(['listing_viewed', 'search_performed']);
  });

  it('formally defers search_autocomplete_selected (PRD §9, autocomplete not built)', () => {
    const types = DEFERRED_EVENT_TYPES.map((d) => d.type);
    expect(types).toContain('search_autocomplete_selected');
    // A deferred event must NOT be live-emittable.
    expect(KNOWN_EVENT_TYPES as readonly string[]).not.toContain('search_autocomplete_selected');
    expect(catalogEntry('search_autocomplete_selected')).toBeUndefined();
  });
});
