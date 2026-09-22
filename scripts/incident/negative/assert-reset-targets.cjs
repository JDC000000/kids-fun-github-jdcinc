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
// ═══ WHAT THIS ENFORCES IS NARROWER THAN WHAT KF_REPLICA_RESET PROMISES ═══
// The documented contract is "restores the replica to the manifest's preconditions". What the
// sentinel actually proves is stronger and narrower: that the table this run created is GONE, so
// the reset must be SCHEMA-LEVEL (drop/recreate). A perfectly valid row-level reset — TRUNCATE
// plus reseed — would leave the sentinel table standing and be rejected. That is deliberate for
// today's reset tooling, which does drop and recreate, but it is a real constraint on what a
// future KF_REPLICA_RESET may be, and it is written down here rather than discovered later.
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

// ═══ F2: AN UNQUALIFIED CREATE MADE THIS SENTINEL A PERMANENT NO-OP ═══
// plant used an UNQUALIFIED `CREATE TABLE`, resolved through search_path, while verify hard-coded
// `to_regclass('public.<table>')`. The default search_path is `"$user", public`, so on any database
// where a schema matching the connecting role exists — or where the URL carries
// `?options=-c search_path=...` — plant wrote to one schema and verify looked in another. verify
// then reported "gone" EVERY time, including when the reset did nothing at all, and the suite
// proceeded believing the replica had been restored.
//
// That is precisely the "11 pass, 5 spurious fail" disease this sentinel was built to prevent,
// reintroduced by the sentinel itself. Both statements are now explicitly schema-qualified, so
// plant and verify cannot address different tables.
//
// ═══ AND process.exit() INSIDE THE try SKIPPED THE finally ═══
// Every exit path ran inside the try, so `finally { c.end() }` never executed — it read as
// cleanup, it tested as cleanup (a review-time assertion matched the text), and it ran never.
// The same "looks covered, is dead" shape this toolkit has now hit three times. The exit code is
// computed first and applied only after the connection is really closed.
(async () => {
  const c = new Client({ connectionString: U });
  await c.connect();
  let code;
  try {
    if (mode === 'plant') {
      await c.query(`CREATE TABLE IF NOT EXISTS public."${TABLE}" (planted_at timestamptz DEFAULT now())`);
      await c.query(`INSERT INTO public."${TABLE}" DEFAULT VALUES`);
      code = 0;
    } else if (mode === 'verify') {
      const { rows } = await c.query('SELECT to_regclass($1) AS present', [`public.${TABLE}`]);
      if (rows[0].present === null) {
        code = 0; // gone: the reset really did hit this database
      } else {
        console.error(
          `KF_REPLICA_RESET did not reset the database KF_CLEANUP_TARGET_URL names.\n` +
            `  A sentinel table planted in that database SURVIVED the reset.\n` +
            `  The two variables are independent, so they can point at different databases — and then\n` +
            `  every case runs against a replica nobody restored. Point them at the same database.`
        );
        code = 3;
      }
    } else {
      console.error(`unknown mode ${JSON.stringify(mode)} (expected "plant" or "verify")`);
      code = 2;
    }
  } finally {
    await c.end().catch(() => {});
  }
  process.exit(code);
})().catch((e) => { console.error(String((e && e.message) || e)); process.exit(4); });
