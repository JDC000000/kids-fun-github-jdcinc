// lib/search/postgres-alias-resolver.ts — DB-backed alias resolver (retires the
// fixture seam in live search; TSD §5A.2, FR-16, G-T17).
//
// The alias resolver is the query-time "parent language" expansion contract
// (see expand.ts). `FixtureAliasResolver(ALIAS_SEED)` was used even in database
// mode; this module reads the real `synonym_alias` table instead so operator
// alias content — not a hardcoded fixture — drives live expansion.
//
// Design: `AliasResolver.expand()` is SYNCHRONOUS, so a DB resolver cannot query
// per `expand()` call. Instead an async loader pulls the alias rows up front and
// constructs a resolver over them. `PostgresAliasResolver extends FixtureAliasResolver`
// so it reuses the exact greedy-phrase matching + sibling-synonym logic — a true
// drop-in swap — and it inherits add/remove/list, so the operator alias-admin hook
// (alias-admin.ts) keeps working against a live-loaded resolver until the next reload.
//
// Serverless caching: rows are tiny (~30) and change rarely, so per-request DB round
// trips are wasteful on a warm instance. We keep a short in-process TTL cache
// (KIDS_FUN_ALIAS_CACHE_MS, default 60s). This bounds how long an operator alias edit
// takes to reach live search to at most one TTL, preserving the "no bulk re-index"
// contract within a small, documented window. Set the TTL to 0 to disable caching.

import type { Pool } from 'pg';
import { FixtureAliasResolver, type AliasEntry } from './expand';

interface AliasRow {
  alias_text: string;
  category_key: string | null;
  tag_key: string | null;
}

/**
 * Load alias rows from the live `synonym_alias` table, joined to category/tag to
 * resolve the canonical UUIDs down to the string keys the search core expects
 * (e.g. 'open_gym'). Orphaned rows (target category/tag deleted) are skipped.
 */
export async function loadAliasEntries(pool: Pool): Promise<AliasEntry[]> {
  const { rows } = await pool.query<AliasRow>(
    `SELECT sa.alias_text,
            c.key AS category_key,
            t.key AS tag_key
       FROM synonym_alias sa
       LEFT JOIN category c ON c.id = sa.canonical_category_id
       LEFT JOIN tag t ON t.id = sa.canonical_tag_id
      ORDER BY sa.alias_text`
  );
  return rows.map(rowToAliasEntry).filter((e): e is AliasEntry => e !== null);
}

function rowToAliasEntry(row: AliasRow): AliasEntry | null {
  const aliasText = row.alias_text?.trim();
  if (!aliasText) return null;
  // synonym_alias_one_target CHECK guarantees exactly one of category/tag is set,
  // but LEFT JOINs can still yield null keys if the target row was removed — skip those.
  if (row.category_key) return { aliasText, canonicalCategoryKey: row.category_key };
  if (row.tag_key) return { aliasText, canonicalTagKey: row.tag_key };
  return null;
}

/**
 * DB-backed alias resolver. Same interface/contract as `FixtureAliasResolver`
 * (extends it, so identical matching semantics) but its rows come from the live
 * `synonym_alias` table. Constructable from entries for unit tests without a DB.
 */
export class PostgresAliasResolver extends FixtureAliasResolver {
  /** Load the current alias dictionary from Postgres and build a resolver over it. */
  static async load(pool: Pool): Promise<PostgresAliasResolver> {
    return new PostgresAliasResolver(await loadAliasEntries(pool));
  }
}

// ── Short in-process TTL cache for the serverless search route ────────────────
interface CacheEntry {
  resolver: PostgresAliasResolver;
  loadedAt: number;
}
let cache: CacheEntry | null = null;

function cacheTtlMs(): number {
  const raw = Number(process.env.KIDS_FUN_ALIAS_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
}

/**
 * Cached accessor for the search route: returns a live-loaded resolver, refreshing
 * from the DB at most once per TTL window. Falls through to a fresh load on a cold
 * cache or after the TTL expires.
 */
export async function getPostgresAliasResolver(
  pool: Pool,
  now: number = Date.now()
): Promise<PostgresAliasResolver> {
  const ttl = cacheTtlMs();
  if (cache && ttl > 0 && now - cache.loadedAt < ttl) return cache.resolver;
  const resolver = await PostgresAliasResolver.load(pool);
  cache = { resolver, loadedAt: now };
  return resolver;
}

/** Test/ops hook: drop the cached resolver so the next access reloads from the DB. */
export function clearPostgresAliasResolverCache(): void {
  cache = null;
}
