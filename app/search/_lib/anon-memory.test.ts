// app/search/_lib/anon-memory.test.ts — the anon "remember my last search" storage layer
// (T26 / G-T26-3). Pure logic, exercised in the node environment against an injectable
// in-memory Storage stub (the suite has no jsdom; storage is injected, matching how the
// production code accepts a StorageLike). Focus: the privacy invariant (coordinates are
// NEVER persisted), validation hardening, and graceful degradation.
import { describe, it, expect } from 'vitest';
import {
  ANON_MEMORY_KEY,
  ANON_MEMORY_VERSION,
  type StorageLike,
  clearMemory,
  packMemory,
  parseMemory,
  readMemory,
  sanitizeParams,
  shouldOfferResume,
  writeMemory,
} from './anon-memory';

/** A minimal, inspectable localStorage stand-in. */
function memStore(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** A storage whose every method throws (private mode / disabled / quota). */
const throwingStore: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('quota');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

const NOW = 1_752_800_000_000; // fixed epoch ms (tests never call Date.now)

describe('sanitizeParams — privacy + normalisation', () => {
  it('drops raw coordinate keys in any case (privacy invariant)', () => {
    const out = sanitizeParams({ q: 'swim', lat: '49.28', lng: '-123.12', LATITUDE: '1', Longitude: '2' });
    expect(out).toEqual({ q: 'swim' });
    expect('lat' in out).toBe(false);
    expect('lng' in out).toBe(false);
  });

  it('skips null/empty values and coerces non-strings', () => {
    expect(sanitizeParams({ a: '', b: null as unknown as string, c: undefined as unknown as string, n: 5 as unknown as string })).toEqual({ n: '5' });
  });

  it('is safe on non-object input', () => {
    expect(sanitizeParams(null)).toEqual({});
    expect(sanitizeParams(undefined)).toEqual({});
  });
});

describe('packMemory / parseMemory round-trip', () => {
  it('packs a meaningful search and parses back identically', () => {
    const raw = packMemory({ q: 'family swim', region: 'van,bby', age: '2-4,5-9' }, 'family swim', NOW);
    expect(raw).not.toBeNull();
    const rec = parseMemory(raw);
    expect(rec).toEqual({
      v: ANON_MEMORY_VERSION,
      ts: NOW,
      params: { q: 'family swim', region: 'van,bby', age: '2-4,5-9' },
      label: 'family swim',
    });
  });

  it('returns null when there is nothing worth remembering (empty / all-forbidden params)', () => {
    expect(packMemory({}, 'x', NOW)).toBeNull();
    expect(packMemory({ lat: '49', lng: '-123' }, 'near me', NOW)).toBeNull();
  });

  it('never persists coordinates even if the caller mistakenly includes them', () => {
    const raw = packMemory({ q: 'swim', lat: '49.2827', lng: '-123.1207' }, 'swim', NOW)!;
    expect(raw).not.toContain('lat');
    expect(raw).not.toContain('49.2827');
    expect(parseMemory(raw)!.params).toEqual({ q: 'swim' });
  });

  it('caps an over-long label', () => {
    const rec = parseMemory(packMemory({ q: 'x' }, 'L'.repeat(500), NOW));
    expect(rec!.label.length).toBe(120);
  });

  it('refuses to pack an abnormally large payload', () => {
    expect(packMemory({ q: 'x'.repeat(5000) }, 'big', NOW)).toBeNull();
  });

  it('normalises a non-finite timestamp to 0', () => {
    expect(parseMemory(packMemory({ q: 'x' }, 'x', Number.NaN))!.ts).toBe(0);
  });
});

describe('parseMemory — validation hardening', () => {
  it('rejects absent / malformed / oversized raw', () => {
    expect(parseMemory(null)).toBeNull();
    expect(parseMemory(undefined)).toBeNull();
    expect(parseMemory('')).toBeNull();
    expect(parseMemory('{not json')).toBeNull();
    expect(parseMemory('x'.repeat(5000))).toBeNull();
  });

  it('rejects a wrong schema version (forward/backward compat)', () => {
    const other = JSON.stringify({ v: ANON_MEMORY_VERSION + 1, ts: NOW, params: { q: 'x' }, label: 'x' });
    expect(parseMemory(other)).toBeNull();
  });

  it('rejects non-object / array params', () => {
    expect(parseMemory(JSON.stringify({ v: ANON_MEMORY_VERSION, ts: NOW, params: ['q'], label: '' }))).toBeNull();
    expect(parseMemory(JSON.stringify({ v: ANON_MEMORY_VERSION, ts: NOW, params: 'q', label: '' }))).toBeNull();
    expect(parseMemory(JSON.stringify({ v: ANON_MEMORY_VERSION, ts: NOW }))).toBeNull();
  });

  it('strips coordinates from a tampered/legacy blob on read (defence in depth)', () => {
    const tampered = JSON.stringify({ v: ANON_MEMORY_VERSION, ts: NOW, params: { q: 'swim', lat: '49', lng: '-123' }, label: 'swim' });
    const rec = parseMemory(tampered);
    expect(rec!.params).toEqual({ q: 'swim' });
  });
});

describe('readMemory / writeMemory / clearMemory against a Storage stub', () => {
  it('write then read yields the same search', () => {
    const store = memStore();
    expect(writeMemory({ q: 'swim', free: '1' }, 'swim · Free', NOW, store)).toBe(true);
    expect(store.map.get(ANON_MEMORY_KEY)).toBeTruthy();
    const rec = readMemory(store);
    expect(rec!.params).toEqual({ q: 'swim', free: '1' });
    expect(rec!.label).toBe('swim · Free');
  });

  it('writeMemory is a no-op that PRESERVES existing memory when there is nothing to store', () => {
    const store = memStore();
    writeMemory({ q: 'keep me' }, 'keep me', NOW, store);
    // A bare/near-me-only search must not clobber the good memory.
    expect(writeMemory({}, '', NOW, store)).toBe(false);
    expect(writeMemory({ lat: '49', lng: '-123' }, 'near me', NOW, store)).toBe(false);
    expect(readMemory(store)!.params).toEqual({ q: 'keep me' });
  });

  it('clearMemory erases the remembered search', () => {
    const store = memStore();
    writeMemory({ q: 'swim' }, 'swim', NOW, store);
    clearMemory(store);
    expect(readMemory(store)).toBeNull();
    expect(store.map.has(ANON_MEMORY_KEY)).toBe(false);
  });

  it('degrades to no-op when storage is null (SSR / unavailable)', () => {
    expect(readMemory(null)).toBeNull();
    expect(writeMemory({ q: 'x' }, 'x', NOW, null)).toBe(false);
    expect(() => clearMemory(null)).not.toThrow();
  });

  it('never throws when storage itself throws (private mode / quota)', () => {
    expect(readMemory(throwingStore)).toBeNull();
    expect(writeMemory({ q: 'x' }, 'x', NOW, throwingStore)).toBe(false);
    expect(() => clearMemory(throwingStore)).not.toThrow();
  });
});

describe('shouldOfferResume — only on a bare landing with a valid memory', () => {
  const mem = { v: ANON_MEMORY_VERSION, ts: NOW, params: { q: 'x' }, label: 'x' };
  it('offers only when NOT actively searching AND a memory exists', () => {
    expect(shouldOfferResume(false, mem)).toBe(true);
    expect(shouldOfferResume(true, mem)).toBe(false); // active search — never interrupt
    expect(shouldOfferResume(false, null)).toBe(false); // nothing remembered
    expect(shouldOfferResume(true, null)).toBe(false);
  });
});
