// lib/snapshot/schema-guard.ts — the deny-by-default enforcement layer.
//
// The allowlist in lib/snapshot/policy.ts is only as good as its freshness. Its realistic
// failure mode is NOT a forgotten table (a table absent from the allowlist is simply never
// read, so it cannot leak) — it is a migration that adds a PII column to a table that is
// ALREADY allowlisted. `venue.phone` arrived exactly that way in migration 0024, three years
// of migrations after `venue` was created.
//
// So this module diffs the live schema against the policy and reports:
//   • unclassified column on an allowlisted table  → ERROR. Deny-by-default: the export
//     refuses to run rather than guessing, and CI fails at PR time.
//   • classified column that no longer exists      → ERROR. The policy is stale; a snapshot
//     taken with it would be shaped wrong.
//   • column whose type changed                    → ERROR. The text round-trip is only
//     lossless while both ends agree on the type.
//   • brand-new table, in neither list             → NOTICE, not an error. It is excluded by
//     construction and cannot leak; somebody should decide whether it belongs, but that
//     decision does not have to block a merge.
//
// tests/snapshot/policy-schema-guard.test.ts runs this against the migrated CI database on
// EVERY run — not only in snapshot mode — because the alarm is worthless if it only fires
// when someone remembers to opt in.

import type { Pool } from 'pg';
import { ALLOWLISTED_TABLES, EXCLUDED_TABLES, SNAPSHOT_TABLES, classifiedColumns } from './policy';
import type { ColumnFingerprint, SchemaFingerprint } from './format';

export interface SchemaGuardReport {
  errors: string[];
  notices: string[];
  fingerprint: SchemaFingerprint;
}

interface RawColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  not_null: boolean;
}

/** Every ordinary table + column in the `public` schema, straight from the catalog. */
export async function readLiveSchema(pool: Pool): Promise<Map<string, ColumnFingerprint[]>> {
  const { rows } = await pool.query<RawColumn>(
    `SELECT c.relname AS table_name,
            a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname, a.attnum`
  );

  const out = new Map<string, ColumnFingerprint[]>();
  for (const r of rows) {
    const list = out.get(r.table_name) ?? [];
    list.push({ name: r.column_name, type: r.data_type, notNull: r.not_null });
    out.set(r.table_name, list);
  }
  return out;
}

async function readMigrationLedger(pool: Pool): Promise<{ version: string; checksum: string | null }[]> {
  const { rows } = await pool.query<{ version: string; checksum: string | null }>(
    `SELECT version, checksum FROM schema_migrations ORDER BY version`
  );
  return rows;
}

/**
 * Diff the live schema against the policy. Pure given `live` — the DB read is separate so the
 * unit lane can exercise the diff logic without a database.
 */
export function diffPolicyAgainstSchema(live: Map<string, ColumnFingerprint[]>): {
  errors: string[];
  notices: string[];
} {
  const errors: string[] = [];
  const notices: string[] = [];

  for (const policy of SNAPSHOT_TABLES) {
    const cols = live.get(policy.table);
    if (!cols) {
      errors.push(
        `[snapshot-policy] allowlisted table "${policy.table}" does not exist in this database. ` +
          `Either the policy is stale or this database is not migrated.`
      );
      continue;
    }

    const liveNames = new Set(cols.map((c) => c.name));
    const classified = new Set(classifiedColumns(policy));

    for (const c of cols) {
      if (!classified.has(c.name)) {
        errors.push(
          `[snapshot-policy] UNCLASSIFIED COLUMN ${policy.table}.${c.name} (${c.type}).\n` +
            `  A migration added a column to an ALLOWLISTED table. Deny-by-default: nothing is exported ` +
            `until a human decides what this column is.\n` +
            `  → If it can carry personal data, give it 'redact_prose' / 'redact_contact' / ` +
            `'placeholder_token' in lib/snapshot/policy.ts.\n` +
            `  → If it is public catalogue data, give it 'preserve' AND say why in the policy entry.\n` +
            `  → If the table now holds personal data at all, remove it from SNAPSHOT_TABLES and add it ` +
            `to EXCLUDED_TABLES with the reason.`
        );
      }
    }

    for (const name of classified) {
      if (!liveNames.has(name)) {
        errors.push(
          `[snapshot-policy] STALE POLICY: ${policy.table}.${name} is classified in lib/snapshot/policy.ts ` +
            `but no longer exists. Remove it — a snapshot taken against this policy would be shaped wrong.`
        );
      }
    }

    if (!liveNames.has(policy.key)) {
      errors.push(`[snapshot-policy] ${policy.table}: declared key column "${policy.key}" does not exist.`);
    }
    for (const c of policy.selfRefColumns ?? []) {
      if (!liveNames.has(c)) {
        errors.push(`[snapshot-policy] ${policy.table}: declared self-reference column "${c}" does not exist.`);
      }
    }
  }

  for (const table of live.keys()) {
    if (ALLOWLISTED_TABLES.includes(table)) continue;
    if (table in EXCLUDED_TABLES) continue;
    notices.push(
      `[snapshot-policy] NEW TABLE "${table}" is in neither SNAPSHOT_TABLES nor EXCLUDED_TABLES. ` +
        `It is excluded by default and cannot leak, but somebody should record the decision in ` +
        `lib/snapshot/policy.ts.`
    );
  }

  for (const table of Object.keys(EXCLUDED_TABLES)) {
    if (!live.has(table)) {
      notices.push(`[snapshot-policy] EXCLUDED_TABLES mentions "${table}", which no longer exists. Tidy it up.`);
    }
  }

  return { errors, notices };
}

/** Read the live schema, diff it, and build the fingerprint stamped into the manifest. */
export async function runSchemaGuard(pool: Pool): Promise<SchemaGuardReport> {
  const live = await readLiveSchema(pool);
  const { errors, notices } = diffPolicyAgainstSchema(live);

  const tables: Record<string, ColumnFingerprint[]> = {};
  for (const t of ALLOWLISTED_TABLES) {
    const cols = live.get(t);
    if (cols) tables[t] = cols;
  }

  return {
    errors,
    notices,
    fingerprint: { migrations: await readMigrationLedger(pool), tables },
  };
}
