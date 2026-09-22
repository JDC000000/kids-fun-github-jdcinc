// scripts/incident/negative/assert-reset-targets.cjs — prove KF_REPLICA_RESET resets the database
// KF_CLEANUP_TARGET_URL actually names.
//
// ═══ WHY THIS IS A SENTINEL AND NOT A STRING COMPARISON ═══
// The two variables were completely decoupled: the suite could reset one database while running
// the cleanup script and the write-helpers against another. Every case would then execute against
// a replica nobody restored, and the drift would surface as guard "findings" that are really just
// stale state — noise that looks exactly like signal.
//
// The obvious fix is to have the reset command declare its target and compare strings. That check
// is only ever as good as the declaration, and the whole incident this toolkit exists to clean up
// happened because a declaration ("this is the test database") was trusted over the actual target.
// So this does not ask. It plants a uniquely-named table in the database the suite will really use,
// runs the reset, and requires that the table be GONE. A reset pointed anywhere else leaves the
// sentinel standing and the suite refuses to start.
//
// Failure modes are deliberately asymmetric: a reset that did not run, ran against another
// database, or ran but does not truly restore, all leave the sentinel behind and all abort.
// Plain 'pg' like every sibling helper. This was an absolute path into ANOTHER project's
// node_modules — copied from reset-replica.cjs, which lives outside any repo and genuinely needs
// it. Inside the repo it silently ties this script to an unrelated checkout's install.
const { Client } = require('pg');
const { assertLoopback } = require('./_local-only.cjs');

const [, , mode, token] = process.argv;
const U = process.env.KF_CLEANUP_TARGET_URL;
assertLoopback(U, 'KF_CLEANUP_TARGET_URL'); // this script WRITES; never let it reach a real host

if (!/^[A-Za-z0-9_]{8,40}$/.test(String(token))) {
  console.error(`sentinel token ${JSON.stringify(token)} is not a safe identifier.`);
  process.exit(2);
}
const TABLE = `kf_reset_sentinel_${token}`; // validated above, so safe to interpolate

(async () => {
  const c = new Client({ connectionString: U });
  await c.connect();
  try {
    if (mode === 'plant') {
      await c.query(`CREATE TABLE IF NOT EXISTS "${TABLE}" (planted_at timestamptz DEFAULT now())`);
      await c.query(`INSERT INTO "${TABLE}" DEFAULT VALUES`);
      process.exit(0);
    }
    if (mode === 'verify') {
      const { rows } = await c.query('SELECT to_regclass($1) AS present', [`public.${TABLE}`]);
      if (rows[0].present === null) process.exit(0); // gone: the reset really did hit this database
      console.error(
        `KF_REPLICA_RESET did not reset the database KF_CLEANUP_TARGET_URL names.\n` +
          `  A sentinel table planted in that database SURVIVED the reset.\n` +
          `  The two variables are independent, so they can point at different databases — and then\n` +
          `  every case runs against a replica nobody restored. Point them at the same database.`
      );
      process.exit(3);
    }
    console.error(`unknown mode ${JSON.stringify(mode)} (expected "plant" or "verify")`);
    process.exit(2);
  } finally {
    await c.end().catch(() => {});
  }
})().catch((e) => { console.error(String((e && e.message) || e)); process.exit(4); });
