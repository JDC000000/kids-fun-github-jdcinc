// lib/snapshot/verify.ts — INDEPENDENT re-scan of a snapshot on disk.
//
// The export already scrubs. This reads what the export actually produced and tries to find
// personal data in it anyway, using the same detectors from the other side. That redundancy is
// the entire point: the export's scrub and this check share the detector library but not the
// code path, so a bug in the export's row plumbing (a column selected but not transformed, a
// policy entry pointing at the wrong action, a null-handling slip) shows up here.
//
// The operator runs this BEFORE the snapshot leaves the machine it was produced on, and CI
// runs it again before loading. A failure means the file must be deleted, not shipped.
//
// WHAT IT CHECKS
//   1. manifest integrity — every file present, sha256 matches, row counts match.
//   2. shape — every row's key set is EXACTLY the policy's exported columns. A stray column
//      is an error even if it looks harmless: it means the file did not come from this policy.
//   3. residue — every string value is scanned with the detectors appropriate to its column's
//      action (see lib/snapshot/scrub.ts residualFindings). Any hit fails the run.
//   4. placeholders — `placeholder_*` columns must be null or exactly the placeholder value.
//   5. no excluded table snuck in — a file for a non-allowlisted table fails the run.
//
// It prints WHERE a violation is (table, column, row ordinal) and NEVER the offending value.
//
// The CLI wrapper is scripts/snapshot/verify.ts; scripts/snapshot/load.ts calls
// verifySnapshot() directly so a snapshot can never be loaded without being re-scanned.
import { createGunzip } from 'node:zlib';
import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { SNAPSHOT_TABLES, exportedColumns, policyFingerprint, tablePolicy } from './policy';
import { REDACTION, isPlaceholderPhone, residualFindings } from './scrub';
import { SNAPSHOT_FORMAT_VERSION, decodeRow, sha256, type SnapshotManifest } from './format';
import { safeErrorMessage } from './safe-error';

export interface VerifyResult {
  problems: string[];
  rowsScanned: number;
  valuesScanned: number;
}

export async function verifySnapshot(dir: string): Promise<VerifyResult> {
  const problems: string[] = [];
  let rowsScanned = 0;
  let valuesScanned = 0;

  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { problems: [`no manifest.json in ${dir} — this is not a snapshot directory`], rowsScanned, valuesScanned };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest;

  if (manifest.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    problems.push(
      `snapshot format version ${manifest.formatVersion} != ${SNAPSHOT_FORMAT_VERSION} expected by this checkout`
    );
  }
  if (manifest.policyFingerprint !== sha256(policyFingerprint())) {
    problems.push(
      'policy fingerprint mismatch: this snapshot was taken under a DIFFERENT lib/snapshot/policy.ts. ' +
        'Re-export rather than trusting it — the scrub rules may have been tightened since.'
    );
  }

  // Any file for a table that is not allowlisted is a hard stop, whatever the manifest says.
  const allowed = new Set(SNAPSHOT_TABLES.map((t) => t.table));
  for (const f of readdirSync(dir)) {
    if (f === 'manifest.json') continue;
    const m = /^\d+_(.+)\.ndjson\.gz$/.exec(f);
    if (!m) {
      problems.push(`unexpected file in snapshot directory: ${f}`);
      continue;
    }
    if (!allowed.has(m[1])) {
      problems.push(`FILE FOR NON-ALLOWLISTED TABLE: ${f}. Delete this snapshot; do not ship it.`);
    }
  }

  for (const entry of manifest.tables) {
    const policy = tablePolicy(entry.table);
    if (!policy) {
      problems.push(`manifest lists non-allowlisted table "${entry.table}"`);
      continue;
    }
    const filePath = join(dir, entry.file);
    if (!existsSync(filePath)) {
      problems.push(`${entry.table}: manifest lists ${entry.file}, which is missing`);
      continue;
    }
    const digest = sha256(readFileSync(filePath));
    if (digest !== entry.sha256) {
      problems.push(`${entry.table}: ${entry.file} sha256 does not match the manifest — the file changed after export`);
    }

    const expectedCols = exportedColumns(policy);
    const expectedSet = new Set(expectedCols);

    let n = 0;
    const rl = createInterface({ input: createReadStream(filePath).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim() === '') continue;
      n += 1;
      let row;
      try {
        row = decodeRow(line);
      } catch (err) {
        problems.push(`${entry.table} row ${n}: ${safeErrorMessage(err)}`);
        continue;
      }

      const keys = Object.keys(row);
      for (const k of keys) {
        if (!expectedSet.has(k)) problems.push(`${entry.table} row ${n}: unexpected column "${k}"`);
      }
      for (const k of expectedCols) {
        if (!(k in row)) problems.push(`${entry.table} row ${n}: missing column "${k}"`);
      }

      for (const [col, value] of Object.entries(row)) {
        if (value === null) continue;
        valuesScanned += 1;
        const action = policy.columns[col]?.action;
        if (!action) continue;

        // Placeholder columns get an EXACT check instead of the residue scan, and then stop.
        // A phone placeholder is deliberately still phone-SHAPED — that is the whole point of
        // it — so running the phone detector over it would flag every correctly redacted value.
        if (action === 'placeholder_token') {
          if (value !== REDACTION.token) {
            problems.push(`${entry.table}.${col} row ${n}: placeholder_token column is not the placeholder`);
          }
          continue;
        }
        if (action === 'placeholder_phone') {
          // Every digit must be the one placeholderPhone() would have written at that position,
          // so no real number can have survived in any form.
          if (!isPlaceholderPhone(value)) {
            problems.push(`${entry.table}.${col} row ${n}: placeholder_phone column has digits a placeholder would not produce`);
          }
          continue;
        }

        const residue = residualFindings(value, action);
        if (residue.length > 0) {
          // Location only. The value is exactly what must not be reproduced.
          problems.push(`${entry.table}.${col} row ${n}: RESIDUAL PERSONAL DATA (${residue.join(', ')})`);
        }
      }
    }

    rowsScanned += n;
    if (n !== entry.rows) problems.push(`${entry.table}: manifest says ${entry.rows} rows, file has ${n}`);
  }

  for (const t of SNAPSHOT_TABLES) {
    if (!manifest.tables.some((e) => e.table === t.table)) {
      problems.push(`${t.table}: allowlisted but absent from the manifest — the snapshot is incomplete`);
    }
  }

  return { problems, rowsScanned, valuesScanned };
}
