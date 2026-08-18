// lib/snapshot/transform.ts — applies lib/snapshot/policy.ts to a row of Postgres text
// values. Pure: no I/O, no DB, no clock. The export streams every row through this before
// anything is written, so a raw value's only existence outside the source database is a
// variable in the exporting process.
//
// Split out from scripts/snapshot/export.ts so the transform is testable in the fast unit
// lane against hand-written adversarial rows (tests/snapshot/scrub.test.ts) rather than only
// observable by running an export against a live database.

import type { SnapshotRow } from './format';
import { exportedColumns, type TablePolicy } from './policy';
import { placeholderPhone, placeholderToken, redactContact, redactProse, redactTitle, type ScrubRule } from './scrub';

export type RedactionTally = Partial<Record<ScrubRule | 'placeholder', number>>;

export function mergeTally(into: RedactionTally, from: RedactionTally): void {
  for (const [k, v] of Object.entries(from)) {
    const key = k as keyof RedactionTally;
    into[key] = (into[key] ?? 0) + (v ?? 0);
  }
}

/**
 * Transform one raw row. `raw` must already be Postgres's text representation of each column
 * (see lib/snapshot/format.ts for why text). Columns with a `derived_drop` policy are omitted
 * from the result entirely; every other classified column appears, in policy order.
 *
 * Throws if the raw row carries a column the policy does not classify. That is unreachable
 * when the export builds its SELECT from the policy — it is here so that any future caller
 * that builds a row some other way still fails closed rather than passing an unknown column
 * straight through.
 */
export function transformRow(policy: TablePolicy, raw: SnapshotRow): { row: SnapshotRow; hits: RedactionTally } {
  for (const key of Object.keys(raw)) {
    if (!(key in policy.columns)) {
      throw new Error(
        `[snapshot-transform] ${policy.table}.${key} has no policy entry — refusing to export an ` +
          `unclassified column. Classify it in lib/snapshot/policy.ts.`
      );
    }
  }

  const hits: RedactionTally = {};
  const row: SnapshotRow = {};

  for (const col of exportedColumns(policy)) {
    const value = raw[col] ?? null;
    const { action } = policy.columns[col];

    if (value === null) {
      // A null stays a null under every action. Nullness is shape, and shape is the payload.
      row[col] = null;
      continue;
    }

    switch (action) {
      case 'preserve':
        row[col] = value;
        break;
      case 'redact_contact': {
        const r = redactContact(value);
        row[col] = r.value;
        mergeTally(hits, r.hits);
        break;
      }
      case 'redact_title': {
        const r = redactTitle(value);
        row[col] = r.value;
        mergeTally(hits, r.hits);
        break;
      }
      case 'redact_prose': {
        const r = redactProse(value);
        row[col] = r.value;
        mergeTally(hits, r.hits);
        break;
      }
      case 'placeholder_phone':
        row[col] = placeholderPhone(value);
        mergeTally(hits, { placeholder: 1 });
        break;
      case 'placeholder_token':
        row[col] = placeholderToken();
        mergeTally(hits, { placeholder: 1 });
        break;
      case 'derived_drop':
        // Unreachable: exportedColumns() already filtered these out. Kept so the switch stays
        // exhaustive and a new action cannot be added without visiting this file.
        break;
    }
  }

  return { row, hits };
}

/**
 * The SELECT list for a table: every exported column cast to text, aliased back to its own
 * name. `::text` is what makes the round trip lossless — see lib/snapshot/format.ts.
 *
 * Identifiers come from the policy (a compile-time constant in this repo), never from user
 * input, and are still double-quoted so a column named like a keyword cannot break the query.
 */
export function selectListSql(policy: TablePolicy): string {
  return exportedColumns(policy)
    .map((c) => `"${c}"::text AS "${c}"`)
    .join(', ');
}
