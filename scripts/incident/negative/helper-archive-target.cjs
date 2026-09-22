const { Client } = require('pg');
const M = require(require('node:path').join(__dirname, '..', 'manifest-2026-09-21-fixture-pollution.json'));
(async () => {
  const c = new Client({ connectionString: process.env.U }); await c.connect();
  await c.query('UPDATE activity_occurrence SET archived_at = $2 WHERE id = $1',
    [M.target_occurrence_ids[0], '2026-09-22T01:00:00Z']);
  await c.end();
})();
