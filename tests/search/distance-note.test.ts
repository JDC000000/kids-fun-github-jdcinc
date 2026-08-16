import { describe, it, expect } from 'vitest';
import { distanceAvailability, distanceNote } from '../../app/search/_lib/distance-note';

// The page-level answer to "why do these cards say Distance unavailable?". The three states it
// distinguishes are worth keeping apart because the RIGHT THING TO DO differs in each, and one
// of them (a location the parent set that we then failed to use) must never be answered with
// "set your location" — they did.

describe('distanceAvailability', () => {
  it('is measured when the engine resolved an origin', () => {
    expect(
      distanceAvailability({ origin: { geo: { lat: 49.2, lng: -123.1 }, mode: 'near_me', label: 'Near me' }, originError: null }),
    ).toBe('measured');
  });

  it('is no_origin when none was asked for', () => {
    expect(distanceAvailability({ origin: null, originError: null })).toBe('no_origin');
  });

  it('is origin_failed when one was asked for and could not be resolved', () => {
    expect(distanceAvailability({ origin: null, originError: 'geocode_failed: could not geocode V0V0V0' })).toBe(
      'origin_failed',
    );
    expect(distanceAvailability({ origin: null, originError: 'auth_required: saved_home requires sign-in' })).toBe(
      'origin_failed',
    );
  });

  it('stays SILENT for a response shape that carries no origin field at all', () => {
    // Hand-built fixtures and any older cached shape. A spurious "distances aren't shown" over
    // a page that is showing them would be its own false statement, so absence → no note.
    expect(distanceAvailability({})).toBe('measured');
    expect(distanceAvailability(undefined)).toBe('measured');
  });
});

describe('distanceNote', () => {
  it('says nothing when distances are on the page', () => {
    expect(distanceNote('measured')).toBeNull();
  });

  it('tells a parent with no origin what to do, naming the control that actually does it', () => {
    const note = distanceNote('no_origin')!;
    expect(note).toContain('Near me');
    expect(note.toLowerCase()).toContain('distances aren');
  });

  it('never tells a parent to set a location they already set', () => {
    const note = distanceNote('origin_failed')!;
    expect(note).toContain('couldn’t use the location you set');
    expect(note).not.toContain('Near me');
  });

  it('never offers region chips as a way to get distances — they filter, they are not an origin', () => {
    // apiQuery sends `region=` (a catalogue filter), never `area=` (an origin), so narrowing to
    // a municipality does not make a distance appear. Suggesting it would be a small false promise.
    for (const state of ['no_origin', 'origin_failed'] as const) {
      const note = distanceNote(state)!;
      expect(note.toLowerCase()).not.toContain('area');
      expect(note.toLowerCase()).not.toContain('region');
    }
  });
});
