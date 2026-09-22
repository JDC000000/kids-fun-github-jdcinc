const { Client } = require('pg');
const M = require(require('node:path').join(__dirname, '..', 'manifest-2026-09-21-fixture-pollution.json'));
(async () => {
  const c = new Client({ connectionString: process.env.U }); await c.connect();
  await c.query('INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING', [M.orphan_profile_ids[0]]);
  await c.end();
})();
