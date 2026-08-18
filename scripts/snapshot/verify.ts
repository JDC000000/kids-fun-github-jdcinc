// scripts/snapshot/verify.ts — CLI for the independent snapshot re-scan.
//
// Thin on purpose: all the logic lives in lib/snapshot/verify.ts so that
// scripts/snapshot/load.ts can call verifySnapshot() directly (a snapshot is therefore
// re-scanned on the way in as well as on the way out) and so the unit lane can test it.
//
// This file has no import-time side effects other than running: an earlier revision guarded
// main() behind an "am I the entry module?" check on process.argv[1], which silently did
// NOTHING under vite-node and reported success. A CLI that can no-op and exit 0 is worse than
// no CLI, so the split is structural now rather than conditional.
//
// USAGE
//   bash scripts/snapshot/verify.sh --in .snapshots/production-2026-08-18T…
//
// Exit 0 = clean. Non-zero = do not ship this snapshot; delete it, fix the policy, re-export.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifySnapshot } from '../../lib/snapshot/verify';
import { safeErrorMessage } from '../../lib/snapshot/safe-error';

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dir = resolve(argValue(argv, '--in') ?? '');
  if (!argv.includes('--in') || !existsSync(dir)) {
    console.error('\n✖ --in DIR is required and must exist\n');
    process.exit(2);
  }

  console.log(`→ verifying ${dir}`);
  const { problems, rowsScanned, valuesScanned } = await verifySnapshot(dir);

  if (problems.length > 0) {
    for (const p of problems.slice(0, 200)) console.error(`  ✗ ${p}`);
    if (problems.length > 200) console.error(`  … and ${problems.length - 200} more`);
    console.error(
      `\n✖ ${problems.length} problem(s). DO NOT SHIP THIS SNAPSHOT — delete it, fix the policy, re-export.\n`
    );
    process.exit(1);
  }

  console.log(`✔ clean: ${rowsScanned} rows / ${valuesScanned} non-null values scanned, no residual personal data.`);
}

main().catch((err: unknown) => {
  console.error(`\n✖ verify failed: ${safeErrorMessage(err)}\n`);
  process.exit(1);
});
