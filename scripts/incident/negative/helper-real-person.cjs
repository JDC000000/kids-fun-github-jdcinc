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
    await c.query('INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING', [M.orphan_profile_ids[0]]);
  } finally {
    await c.end().catch(() => {});
  }
})().catch((e) => {
  console.error(`helper-real-person failed: ${(e && e.message) || e}`);
  process.exit(1);
});
