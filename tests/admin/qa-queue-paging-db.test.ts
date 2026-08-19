// tests/admin/qa-queue-paging-db.test.ts — the QA review queue is PAGED, not capped.
//
// THE BUG THIS PINS. listReviewQueue() used to take `limit = 100` and order oldest-flagged
// first, with no offset and no total. That is not "the first 100 of many" — it is a hard
// REACHABILITY ceiling: row 101 onward could not be reached by any URL, any click, or any
// admin, and the rows it hid were always the most recently flagged ones. Measured against
// production on 2026-08-19: 2590 occurrences in a review state, so 2490 of them (96%) were
// invisible to the console, and the page rendered a full-looking table that said nothing
// about the other 2490.
//
// WHY IT SURVIVED A GREEN SUITE. Every existing queue test seeds a handful of rows into a
// freshly-bootstrapped database, where 100 is never reached — the assertion "my row is in the
// queue" passes for the wrong reason. The defect only exists above the cap, so the test that
// catches it must CREATE cardinality rather than assume it. This file seeds
// REVIEW_QUEUE_PAGE_SIZE + 25 rows and then asserts the property the cap violated: every
// queued row is reachable by paging, exactly once. Against the pre-fix reader the last 25
// seeded rows are returned by nothing, at any page, and this file fails.
//
// It also covers the dedup-pair review path, which is the same reader (§2c: "same cap + cause
// affects the dedup-pair review path") — a flagged pair seeded near the END of the queue must
// still arrive with its canonical side-by-side context intact once paged to.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '@/lib/db/client';
import { listReviewQueue } from '@/app/admin/qa-queue/_lib/data';
import { REVIEW_QUEUE_PAGE_SIZE } from '@/app/admin/qa-queue/_lib/vocab';
import { collectReviewQueue } from './review-queue-walk';

const hasDb = Boolean(process.env.DATABASE_URL);
const FAMILY = 'test_qa_queue_paging';
/** Deliberately more than one page — the whole point is to exceed the old ceiling. */
const OVERFLOW = 25;
const SEEDED = REVIEW_QUEUE_PAGE_SIZE + OVERFLOW;

describe.skipIf(!hasDb)('QA review queue paging (§2c — 100-row reachability cap)', () => {
  let sourceId = '';
  let seriesId = '';
  let seededIds: string[] = [];
  let canonicalId = '';
  let dedupCandidateId = '';

  beforeAll(async () => {
    const [src] = await query<{ id: string }>(
      `INSERT INTO source (family, name, authority_tier, ingestion_method, terms_status)
       VALUES ($1, 'QA Queue Paging Source', 'official', 'auto', 'allowed') RETURNING id`,
      [FAMILY]
    );
    sourceId = src.id;
    const [ser] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ('QA Queue Paging Series', $1) RETURNING id`,
      [sourceId]
    );
    seriesId = ser.id;

    // Distinct, strictly increasing created_at values: the seeded block is unambiguously the
    // NEWEST end of the queue, which is precisely the end the old oldest-first cap amputated.
    const seeded = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state, created_at)
       SELECT $1, 'QA Paging Row ' || i, '2026-12-01T18:00:00Z', 'needs_review',
              now() + (i || ' seconds')::interval
         FROM generate_series(1, $2::int) AS i
       RETURNING id`,
      [seriesId, SEEDED]
    );
    seededIds = seeded.map((r) => r.id);

    // A dedup pair whose candidate sits in the seeded block's overflow tail — i.e. beyond the
    // old cap — so the dedup review path is exercised where it used to be unreachable.
    const [canon] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state)
       VALUES ($1, 'QA Paging Canonical', '2026-12-01T18:00:00Z', 'confirmed') RETURNING id`,
      [seriesId]
    );
    canonicalId = canon.id;
    const [dup] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state, created_at)
       VALUES ($1, 'QA Paging Duplicate', '2026-12-01T18:00:00Z', 'manual_candidate', now() + ($2 || ' seconds')::interval)
       RETURNING id`,
      [seriesId, SEEDED + 1]
    );
    dedupCandidateId = dup.id;
    await query(
      `INSERT INTO llm_batch_decision (job_name, use_case, target_id, related_id, custom_id, action, deterministic_score, llm_confidence, detail)
       VALUES ('llm_dedup_adjudication', 'dedup', $1, $2, $3, 'route_to_review', 0.66, 0.81, $4::jsonb)`,
      [dedupCandidateId, canonicalId, `paging-${dedupCandidateId}`, JSON.stringify({ reason: 'Paged dedup pair' })]
    );
  });

  afterAll(async () => {
    if (dedupCandidateId) await query(`DELETE FROM llm_batch_decision WHERE target_id = $1`, [dedupCandidateId]);
    if (seriesId) await query(`DELETE FROM activity_occurrence WHERE series_id = $1`, [seriesId]);
    if (seriesId) await query(`DELETE FROM activity_series WHERE id = $1`, [seriesId]);
    if (sourceId) await query(`DELETE FROM source WHERE id = $1`, [sourceId]);
    await closePool();
  });

  it('a full page reports the total beyond it, instead of looking complete', async () => {
    const page = await listReviewQueue({ limit: REVIEW_QUEUE_PAGE_SIZE, offset: 0 });
    expect(page.items).toHaveLength(REVIEW_QUEUE_PAGE_SIZE);
    // The number the console needs to say "there is more" — the old reader had no such number,
    // which is why a capped table was indistinguishable from a complete one.
    expect(page.total).toBeGreaterThanOrEqual(SEEDED + 1);
    expect(page.total).toBeGreaterThan(page.items.length);
  });

  it('EVERY queued row is reachable by paging — exactly once, in order', async () => {
    const walked = await collectReviewQueue();
    const ids = walked.map((r) => r.id);

    expect(new Set(ids).size, 'a row must not be served on two pages').toBe(ids.length);
    for (const id of seededIds) {
      expect(ids, `seeded row ${id} is unreachable through the queue`).toContain(id);
    }
    // The regression in one assertion: the rows past the old ceiling.
    const beyondOldCap = seededIds.slice(REVIEW_QUEUE_PAGE_SIZE);
    expect(beyondOldCap).toHaveLength(OVERFLOW);
    expect(beyondOldCap.every((id) => ids.includes(id))).toBe(true);

    const createdAt = walked.map((r) => Date.parse(r.createdAt));
    for (let i = 1; i < createdAt.length; i++) {
      expect(createdAt[i], 'queue order must stay oldest-first across page boundaries').toBeGreaterThanOrEqual(
        createdAt[i - 1]
      );
    }
  });

  it('paging is stable: consecutive pages neither repeat nor skip a row', async () => {
    const size = 40;
    const first = await listReviewQueue({ limit: size, offset: 0 });
    const second = await listReviewQueue({ limit: size, offset: size });
    const straddling = await listReviewQueue({ limit: size * 2, offset: 0 });

    expect(straddling.items.map((r) => r.id)).toEqual([...first.items, ...second.items].map((r) => r.id));
  });

  it('a flagged dedup pair past the old cap still arrives with its canonical context', async () => {
    const walked = await collectReviewQueue();
    const position = walked.findIndex((r) => r.id === dedupCandidateId);

    expect(position, 'the dedup candidate must be reachable at all').toBeGreaterThanOrEqual(0);
    expect(position + 1, 'this fixture is only meaningful past the old cap').toBeGreaterThan(REVIEW_QUEUE_PAGE_SIZE);

    const row = walked[position];
    expect(row.dedup?.canonicalId).toBe(canonicalId);
    expect(row.dedup?.canonicalName).toBe('QA Paging Canonical');
    expect(row.dedup?.canonicalAvailable).toBe(true);
    expect(row.dedup?.reason).toBe('Paged dedup pair');
  });

  it('an offset past the end reports the true total rather than an empty queue', async () => {
    const { total } = await listReviewQueue({ limit: REVIEW_QUEUE_PAGE_SIZE, offset: 0 });
    const past = await listReviewQueue({ limit: REVIEW_QUEUE_PAGE_SIZE, offset: total + 500 });

    expect(past.items).toHaveLength(0);
    // "No rows here" and "no rows anywhere" are different facts; conflating them would tell a
    // reviewer the queue is clear while 2590 records wait one page back.
    expect(past.total).toBe(total);
  });

  it('a caller cannot ask for an unbounded page', async () => {
    const huge = await listReviewQueue({ limit: 10_000, offset: 0 });
    expect(huge.limit).toBe(500); // MAX_REVIEW_QUEUE_PAGE_SIZE
    expect(huge.items.length).toBeLessThanOrEqual(500);

    const negative = await listReviewQueue({ limit: -5, offset: -20 });
    expect(negative.limit).toBe(1);
    expect(negative.offset).toBe(0);
  });
});
