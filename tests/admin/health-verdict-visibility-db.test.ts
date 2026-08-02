// tests/admin/health-verdict-visibility-db.test.ts — F-11 regression suite.
//
// THE BUG. An adapter's health verdict (AdapterRunDiagnostics with alert=true —
// phone_rejection_spike, shape_drift, coverage_truncated, coverage_shortfall,
// asset_build_drift) fired correctly, was recorded correctly, and reached NO operator:
//   • the dashboard's failures panel queried WHERE status = 'failed', but an alerting run
//     still upserts its occurrences and so lands as 'partial' — invisible;
//   • both SLA read paths counted 'partial' as SUCCEEDED, for the success ratio AND for the
//     last-success timestamp, so raising an alarm made the headline number look BETTER.
//
// Every test here seeds real source_check_run rows and asserts against the real SQL. The
// three-run fixture is the whole point: a clean success, a PLAIN partial (records errored,
// no verdict), and an ALERTING partial. The two partials are what make the suite discriminating
// — a fix that merely widened the panel to status IN ('failed','partial') would surface the
// plain one too, and one that treated every partial as a non-success would strip the plain one
// of its last-success credit. Both mistakes go red here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getHealthAlerts, getIngestionHealth } from '../../lib/admin/dashboard';
import { getSourceFreshnessSla } from '../../lib/admin/data-health';
import { computeHealthSla } from '../../worker/health/sla';
import { finishCheckRun } from '../../worker/core/checkrun';
import { recordActiveNetCheckRun } from '../../worker/adapters/activenet/health';
import { recordPerfectMindCheckRun } from '../../worker/adapters/perfectmind/health';
import { getPool, query, closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const TAG = `f11_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!hasDb)('F-11 — a health verdict reaches the operator', () => {
  const sourceIds: string[] = [];
  /** The source carrying all three run shapes. */
  let mixedSourceId = '';
  let cleanRunId = '';
  let alertingRunId = '';
  let plainPartialRunId = '';
  let dbNowMs = 0;

  async function mkSource(label: string): Promise<string> {
    const [s] = await query<{ id: string }>(
      `INSERT INTO source (family, name, terms_status, authority_tier, baseline_cadence)
       VALUES ('noop', $1, 'allowed', 'official', '1 day') RETURNING id`,
      [`${TAG} ${label}`]
    );
    sourceIds.push(s.id);
    return s.id;
  }

  beforeAll(async () => {
    const [n] = await query<{ now: string }>(`SELECT now()::text AS now`);
    dbNowMs = Date.parse(n.now);

    mixedSourceId = await mkSource('mixed');

    // Oldest → newest, all inside the 7-day window and inside a 1-day cadence's grace,
    // so ordering (not age) decides which run is "last".
    [{ id: cleanRunId }] = [
      (
        await query<{ id: string }>(
          `INSERT INTO source_check_run (source_id, status, records_found, started_at, duration_ms)
           VALUES ($1, 'success', 40, now() - interval '5 hours', 900) RETURNING id`,
          [mixedSourceId]
        )
      )[0],
    ];

    // A plain partial: some records errored, NO adapter verdict. Must stay OUT of the panel.
    [{ id: plainPartialRunId }] = [
      (
        await query<{ id: string }>(
          `INSERT INTO source_check_run (source_id, status, records_found, started_at, duration_ms, errors)
           VALUES ($1, 'partial', 38, now() - interval '3 hours', 900,
                   '["record abc-1: bad start date"]'::jsonb) RETURNING id`,
          [mixedSourceId]
        )
      )[0],
    ];

    // The F-11 run: ingested fine (so status='partial', records present) but the adapter
    // raised a real alarm. This is the row that used to be invisible everywhere.
    [{ id: alertingRunId }] = [
      (
        await query<{ id: string }>(
          `INSERT INTO source_check_run
             (source_id, status, records_found, started_at, duration_ms, errors,
              health_alert_code, health_alert_detail)
           VALUES ($1, 'partial', 41, now() - interval '1 hour', 900,
                   '["run health [phone_rejection_spike]: 9 of 10 phones rejected for vancouver"]'::jsonb,
                   'phone_rejection_spike', '9 of 10 phones rejected for vancouver') RETURNING id`,
          [mixedSourceId]
        )
      )[0],
    ];
  });

  afterAll(async () => {
    for (const id of sourceIds) {
      await query(`DELETE FROM source_check_run WHERE source_id = $1`, [id]);
      await query(`DELETE FROM source WHERE id = $1`, [id]);
    }
    await closePool();
  });

  // ── the panel ─────────────────────────────────────────────────────────────────────────

  it('surfaces an alerting run on the attention panel even though its status is partial', async () => {
    const alerts = await getHealthAlerts(dbNowMs);
    const row = alerts.runsNeedingAttention.find((r) => r.checkRunId === alertingRunId);
    expect(row, 'the alerting partial run must appear on the panel').toBeDefined();
    expect(row!.status).toBe('partial'); // NOT 'failed' — that is the whole bug
    expect(row!.healthAlertCode).toBe('phone_rejection_spike');
    expect(row!.healthAlertDetail).toBe('9 of 10 phones rejected for vancouver');
  });

  it('does NOT surface a plain partial run that raised no verdict', async () => {
    // The guard against the "obvious" fix: widening the panel to status IN ('failed','partial')
    // would flood it with ordinary per-record noise and train operators to ignore it.
    const alerts = await getHealthAlerts(dbNowMs);
    expect(alerts.runsNeedingAttention.map((r) => r.checkRunId)).not.toContain(plainPartialRunId);
    expect(alerts.runsNeedingAttention.map((r) => r.checkRunId)).not.toContain(cleanRunId);
  });

  it('still surfaces plain failed runs (the pre-existing behaviour is intact)', async () => {
    const failSourceId = await mkSource('hard-failure');
    const [run] = await query<{ id: string }>(
      `INSERT INTO source_check_run (source_id, status, started_at, duration_ms, errors)
       VALUES ($1, 'failed', now() - interval '2 hours', 100, '["fetch/extract: portal blocked"]'::jsonb)
       RETURNING id`,
      [failSourceId]
    );
    const alerts = await getHealthAlerts(dbNowMs);
    const row = alerts.runsNeedingAttention.find((r) => r.checkRunId === run.id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('failed');
    expect(row!.healthAlertCode).toBeNull();
    expect(row!.errorSummary).toContain('portal blocked');
  });

  // ── the SLA numbers ───────────────────────────────────────────────────────────────────

  it('an alerting run is not the source’s last successful check (worker + admin agree)', async () => {
    // The expected answer is the PLAIN PARTIAL (3h ago), not the alerting partial (1h ago)
    // and not the clean success (5h ago). That is the precise line this fix draws: a partial
    // run is still a successful refresh — only a run carrying a health verdict stops being
    // one. Pinning the middle row rather than the oldest is what proves the predicate keys
    // off the alert and not off `status`.
    const [expected] = await query<{ started_at: string }>(
      `SELECT started_at::text FROM source_check_run WHERE id = $1`,
      [plainPartialRunId]
    );
    const expectedIso = new Date(expected.started_at).toISOString();
    const [alerting] = await query<{ started_at: string }>(
      `SELECT started_at::text FROM source_check_run WHERE id = $1`,
      [alertingRunId]
    );
    expect(new Date(alerting.started_at).getTime()).toBeGreaterThan(new Date(expected.started_at).getTime());

    // Worker-side canonical SLA.
    const workerSla = await computeHealthSla(getPool(), dbNowMs);
    const workerRow = workerSla.sources.find((s) => s.sourceId === mixedSourceId)!;
    expect(workerRow.lastSuccessAt).toBe(expectedIso); // the plain partial, NOT the newer alerting one

    // /admin/data-health display SLA — must land on the SAME run, not merely be internally
    // consistent. These are two hand-maintained copies of one predicate; that is exactly the
    // divergence tests/health/sla-consistency.test.ts exists to prevent.
    const adminSla = await getSourceFreshnessSla(dbNowMs);
    const adminRow = adminSla.sources.find((s) => s.sourceId === mixedSourceId)!;
    expect(adminRow.lastSuccessAt).toBe(workerRow.lastSuccessAt);

    // …and the ops dashboard's per-source ingestion table, the third copy.
    const ingestion = await getIngestionHealth();
    const ingestionRow = ingestion.find((s) => s.sourceId === mixedSourceId)!;
    expect(ingestionRow.lastSuccessfulCheckAt).toBe(workerRow.lastSuccessAt);
    // The LATEST run is still reported as-is — this fix hides nothing, it only stops an
    // alerting run from being called a success.
    expect(ingestionRow.latestRunStatus).toBe('partial');
  });

  it('an alerting run counts as attempted but NOT as succeeded, so the ratio drops', async () => {
    const sla = await computeHealthSla(getPool(), dbNowMs);
    const row = sla.sources.find((s) => s.sourceId === mixedSourceId)!;
    // 3 completed runs: 1 clean success + 1 plain partial (clean) + 1 alerting partial.
    expect(row.counts.attempted).toBe(3);
    expect(row.counts.succeeded).toBe(2);
    expect(row.counts.withRecords).toBe(2);
    expect(row.successRate).toBeCloseTo(2 / 3, 10);
    // Before the fix this read 3/3 = 1.0 — raising an alarm made the board look perfect.
    expect(row.successRate).toBeLessThan(1);
    // withRecords is computed on the same alert-free basis, so yield can never exceed 1.
    expect(row.parseYieldRate!).toBeLessThanOrEqual(1);
  });

  // ── the write path ────────────────────────────────────────────────────────────────────

  it('finishCheckRun persists the verdict, and omitting it clears the columns', async () => {
    const writeSourceId = await mkSource('write-path');
    const startedAt = new Date(dbNowMs);
    const [run] = await query<{ id: string }>(
      `INSERT INTO source_check_run (source_id, status, started_at) VALUES ($1, 'running', $2) RETURNING id`,
      [writeSourceId, startedAt]
    );

    await finishCheckRun(getPool(), run.id, {
      status: 'partial',
      recordsFound: 12,
      errors: ['run health [shape_drift]: unrecognised payload keys for burnaby: sessionKind'],
      healthAlert: { code: 'shape_drift', detail: 'unrecognised payload keys for burnaby: sessionKind' },
      startedAt,
    });
    const [withAlert] = await query<{ health_alert_code: string | null; health_alert_detail: string | null }>(
      `SELECT health_alert_code, health_alert_detail FROM source_check_run WHERE id = $1`,
      [run.id]
    );
    expect(withAlert.health_alert_code).toBe('shape_drift');
    expect(withAlert.health_alert_detail).toBe('unrecognised payload keys for burnaby: sessionKind');

    // A later clean run on the same row id must not inherit the previous verdict — the
    // UPDATE writes NULL explicitly rather than leaving the column alone.
    await finishCheckRun(getPool(), run.id, { status: 'success', recordsFound: 12, startedAt });
    const [cleared] = await query<{ health_alert_code: string | null }>(
      `SELECT health_alert_code FROM source_check_run WHERE id = $1`,
      [run.id]
    );
    expect(cleared.health_alert_code).toBeNull();
  });

  it('the adapters’ own out-of-band recorders persist their verdict too', async () => {
    // recordActiveNetCheckRun / recordPerfectMindCheckRun write a check-run row WITHOUT going
    // through ingestSource — used when a fetch never reached the ingest loop, or for a
    // post-hoc yield assessment. They are a second write path, and a fix that only plumbed
    // ingestSource would leave every alert raised through here just as invisible as before.
    const anSourceId = await mkSource('activenet-recorder');
    const pmSourceId = await mkSource('perfectmind-recorder');

    const anRunId = await recordActiveNetCheckRun(getPool(), anSourceId, {
      code: 'shape_drift',
      status: 'partial', // NOT 'failed' — the case the old panel filter missed
      alert: true,
      detail: 'unrecognised payload keys for vancouver: sessionKind',
      occurrences: 120,
    });
    const pmRunId = await recordPerfectMindCheckRun(getPool(), pmSourceId, {
      code: 'coverage_shortfall',
      status: 'partial',
      alert: true,
      detail: '3 of 11 centres returned nothing',
      occurrences: 88,
    });
    // A non-alerting verdict through the same path must NOT be flagged.
    const okRunId = await recordActiveNetCheckRun(getPool(), anSourceId, {
      code: 'ok',
      status: 'success',
      alert: false,
      detail: '120 occurrences in 3 requests',
      occurrences: 120,
    });

    const codes = await query<{ id: string; health_alert_code: string | null }>(
      `SELECT id, health_alert_code FROM source_check_run WHERE id = ANY($1::uuid[])`,
      [[anRunId, pmRunId, okRunId]]
    );
    const codeFor = (id: string) => codes.find((r) => r.id === id)!.health_alert_code;
    expect(codeFor(anRunId)).toBe('shape_drift');
    expect(codeFor(pmRunId)).toBe('coverage_shortfall');
    expect(codeFor(okRunId)).toBeNull();

    const alerts = await getHealthAlerts(dbNowMs);
    const shown = alerts.runsNeedingAttention.map((r) => r.checkRunId);
    expect(shown).toContain(anRunId);
    expect(shown).toContain(pmRunId);
    expect(shown).not.toContain(okRunId);
  });

  // ── the backfill ──────────────────────────────────────────────────────────────────────

  it('migration 0026’s backfill recovers verdicts already buried in the errors array', async () => {
    // Runs the EXACT statement the migration ships, against a legacy-shaped row (verdict
    // present only as prose, columns NULL) — the state every pre-0026 alert is in. Reading it
    // from the file rather than restating it means the test cannot pass a backfill the
    // migration does not actually perform.
    const sql = readFileSync(new URL('../../supabase/migrations/0026_check_run_health_verdict.sql', import.meta.url), 'utf8');
    const start = sql.indexOf('UPDATE source_check_run cr');
    const end = sql.indexOf('AND v.code IS NOT NULL;', start);
    expect(start, 'backfill statement not found in migration 0026').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const backfill = sql.slice(start, end + 'AND v.code IS NOT NULL;'.length);

    const legacySourceId = await mkSource('legacy-backfill');
    const [legacy] = await query<{ id: string }>(
      `INSERT INTO source_check_run (source_id, status, records_found, started_at, errors)
       VALUES ($1, 'partial', 7, now() - interval '4 hours',
               '["record xyz: bad date", "run health [coverage_shortfall]: 3 of 11 centres returned nothing"]'::jsonb)
       RETURNING id`,
      [legacySourceId]
    );
    // A run whose only errors are ordinary per-record ones must be left untouched.
    const [noise] = await query<{ id: string }>(
      `INSERT INTO source_check_run (source_id, status, records_found, started_at, errors)
       VALUES ($1, 'partial', 7, now() - interval '4 hours', '["record xyz: bad date"]'::jsonb)
       RETURNING id`,
      [legacySourceId]
    );

    await query(backfill);

    const [filled] = await query<{ health_alert_code: string | null; health_alert_detail: string | null }>(
      `SELECT health_alert_code, health_alert_detail FROM source_check_run WHERE id = $1`,
      [legacy.id]
    );
    expect(filled.health_alert_code).toBe('coverage_shortfall');
    expect(filled.health_alert_detail).toBe('3 of 11 centres returned nothing');

    const [untouched] = await query<{ health_alert_code: string | null }>(
      `SELECT health_alert_code FROM source_check_run WHERE id = $1`,
      [noise.id]
    );
    expect(untouched.health_alert_code).toBeNull();

    // The OTHER legacy shape. recordActiveNetCheckRun/recordPerfectMindCheckRun write
    // `errors` as an OBJECT, not an array — a backfill that only handled the array shape
    // would silently recover half the historical alerts and look complete.
    const [objLegacy] = await query<{ id: string }>(
      `INSERT INTO source_check_run (source_id, status, records_found, started_at, errors)
       VALUES ($1, 'partial', 5, now() - interval '4 hours',
               '{"code":"shape_drift","detail":"unrecognised payload keys for burnaby","warnings":[]}'::jsonb)
       RETURNING id`,
      [legacySourceId]
    );
    // …and its non-alerting counterpart: that object is ALSO written for an `ok` verdict that
    // merely carried warnings, which must not become an alert.
    const [objOk] = await query<{ id: string }>(
      `INSERT INTO source_check_run (source_id, status, records_found, started_at, errors)
       VALUES ($1, 'success', 5, now() - interval '4 hours',
               '{"code":"ok","detail":"40 occurrences in 3 requests","warnings":["a note"]}'::jsonb)
       RETURNING id`,
      [legacySourceId]
    );

    await query(backfill);

    const [objFilled] = await query<{ health_alert_code: string | null; health_alert_detail: string | null }>(
      `SELECT health_alert_code, health_alert_detail FROM source_check_run WHERE id = $1`,
      [objLegacy.id]
    );
    expect(objFilled.health_alert_code).toBe('shape_drift');
    expect(objFilled.health_alert_detail).toBe('unrecognised payload keys for burnaby');

    const [objUntouched] = await query<{ health_alert_code: string | null }>(
      `SELECT health_alert_code FROM source_check_run WHERE id = $1`,
      [objOk.id]
    );
    expect(objUntouched.health_alert_code).toBeNull();
  });
});
