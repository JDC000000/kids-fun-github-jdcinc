const { Client } = require('pg');
const { assertLoopback } = require('./_local-only.cjs');
const M = require(require('node:path').join(__dirname, '..', 'manifest-2026-09-21-fixture-pollution.json'));
assertLoopback(process.env.U);

// ═══ WHY try/finally AND NOT A .catch() TAIL ═══
// This ended with `.catch(() => { console.log(''); })`, which is worse than having no handler at
// all, in two compounding ways found by review and reproduced here:
//
//   1. It never closed the client, so a failure AFTER a successful connect left the pg socket
//      open, the event loop non-empty, and the process hung forever. Measured: exit 124 under a
//      timeout. The two sibling helpers, which have NO handler, merely exit 1 on the unhandled
//      rejection — so the error handling added for robustness is precisely what turned a fast
//      failure into a hang.
//   2. Printing an empty line on failure made the failure look like a legitimate "no stray
//      occurrence found" result. The suite then skipped its case silently and still reported a
//      clean run. A broken helper must never be indistinguishable from a negative result.
//
// So: the client is closed on every path, and a failure exits non-zero and says so on stderr.
(async () => {
  const c = new Client({ connectionString: process.env.U });
  try {
    await c.connect();
    const r = await c.query(
      `SELECT o.id FROM activity_occurrence o JOIN activity_series s ON s.id = o.series_id
        WHERE s.source_id = ANY($1::uuid[]) LIMIT 1`, [M.leave_alone_source_ids]);
    process.stdout.write(r.rows[0] ? String(r.rows[0].id) : '');
  } finally {
    await c.end().catch(() => {});
  }
})().catch((e) => {
  console.error(`helper-stray-occ failed: ${(e && e.message) || e}`);
  process.exit(1);
});
