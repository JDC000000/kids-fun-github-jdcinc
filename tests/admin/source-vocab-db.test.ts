// tests/admin/source-vocab-db.test.ts — G-T34-3 drift guard: the value sets the source
// console offers (app/admin/sources/_lib/vocab.ts) must EXACTLY match what the DB
// accepts, so the no-code UI can never present an option the column rejects, and a
// future migration that changes an enum/CHECK trips this test. Skips without a DB.
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, query } from '@/lib/db/client';
import {
  AUTHORITY_TIERS,
  TERMS_STATUSES,
  ROBOTS_STATUSES,
  HEALTH_STATES,
  INGESTION_METHODS,
  SEASON_STATES,
} from '@/app/admin/sources/_lib/vocab';

const hasDb = Boolean(process.env.DATABASE_URL);

/**
 * Extract the literal set from a column's MEMBERSHIP CHECK constraint on `source`.
 *
 * The match is deliberately narrow — `<column> = ANY (ARRAY[…])`, which is how Postgres
 * renders `CHECK (col IN (…))` back out of pg_get_constraintdef. An earlier, looser matcher
 * accepted any constraint whose text merely mentioned the column, and took the FIRST hit
 * from an unordered catalog scan. That was already fragile and became wrong the moment a
 * second constraint referenced one of these columns for a different purpose (0022's
 * `robots_override_decision IS NULL OR robots_status <> 'disallowed'`): it would have
 * matched, yielded {'disallowed'}, and failed this drift guard NON-DETERMINISTICALLY —
 * a red test blaming the wrong thing. Matching the shape, and asserting exactly one
 * constraint has it, makes that class of confusion impossible rather than unlikely.
 */
async function checkSet(column: string): Promise<Set<string>> {
  const rows = await query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'source' AND c.contype = 'c'`
  );
  const membership = new RegExp(String.raw`\b${column}\s*=\s*ANY\s*\(\s*ARRAY\[([^\]]*)\]`);
  const matches = rows.map((r) => membership.exec(r.def)).filter((m): m is RegExpExecArray => m !== null);
  if (matches.length === 0) throw new Error(`no membership CHECK constraint found for source.${column}`);
  if (matches.length > 1) {
    throw new Error(`source.${column} has ${matches.length} membership CHECK constraints — the vocab it accepts is ambiguous`);
  }
  const set = new Set<string>();
  const re = /'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(matches[0][1])) !== null) set.add(m[1]);
  return set;
}

async function enumSet(typeName: string): Promise<Set<string>> {
  const rows = await query<{ v: string }>(`SELECT unnest(enum_range(NULL::${typeName}))::text AS v`);
  return new Set(rows.map((r) => r.v));
}

describe.skipIf(!hasDb)('source vocab matches DB constraints (G-T34-3 drift guard)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('authority_tier CHECK set matches AUTHORITY_TIERS', async () => {
    expect(await checkSet('authority_tier')).toEqual(new Set(AUTHORITY_TIERS));
  });
  it('terms_status CHECK set matches TERMS_STATUSES', async () => {
    expect(await checkSet('terms_status')).toEqual(new Set(TERMS_STATUSES));
  });
  it('robots_status CHECK set matches ROBOTS_STATUSES', async () => {
    expect(await checkSet('robots_status')).toEqual(new Set(ROBOTS_STATUSES));
  });
  it('health_state CHECK set matches HEALTH_STATES', async () => {
    expect(await checkSet('health_state')).toEqual(new Set(HEALTH_STATES));
  });
  it('ingestion_method enum matches INGESTION_METHODS', async () => {
    expect(await enumSet('ingestion_method')).toEqual(new Set(INGESTION_METHODS));
  });
  it('season_state enum matches SEASON_STATES', async () => {
    expect(await enumSet('season_state')).toEqual(new Set(SEASON_STATES));
  });
});
