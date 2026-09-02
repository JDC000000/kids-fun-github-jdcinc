// scripts/sms-retention-dry-run.ts — report what the SMS retention purge WOULD do. Never purges.
//
// The SMS purge has no HTTP route (unlike analytics/corrections retention) — it runs from the
// worker under SMS_RETENTION_DRY_RUN. This is the read-only report for deciding whether to enable
// it, runnable without touching the worker or its env.
//
// dryRun is HARDCODED true, not read from env and not a flag. Both purge paths take the same
// options object, so a single mistyped argument here is the difference between a report and an
// irreversible nulling of phone_number/postal_code/birth_years. There is no CLI surface that can
// ask this script to purge.
//
// Counts only — no phone numbers, no postal codes, no birth years reach stdout.
//
//   DATABASE_URL=<target> npx tsx scripts/sms-retention-dry-run.ts
import { purgeStoppedSubscriberData, purgeUnconfirmedSignups } from '../lib/retention/sms';
import { closePool, query } from '../lib/db/client';

async function main(): Promise<void> {
  const now = new Date();
  const stopped = await purgeStoppedSubscriberData({ dryRun: true, now });
  const pending = await purgeUnconfirmedSignups({ dryRun: true, now });

  // Context, so "matched: 0" can be read as "nothing is due" rather than "the query is broken" —
  // those look identical in isolation, and 0 is the expected answer for a young subscriber base.
  const ctx = await query<{ status: string; n: string; oldest_stop: string | null }>(
    `SELECT status, count(*)::text AS n, min(stopped_at)::text AS oldest_stop
       FROM sms_consent GROUP BY status ORDER BY status`
  );

  console.log(`SMS RETENTION DRY RUN — ${now.toISOString()}`);
  console.log('');
  console.log('Subscribers by status (whole table, for context):');
  if (ctx.length === 0) console.log('  (no rows in sms_consent)');
  for (const r of ctx) {
    console.log(`  ${r.status.padEnd(12)} ${String(r.n).padStart(6)}` +
                (r.oldest_stop ? `   oldest stopped_at: ${r.oldest_stop}` : ''));
  }
  console.log('');
  for (const [label, r] of [['STOPPED subscribers', stopped], ['UNCONFIRMED signups', pending]] as const) {
    console.log(`${label}`);
    console.log(`  retention window : ${r.retentionDays} days`);
    console.log(`  cutoff           : ${r.cutoff}`);
    console.log(`  WOULD PURGE      : ${r.matched}`);
    console.log(`  actually purged  : ${r.purged}   (always 0 here — dry run)`);
    if (r.truncated) console.log('  NOTE: batch cap hit; more rows would remain for the next run.');
    console.log('');
  }
  await closePool();
}

main().catch(async (e) => {
  console.error('FAILED:', e instanceof Error ? e.message : String(e));
  await closePool().catch(() => {});
  process.exit(1);
});
