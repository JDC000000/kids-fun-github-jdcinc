// lib/user/saved-search-validate.ts — input validation for creating a saved search.
//
// Task 38 (M4 / G5). Pure (no pg / no next imports) so it is trivially
// unit-testable and reusable by both the POST /api/saved-searches route and any
// future caller (e.g. a "save this search" button on /search, deferred to a
// later round). Mirrors lib/user/profile-validate.ts in shape and posture.
//
// The saved_search table (0007_user_admin.sql) stores the whole search under a
// single jsonb column, `query_json`, with NO dedicated name/label column. So a
// saved search is persisted as a canonical envelope:
//     query_json = { name: string | null, params: { ...search fields } }
// `name`   — an optional friendly label the parent gives the search.
// `params` — the search itself (query text + filters). Kept as a generic object
//            rather than a fixed schema so a future /search "save" button can
//            persist whatever its search-state shape is without a migration.

/** The validated payload for a new saved search. */
export interface SavedSearchInput {
  name: string | null;
  params: Record<string, unknown>;
}

export type ParseResult =
  | { ok: true; value: SavedSearchInput }
  | { ok: false; error: string };

// Constraints (exported so tests and the UI can reference the same limits).
export const CREATE_KEYS = ['name', 'params'] as const;
export const MAX_NAME_LEN = 120;
export const MAX_PARAMS_BYTES = 8 * 1024; // 8 KB cap on the serialized query params
export const MAX_PARAMS_KEYS = 50; // a generous cap on distinct top-level fields

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate an untrusted JSON body into a SavedSearchInput. Rejects (ok:false) on:
 *   • a non-object body,
 *   • any unknown key (guards against typos silently no-op'ing),
 *   • a malformed `name` (must be a string ≤ MAX_NAME_LEN, or null/'' to omit),
 *   • a missing / non-object / empty `params`,
 *   • a `params` that is too large or has too many top-level fields.
 * An empty or whitespace-only `name` normalizes to null (no label).
 */
export function parseSavedSearchCreate(body: unknown): ParseResult {
  if (!isPlainObject(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }

  const unknown = Object.keys(body).filter(
    (k) => !(CREATE_KEYS as readonly string[]).includes(k)
  );
  if (unknown.length > 0) {
    return { ok: false, error: `unknown field(s): ${unknown.join(', ')}` };
  }

  // name — optional label.
  let name: string | null = null;
  if ('name' in body) {
    const v = body.name;
    if (v === null) {
      name = null;
    } else if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.length > MAX_NAME_LEN) {
        return { ok: false, error: `name must be ${MAX_NAME_LEN} characters or fewer` };
      }
      name = trimmed === '' ? null : trimmed;
    } else {
      return { ok: false, error: 'name must be a string or null' };
    }
  }

  // params — required; the search itself.
  if (!('params' in body)) {
    return { ok: false, error: 'params is required' };
  }
  const params = body.params;
  if (!isPlainObject(params)) {
    return { ok: false, error: 'params must be a JSON object' };
  }
  const paramKeys = Object.keys(params);
  if (paramKeys.length === 0) {
    return { ok: false, error: 'params must include at least one search field' };
  }
  if (paramKeys.length > MAX_PARAMS_KEYS) {
    return { ok: false, error: `params may have at most ${MAX_PARAMS_KEYS} fields` };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(params);
  } catch {
    return { ok: false, error: 'params must be JSON-serializable' };
  }
  // JSON.stringify drops undefined/functions but returns undefined for a value
  // that serializes to nothing; params is a non-empty plain object so this is a
  // guard against exotic inputs (e.g. a lone BigInt would have thrown above).
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_PARAMS_BYTES) {
    return { ok: false, error: `params is too large (max ${MAX_PARAMS_BYTES} bytes)` };
  }

  return { ok: true, value: { name, params } };
}
