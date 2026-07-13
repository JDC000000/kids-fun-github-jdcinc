import { describe, it, expect, afterEach, afterAll, beforeEach } from 'vitest';
import { NoopAdapter } from '../../worker/core/adapter';
import { enqueue, dequeue, markDone, markFailed } from '../../worker/core/queue';
import { startCheckRun, finishCheckRun } from '../../worker/core/checkrun';
import { recordProvenance } from '../../worker/core/provenance';
import { upsertOccurrence } from '../../worker/core/upsert';
import { enqueueDueJobs } from '../../worker/scheduler/tiered';
import {
  RateLimiter,
  recordResponse,
  isDisabled,
  clearBackoffState,
  buildConditionalHeaders,
} from '../../worker/core/politeness';
import { evaluateTermsGate } from '../../worker/core/terms-gate';
import { getPool, query, closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);

// G-T5-1 — adapter contract (pure, no DB): compiles + NoopAdapter satisfies it.
describe('Adapter contract (G-T5-1)', () => {
  it('NoopAdapter satisfies the Adapter interface end-to-end', async () => {
    const adapter = new NoopAdapter();
    const raw = await adapter.fetch();
    const records = await adapter.extract(raw);
    expect(records.length).toBeGreaterThan(0);
    const key = adapter.dedupKeys(records[0]);
    expect(key.key).toContain('noop::');
  });
});

// G-T5-5 — crawl politeness (pure, no DB).
describe('Crawl politeness (G-T5-5)', () => {
  afterEach(() => clearBackoffState());

  it('a 429 response trips backoff + disable', () => {
    const state = recordResponse('src-1', 429);
    expect(state.consecutiveFailures).toBe(1);
    expect(isDisabled('src-1')).toBe(true);
  });

  it('a 403 response also trips backoff + disable', () => {
    recordResponse('src-2', 403);
    expect(isDisabled('src-2')).toBe(true);
  });

  it('a 2xx response clears backoff', () => {
    recordResponse('src-3', 429);
    expect(isDisabled('src-3')).toBe(true);
    recordResponse('src-3', 200);
    expect(isDisabled('src-3')).toBe(false);
  });

  it('rate limiter caps request rate (waits for the minimum interval)', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 60 }); // 1 req/sec
    let clock = 0;
    const waits: number[] = [];
    const now = () => clock;
    const sleepImpl = async (ms: number) => {
      waits.push(ms);
      clock += ms;
    };
    await limiter.wait(now, sleepImpl); // first call: no wait
    clock += 100; // only 100ms elapsed, need >= 1000ms
    await limiter.wait(now, sleepImpl);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(890);
  });

  it('builds conditional headers with an identified user-agent', () => {
    const headers = buildConditionalHeaders({ etag: 'abc123' });
    expect(headers['User-Agent']).toContain('KidsFunBot');
    expect(headers['If-None-Match']).toBe('abc123');
  });
});

// G-T5-6 — terms/robots gate (pure, no DB).
describe('Terms/robots gate (G-T5-6)', () => {
  it('refuses a pending source in production', () => {
    const decision = evaluateTermsGate({ id: 's1', termsStatus: 'pending' }, 'production');
    expect(decision.allowed).toBe(false);
  });

  it('allows an allowed/summarise_only source in production', () => {
    expect(evaluateTermsGate({ id: 's1', termsStatus: 'allowed' }, 'production').allowed).toBe(true);
    expect(evaluateTermsGate({ id: 's1', termsStatus: 'summarise_only' }, 'production').allowed).toBe(true);
  });

  it('allows review-safe statuses in staging but refuses explicit blocks', () => {
    expect(evaluateTermsGate({ id: 's1', termsStatus: 'pending' }, 'staging').allowed).toBe(true);
    expect(evaluateTermsGate({ id: 's1', termsStatus: 'allowed' }, 'staging').allowed).toBe(true);
    expect(evaluateTermsGate({ id: 's1', termsStatus: 'summarise_only' }, 'staging').allowed).toBe(true);
    expect(evaluateTermsGate({ id: 's1', termsStatus: 'disallowed' }, 'staging').allowed).toBe(false);
    expect(evaluateTermsGate({ id: 's1', termsStatus: 'blocked' }, 'staging').allowed).toBe(false);
  });

  it('refuses robots-disallowed sources in every environment', () => {
    expect(evaluateTermsGate({ id: 's1', termsStatus: 'allowed', robotsStatus: 'disallowed' }, 'staging').allowed).toBe(false);
    expect(evaluateTermsGate({ id: 's1', termsStatus: 'allowed', robotsStatus: 'disallowed' }, 'production').allowed).toBe(false);
  });
});

// G-T5-2 / G-T5-4 — job queue + provenance/upsert/check-run, DB-backed.
describe.skipIf(!hasDb)('Job queue + no-op ingest pipeline (G-T5-2, G-T5-4)', () => {
  let sourceId: string;
  let venueId: string;
  let seriesId: string;

  beforeEach(async () => {
    const suffix = crypto.randomUUID();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`Noop Test Source ${suffix}`]
    );
    sourceId = source.id;
    const [venue] = await query<{ id: string }>(
      `INSERT INTO venue (name) VALUES ('Noop Test Venue') RETURNING id`
    );
    venueId = venue.id;
    const [series] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id, venue_id) VALUES ('Noop Series', $1, $2) RETURNING id`,
      [sourceId, venueId]
    );
    seriesId = series.id;
  });

  afterAll(async () => {
    await closePool();
  });

  it('enqueue -> dequeue marks running, then markDone completes it', async () => {
    const pool = getPool();
    const jobId = await enqueue(pool, sourceId);
    const job = await dequeue(pool);
    expect(job?.id).toBe(jobId);
    expect(job?.attempts).toBe(1);

    const [row] = await query<{ status: string }>(`SELECT status FROM job_queue WHERE id = $1`, [jobId]);
    expect(row.status).toBe('running');

    await markDone(pool, jobId);
    const [after] = await query<{ status: string }>(`SELECT status FROM job_queue WHERE id = $1`, [jobId]);
    expect(after.status).toBe('done');
  });

  it('a failing job retries then dead-letters after max_attempts', async () => {
    const pool = getPool();
    await pool.query(
      `INSERT INTO job_queue (id, source_id, status, attempts, max_attempts) VALUES ($1, $2, 'pending', 2, 3)`,
      [crypto.randomUUID(), sourceId]
    );
    const job = await dequeue(pool); // attempts becomes 3 (== max_attempts)
    expect(job).not.toBeNull();
    await markFailed(pool, job!.id, 'boom');
    const [row] = await query<{ status: string }>(`SELECT status FROM job_queue WHERE id = $1`, [job!.id]);
    expect(row.status).toBe('dead_letter');
  });

  it('no-op adapter run writes one check-run + upserts a fixture occurrence with provenance', async () => {
    const pool = getPool();
    const adapter = new NoopAdapter();
    const { id: checkRunId, startedAt } = await startCheckRun(pool, sourceId);

    const raw = await adapter.fetch();
    const records = await adapter.extract(raw);
    const record = records[0];

    const { occurrenceId, created } = await upsertOccurrence(pool, seriesId, record);
    expect(created).toBe(true);

    await recordProvenance(pool, [
      { occurrenceId, field: 'activity_name', sourceUrl: record.sourceUrl, sourceFamily: adapter.family },
    ]);

    await finishCheckRun(pool, checkRunId, { status: 'success', recordsFound: records.length, startedAt });

    const [checkRun] = await query<{ status: string; records_found: number }>(
      `SELECT status, records_found FROM source_check_run WHERE id = $1`,
      [checkRunId]
    );
    expect(checkRun.status).toBe('success');
    expect(checkRun.records_found).toBe(1);

    const provenanceRows = await query(`SELECT * FROM provenance WHERE occurrence_id = $1`, [occurrenceId]);
    expect(provenanceRows.length).toBeGreaterThanOrEqual(1);

    // Re-ingesting the same record upserts in place (idempotent), not duplicated.
    const second = await upsertOccurrence(pool, seriesId, record);
    expect(second.occurrenceId).toBe(occurrenceId);
    expect(second.created).toBe(false);
  });
});

// G-T5-3 — tiered scheduler, DB-backed.
describe.skipIf(!hasDb)('Tiered scheduler (G-T5-3)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('a tick enqueues jobs only for due sources, reading cadence from the source table', async () => {
    const pool = getPool();
    const suffix = crypto.randomUUID();
    const [due] = await query<{ id: string }>(
      `INSERT INTO source (family, name, baseline_cadence, next_check_at)
       VALUES ('noop', $1, '1 day', now() - interval '1 minute') RETURNING id`,
      [`Due Source ${suffix}`]
    );
    const [notDue] = await query<{ id: string }>(
      `INSERT INTO source (family, name, baseline_cadence, next_check_at)
       VALUES ('noop', $1, '1 day', now() + interval '1 day') RETURNING id`,
      [`Not Due Source ${suffix}`]
    );

    const enqueued = await enqueueDueJobs(pool);
    const ids = enqueued.map((s) => s.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(notDue.id);

    // Second tick is a no-op for the same source (already has a pending job).
    const secondTick = await enqueueDueJobs(pool);
    expect(secondTick.map((s) => s.id)).not.toContain(due.id);
  });
});
