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
import { parseAnalyticsEventBody } from '../../lib/analytics/validate';

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

  it('names exactly the events with a real emit call site today', () => {
    // Was "the two proof-of-concept events"; the SMS front-door pair joined them in TSD §9 M1.
    // An exact list rather than a contains-check, because the value of `wiring` is entirely in
    // what it EXCLUDES — it is what makes the admin dashboard print "Not yet instrumented"
    // instead of a structural zero, and a list that could only grow would stop doing that job.
    const wired = EVENT_CATALOG.filter((e) => e.wiring === 'wired').map((e) => e.type).sort();
    expect(wired).toEqual([
      'listing_viewed',
      'search_performed',
      'sms_offer_viewed',
      'sms_signup_cta_clicked',
    ]);
  });

  it('formally defers search_autocomplete_selected (PRD §9, autocomplete not built)', () => {
    const types = DEFERRED_EVENT_TYPES.map((d) => d.type);
    expect(types).toContain('search_autocomplete_selected');
    // A deferred event must NOT be live-emittable.
    expect(KNOWN_EVENT_TYPES as readonly string[]).not.toContain('search_autocomplete_selected');
    expect(catalogEntry('search_autocomplete_selected')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The homepage → SMS front door pair (TSD §9 M1, T1.1/T1.2).
//
// Two events measure ONE funnel — the offer was presented, then the offer was
// taken — so the ratio between them is the conversion rate the pivot is judged
// on. That makes the client/server split here a data-integrity decision rather
// than a filing one, and it is asserted in both directions below:
//
//   • `sms_offer_viewed` is SERVER-ONLY. It is the DENOMINATOR. It is emitted
//     during the home page's own render, where the offer either was or was not
//     presented — a fact only the server holds. Accepting it from a browser
//     would let anything inflate the denominator and silently depress the
//     conversion rate, and no amount of dashboard care could untangle it after
//     the fact.
//   • `sms_signup_cta_clicked` is CLIENT-FIREABLE. It is the NUMERATOR, and it
//     is a real click in a real browser that the server never sees (the CTA is
//     an internal <Link>, not a form post). A spoofed row here is the cheap
//     direction of the same risk: it over-counts a number we already treat as
//     an upper bound, and there is no server-side vantage point to fire it from.
// ─────────────────────────────────────────────────────────────────────────────
describe('the SMS front-door funnel events (TSD §9 M1)', () => {
  it('registers both event types', () => {
    expect(KNOWN_EVENT_TYPES as readonly string[]).toContain('sms_offer_viewed');
    expect(KNOWN_EVENT_TYPES as readonly string[]).toContain('sms_signup_cta_clicked');
  });

  it('🔴 the CLICK is browser-fireable and the IMPRESSION is not', () => {
    expect(isClientFireableEvent('sms_signup_cta_clicked')).toBe(true);
    expect(isClientFireableEvent('sms_offer_viewed')).toBe(false);
  });

  it('🔴 the public route ACCEPTS the click and REJECTS the impression', () => {
    // The type split above is only a promise until the thing that enforces it is
    // asserted. This is that thing: the validator the public POST route runs.
    expect(parseAnalyticsEventBody({ eventType: 'sms_signup_cta_clicked' }).ok).toBe(true);
    const rejected = parseAnalyticsEventBody({ eventType: 'sms_offer_viewed' });
    expect(rejected.ok).toBe(false);
  });

  it('puts the impression in SERVER_EVENT_TYPES and the click outside it', () => {
    expect(SERVER_EVENT_TYPES as readonly string[]).toContain('sms_offer_viewed');
    expect(SERVER_EVENT_TYPES as readonly string[]).not.toContain('sms_signup_cta_clicked');
  });
});

describe('the SMS front-door funnel events are catalogued (TSD §9 M1, T1.2)', () => {
  // NOTE ON COUPLING, because it is not obvious from the task list: catalog.ts runs its
  // completeness invariant at IMPORT time and throws "catalog missing entry for known
  // event". So a KNOWN_EVENT_TYPES addition without a catalog entry does not fail one
  // assertion — it fails to load every module that transitively imports the catalog.
  // T1.1 and T1.2 are therefore inseparable in practice, and ship together.
  it('gives the impression a server entry that names where it fires', () => {
    const entry = catalogEntry('sms_offer_viewed');
    expect(entry).toBeTruthy();
    expect(entry!.origin).toBe('server');
    expect(entry!.firedFrom).toMatch(/app\/page\.tsx/);
  });

  it('gives the click a client entry that names where it fires', () => {
    const entry = catalogEntry('sms_signup_cta_clicked');
    expect(entry).toBeTruthy();
    expect(entry!.origin).toBe('client');
    expect(entry!.firedFrom).toMatch(/app\/(page\.tsx|_components\/)/);
  });

  it('🔴 neither entry is left without a named emit source', () => {
    // The whole point of T1.2: the admin dashboard prints "Not yet instrumented"
    // rather than a bare 0 for anything it cannot name an emitter for
    // (app/admin/dashboard/_components/KpiTiles.tsx::pendingEvents). An entry with an
    // empty firedFrom would satisfy "is catalogued" and defeat the reason for it.
    for (const type of ['sms_offer_viewed', 'sms_signup_cta_clicked'] as const) {
      const entry = catalogEntry(type);
      expect(entry!.firedFrom.trim().length).toBeGreaterThan(0);
      expect(entry!.provenance).toMatch(/M1|AC-09/);
      expect(entry!.description.trim().length).toBeGreaterThan(0);
    }
  });
});
