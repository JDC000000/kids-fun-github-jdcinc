// lib/llm/dedup-merge.ts — G-T14-3: merge a duplicate occurrence into its canonical,
// PRESERVING multi-source provenance (TSD §6 IR-04, FR-17/BR-16).
//
// The Round-25 dedup adjudication (lib/llm/dedup.ts) originally "merged" an auto-merge
// pair by simply archiving the losing record — its provenance rows (which source_url /
// source_family each fact came from) were silently orphaned on the archived row. That is
// the genuine G-T14-3 gap this module closes: a real merge re-points the duplicate's
// provenance onto the surviving canonical so the canonical ends up carrying the union of
// BOTH sources' provenance, THEN archives the duplicate.
//
// One transactional core (`mergeOccurrencesTx`) serves BOTH callers so there is exactly
// one merge implementation, never a fork:
//   • the nightly auto-merge (lib/llm/dedup.ts applyDedupDecision), inside its
//     withServiceTransaction; and
//   • a human-confirmed manual merge from the admin QA queue (G-T34-6), inside its
//     withAdminTransaction alongside the admin_audit_log write.
//
// FAIL-CLOSED / IRREVERSIBILITY DISCIPLINE (a merge archives a record — no take-backs):
//   • The duplicate is CLAIMED by an archive `... WHERE archived_at IS NULL`. If that
//     touches 0 rows the record was already archived by a concurrent process (or a prior
//     merge) — we return `duplicate_already_archived` and move NOTHING. This is the exact
//     guard applyDedupDecision already used, so two concurrent merges of the same pair can
//     never double-move provenance.
//   • The canonical is locked FOR UPDATE and must itself be live; merging INTO an archived
//     canonical is refused (`canonical_archived`), never guessed.
//   • Provenance is re-pointed with an anti-join so a row identical (field + source_url +
//     fact_origin) to one the canonical already holds is NOT duplicated onto it (it stays
//     on the now-archived duplicate). Provenance is append-only — we never DELETE a fact.
//   • Self-merge (canonical === duplicate) is a caller bug, not a runtime condition — it
//     throws.
import type { PoolClient } from 'pg';
import { withServiceTransaction } from './db';

/** The dedup_key stamped on a canonical once it has absorbed at least one duplicate. */
export function canonicalDedupKey(canonicalId: string): string {
  return `dedup:v1:${canonicalId}`;
}

export type MergeStatus =
  /** The duplicate was archived and its provenance re-pointed onto the canonical. */
  | 'merged'
  /** The duplicate was already archived (concurrent process / prior merge) — no-op. */
  | 'duplicate_already_archived'
  /** The canonical is itself archived — refuse to merge into a dead record. */
  | 'canonical_archived'
  /** The canonical id does not exist. */
  | 'canonical_not_found';

export interface MergeOutcome {
  status: MergeStatus;
  /** Provenance rows re-pointed duplicate → canonical (0 unless status === 'merged'). */
  provenanceMoved: number;
  /**
   * Distinct source families now attached to the canonical's provenance AFTER a merge
   * (the FR-17 "multi-source provenance preserved" signal). 0 unless status === 'merged'.
   */
  canonicalSourceFamilies: number;
}

const NO_OP = (status: MergeStatus): MergeOutcome => ({ status, provenanceMoved: 0, canonicalSourceFamilies: 0 });

/**
 * Merge `duplicateId` into `canonicalId` within the caller's OPEN transaction, preserving
 * provenance. Deterministic and idempotent: re-running after a successful merge returns
 * `duplicate_already_archived` (the duplicate is already gone) and mutates nothing.
 *
 * Ordering inside the txn is deliberate: lock+validate the canonical, then CLAIM the
 * duplicate (the archive is the mutual-exclusion point), and only after a successful claim
 * move provenance and stamp the key — so a lost claim short-circuits before any provenance
 * is touched.
 *
 * @throws if canonicalId === duplicateId (a caller bug — never merge a record into itself).
 */
export async function mergeOccurrencesTx(
  client: Pick<PoolClient, 'query'>,
  canonicalId: string,
  duplicateId: string
): Promise<MergeOutcome> {
  if (canonicalId === duplicateId) {
    throw new Error('mergeOccurrencesTx: refusing to merge a record into itself');
  }

  // (1) Lock + validate the surviving canonical. It must exist and be live.
  const canon = await client.query<{ archived_at: Date | string | null }>(
    `SELECT archived_at FROM activity_occurrence WHERE id = $1 FOR UPDATE`,
    [canonicalId]
  );
  if (canon.rowCount === 0) return NO_OP('canonical_not_found');
  if (canon.rows[0].archived_at != null) return NO_OP('canonical_archived');

  // (2) CLAIM the duplicate by archiving it — only if still live. A 0-row result means a
  //     concurrent process already archived it: bail before moving any provenance (no
  //     double-merge). This is the same guard the original inline auto-merge used.
  const claim = await client.query(
    `UPDATE activity_occurrence
        SET archived_at = now(), last_checked_at = now()
      WHERE id = $1 AND archived_at IS NULL`,
    [duplicateId]
  );
  if ((claim.rowCount ?? 0) === 0) return NO_OP('duplicate_already_archived');

  // (3) Re-point the duplicate's provenance onto the canonical — skipping any fact the
  //     canonical already holds identically (same field + source_url + fact_origin), so a
  //     merge never fabricates a redundant provenance row. Skipped rows remain attached to
  //     the archived duplicate (append-only: we never DELETE a provenance fact).
  const moved = await client.query(
    `UPDATE provenance p
        SET occurrence_id = $1
      WHERE p.occurrence_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM provenance c
           WHERE c.occurrence_id = $1
             AND c.field = p.field
             AND c.source_url = p.source_url
             AND c.fact_origin = p.fact_origin
        )`,
    [canonicalId, duplicateId]
  );

  // (4) Stamp the canonical's reserved dedup_key (idempotent: only if unset).
  await client.query(
    `UPDATE activity_occurrence
        SET dedup_key = $2, last_checked_at = now()
      WHERE id = $1 AND dedup_key IS NULL`,
    [canonicalId, canonicalDedupKey(canonicalId)]
  );

  // (5) Report the multi-source provenance signal now on the canonical (FR-17 verify).
  const fam = await client.query<{ n: string }>(
    `SELECT count(DISTINCT source_family)::text AS n
       FROM provenance WHERE occurrence_id = $1 AND source_family IS NOT NULL`,
    [canonicalId]
  );

  return {
    status: 'merged',
    provenanceMoved: moved.rowCount ?? 0,
    canonicalSourceFamilies: Number(fam.rows[0]?.n ?? '0'),
  };
}

/**
 * Standalone provenance-preserving merge in its own service-pool transaction. For callers
 * that are NOT already inside a transaction (e.g. a script or a direct system merge). The
 * admin QA queue and the nightly auto-merge instead call {@link mergeOccurrencesTx} with
 * their own client so the merge shares a transaction with their audit-log write.
 */
export async function mergeOccurrences(canonicalId: string, duplicateId: string): Promise<MergeOutcome> {
  return withServiceTransaction((client) => mergeOccurrencesTx(client, canonicalId, duplicateId));
}
