// app/search/_lib/anon-memory.ts — "remember my last anonymous search" (T26 / G-T26-3).
//
// A returning anonymous visitor should not have to re-enter their location/filters on
// every visit. This module persists the visitor's LAST search — client-side only, in
// `localStorage` — so the /search page can offer to resume it. It is the storage half of
// the anon-memory feature (the UI half is app/search/_components/ResumeSearch.tsx).
//
// WHY client-only localStorage (and NOT a server table keyed to kf_anon_id):
//   • The canonical spec nominates it: TSD Task 26 says "anon child-ages in localStorage",
//     and scope-to-task G-T26-3 names a client module (lib/anon-memory.ts). Child ages are
//     one field of the search state, so remembering the whole (privacy-safe) last search is
//     a strict superset.
//   • kf_anon_id is httpOnly (middleware.ts / the analytics route), so client JS cannot read
//     it — and that security posture must not be weakened. Keying server-side would mean a DB
//     lookup per render for what is pure on-device convenience data.
//   • kf_anon_id is itself a per-browser cookie: it is exactly as device-local as localStorage,
//     and a "clear cookies & site data" wipes both together — so a server store buys no real
//     cross-device/cache-clear durability.
//   • The chosen UX is an explicit, DISMISSIBLE "resume last search" suggestion (never silent
//     auto-apply — a shared device must not surprise the next person), so the one genuine
//     server-side edge (SSR pre-fill without a flash) does not apply here.
//   • On-device storage keeps us from building a durable behavioural profile of anonymous
//     users — the same privacy discipline Tasks 13/38/B follow (never persist raw coordinates;
//     no durable anon location/behaviour store).
//
// PRIVACY INVARIANT: raw near-me coordinates are NEVER stored. Callers pass the already-
// coordinate-stripped `serializeStateToParams` map, and this module strips lat/lng again
// defensively on both write AND read, so even a hand-tampered or legacy blob can never
// resurrect a precise location.

/** localStorage key holding the last search. Namespaced to avoid collisions. */
export const ANON_MEMORY_KEY = 'kf_last_search';

/** Bump when the stored shape changes; older/newer versions are ignored (treated as absent). */
export const ANON_MEMORY_VERSION = 1;

/** Hard caps — this entry is tiny by design; refuse anything abnormal (tamper / bloat guard). */
const MAX_RAW_BYTES = 4096;
const MAX_LABEL_LEN = 120;

/** Location keys that must never be persisted (parity with serializeStateToParams / analytics). */
const FORBIDDEN_KEYS = new Set(['lat', 'lng', 'latitude', 'longitude']);

/** The persisted last-search record. `params` is the privacy-safe `serializeStateToParams` shape. */
export interface AnonSearchMemory {
  /** Schema version (=== ANON_MEMORY_VERSION for any record this build will honour). */
  v: number;
  /** Epoch ms of the last write (best-effort; 0 if unknown). Not shown as a precise time. */
  ts: number;
  /** Structured, string-valued search params — re-runnable via hrefForParams / parseSearchState. */
  params: Record<string, string>;
  /** Short human label for the suggestion ("family swim", "Weekend · Ages 5–9"). May be ''. */
  label: string;
}

/** A minimal Web Storage surface — injectable so the logic is unit-testable without a DOM. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Drop forbidden (location) keys, skip null/empty, and coerce values to strings — yielding the
 * privacy-safe, JSON-round-trippable param map we actually persist. Defence in depth: callers
 * already pass a coordinate-stripped map, but this guarantees the invariant at the storage layer.
 */
export function sanitizeParams(params: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!params || typeof params !== 'object') return out;
  for (const [k, v] of Object.entries(params)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) continue; // privacy invariant — never store coords
    if (v == null) continue;
    const s = typeof v === 'string' ? v : String(v);
    if (s === '') continue;
    out[k] = s;
  }
  return out;
}

/**
 * Serialize a memory record to its stored JSON string, or `null` when there is nothing worth
 * remembering (empty/all-forbidden params) or the result is abnormally large. Never throws.
 */
export function packMemory(params: Record<string, unknown>, label: string, now: number): string | null {
  const safe = sanitizeParams(params);
  if (Object.keys(safe).length === 0) return null; // a bare browse / near-me-only search stores nothing
  const rec: AnonSearchMemory = {
    v: ANON_MEMORY_VERSION,
    ts: Number.isFinite(now) ? now : 0,
    params: safe,
    label: typeof label === 'string' ? label.slice(0, MAX_LABEL_LEN) : '',
  };
  const raw = JSON.stringify(rec);
  return raw.length > MAX_RAW_BYTES ? null : raw;
}

/**
 * Parse + validate a stored string back into a usable record, or `null` if unusable (absent,
 * malformed, wrong schema version, non-object params, oversized). Re-applies the coordinate
 * strip so a tampered/legacy blob can never resurrect a raw location. Never throws.
 */
export function parseMemory(raw: string | null | undefined): AnonSearchMemory | null {
  if (!raw || raw.length > MAX_RAW_BYTES) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  if (rec.v !== ANON_MEMORY_VERSION) return null; // ignore other schema versions (fwd/back compat)
  if (!rec.params || typeof rec.params !== 'object' || Array.isArray(rec.params)) return null;
  const params = sanitizeParams(rec.params as Record<string, unknown>);
  if (Object.keys(params).length === 0) return null;
  const ts = typeof rec.ts === 'number' && Number.isFinite(rec.ts) ? rec.ts : 0;
  const label = typeof rec.label === 'string' ? rec.label.slice(0, MAX_LABEL_LEN) : '';
  return { v: ANON_MEMORY_VERSION, ts, params, label };
}

/** Resolve the browser's localStorage, or `null` if unavailable (SSR, private mode, disabled). */
function defaultStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null; // some browsers throw merely on access when storage is blocked
  }
}

/** Read the remembered last search, or `null` if none/unusable/unavailable. Never throws. */
export function readMemory(storage: StorageLike | null = defaultStorage()): AnonSearchMemory | null {
  if (!storage) return null;
  try {
    return parseMemory(storage.getItem(ANON_MEMORY_KEY));
  } catch {
    return null;
  }
}

/**
 * Persist the current search as the remembered last search. A no-op that LEAVES any existing
 * memory intact when there is nothing worth storing (empty/near-me-only params) — only
 * `clearMemory` ever erases. Returns whether a write happened. Never throws (quota/disabled → false).
 */
export function writeMemory(
  params: Record<string, unknown>,
  label: string,
  now: number,
  storage: StorageLike | null = defaultStorage()
): boolean {
  if (!storage) return false;
  const raw = packMemory(params, label, now);
  if (raw == null) return false; // nothing meaningful — do NOT clobber a prior good memory
  try {
    storage.setItem(ANON_MEMORY_KEY, raw);
    return true;
  } catch {
    return false; // quota exceeded / storage disabled — silently give up, never break the render
  }
}

/** Forget the remembered last search entirely (the user's explicit "Forget this"). Never throws. */
export function clearMemory(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(ANON_MEMORY_KEY);
  } catch {
    /* no-op */
  }
}

/**
 * Should the page offer a "resume last search" suggestion? Only on a truly bare /search landing
 * (no active query/filters/near-me) when a valid remembered search exists — never on top of an
 * active search, and never as a silent auto-apply.
 */
export function shouldOfferResume(hasActiveState: boolean, memory: AnonSearchMemory | null): boolean {
  return !hasActiveState && memory != null;
}
