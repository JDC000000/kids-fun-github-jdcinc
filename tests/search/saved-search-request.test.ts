// tests/search/saved-search-request.test.ts — a saved search must RE-RUN the search that was
// saved, including the two things its stored envelope could previously state and never deliver.
//
// The envelope is written by app/search/_lib/params.ts `serializeStateToParams` and is asserted
// faithful by tests/saved_search_ui_params.test.ts ("`reg: '1'` … MUST be written, or re-running a
// saved course search would silently come back drop-in only"). It was written — and then dropped
// on the way into the engine, which is the same defect one layer down: the weekly digest and
// /account's status line both ran a `reg=1` saved search as drop-in only.
//
// Registration is the one chip that CANNOT arrive through the composed query text: it is
// structured-only by design (lib/search/parse.ts — an inclusion policy must never be inferable
// from words a parent typed), so `intentPhrases` composes no phrase for it and forwarding the
// field is the only path it has.

import { describe, it, expect } from 'vitest';
import { savedSearchRawParams, savedSearchRequest } from '@/lib/search/saved-search-status';

const NOW = new Date('2026-08-18T14:15:00Z');

describe('savedSearchRequest', () => {
  it('forwards the registration opt-in a saved search stored as `reg`', () => {
    const { request } = savedSearchRequest({ q: 'swim', reg: '1' }, null, NOW);
    expect(request.includeRegistration).toBe(true);
    // And no phrase for it leaked into the composed text — it is structured-only, both ways.
    expect(request.q).toBe('swim');
  });

  it('leaves it off when the saved search did not ask for it', () => {
    expect(savedSearchRequest({ q: 'swim' }, null, NOW).request.includeRegistration).toBe(false);
    expect(savedSearchRequest({ q: 'swim', reg: '0' }, null, NOW).request.includeRegistration).toBe(false);
  });

  it('keeps every region a saved search stored, in either shape', () => {
    // The envelope is generic JSON: a row written by anything other than serializeStateToParams
    // can hold `region` as a real array. Ignoring non-string values deleted the whole selection.
    expect(savedSearchRequest({ q: 'swim', region: 'van,bby' }, null, NOW).request.regionChipIds).toEqual(['van', 'bby']);
    expect(savedSearchRequest({ q: 'swim', region: ['van', 'bby'] }, null, NOW).request.regionChipIds).toEqual(['van', 'bby']);
  });

  it('still ignores values that are not part of the /search URL contract', () => {
    const raw = savedSearchRawParams({ q: 'swim', nested: { a: 1 }, nothing: null, count: 3, on: true });
    expect(raw).toEqual({ q: 'swim', count: '3', on: 'true' });
  });
});
