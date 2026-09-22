const { Client } = require('pg');
const M = require(require('node:path').join(__dirname, '..', 'manifest-2026-09-21-fixture-pollution.json'));
(async () => {
  const c = new Client({ connectionString: process.env.U }); await c.connect();
  const r = await c.query(
    `SELECT o.id FROM activity_occurrence o JOIN activity_series s ON s.id = o.series_id
      WHERE s.source_id = ANY($1::uuid[]) LIMIT 1`, [M.leave_alone_source_ids]);
  console.log(r.rows[0] ? r.rows[0].id : '');
  await c.end();
})().catch(() => { console.log(''); });
