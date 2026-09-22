const { Client } = require('pg');
const { assertLoopback } = require('./_local-only.cjs');
const M = require(require('node:path').join(__dirname, '..', 'manifest-2026-09-21-fixture-pollution.json'));
assertLoopback(process.env.U);

// Closed on every path. This had no error handling at all, so any failure was an unhandled
// rejection that left the pg socket open — it only exited because Node kills the process on an
// unhandled rejection, which is luck, not design. See helper-stray-occ.cjs for the sibling that
// DID have a handler and hung forever because of it.
(async () => {
  const c = new Client({ connectionString: process.env.U });
  try {
    await c.connect();
    await c.query('UPDATE activity_occurrence SET archived_at = $2 WHERE id = $1',
      [M.target_occurrence_ids[0], '2026-09-22T01:00:00Z']);
  } finally {
    await c.end().catch(() => {});
  }
})().catch((e) => {
  console.error(`helper-archive-target failed: ${(e && e.message) || e}`);
  process.exit(1);
});
