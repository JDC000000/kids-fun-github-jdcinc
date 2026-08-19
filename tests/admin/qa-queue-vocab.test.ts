// tests/admin/qa-queue-vocab.test.ts — G-T34-5 pure vocab/validator tests (no DB).
import { describe, expect, it } from 'vitest';
import {
  parseReviewNote,
  isReviewIntent,
  parseQueuePageParam,
  REVIEW_STATES,
  REVIEW_INTENTS,
  MAX_REVIEW_NOTE,
  MAX_REVIEW_QUEUE_PAGE,
  REVIEW_QUEUE_PAGE_SIZE,
} from '@/app/admin/qa-queue/_lib/vocab';

describe('QA-queue vocab (G-T34-5)', () => {
  it('REVIEW_STATES are the two awaiting-judgement enum members', () => {
    expect([...REVIEW_STATES]).toEqual(['needs_review', 'manual_candidate']);
  });

  it('isReviewIntent accepts confirm/reject and nothing else', () => {
    expect([...REVIEW_INTENTS]).toEqual(['confirm', 'reject']);
    expect(isReviewIntent('confirm')).toBe(true);
    expect(isReviewIntent('reject')).toBe(true);
    expect(isReviewIntent('archive')).toBe(false);
    expect(isReviewIntent(undefined)).toBe(false);
  });

  it('parseReviewNote trims, nulls empty, and caps length', () => {
    expect(parseReviewNote('  checked venue  ')).toEqual({ ok: true, note: 'checked venue' });
    expect(parseReviewNote('   ')).toEqual({ ok: true, note: null });
    expect(parseReviewNote(undefined)).toEqual({ ok: true, note: null });
    const tooLong = 'x'.repeat(MAX_REVIEW_NOTE + 1);
    expect(parseReviewNote(tooLong).ok).toBe(false);
  });

  it('parseQueuePageParam falls back to page 1 for anything not a whole page number', () => {
    expect(parseQueuePageParam('3')).toBe(3);
    expect(parseQueuePageParam(['4', '9'])).toBe(4); // repeated ?page= — first wins
    expect(parseQueuePageParam('  7 ')).toBe(7);
    for (const bad of [undefined, '', '0', '-2', '1.5', 'abc', '2; DROP TABLE', 'NaN', 'Infinity']) {
      expect(parseQueuePageParam(bad), `"${bad}" must not be honoured as a page`).toBe(1);
    }
  });

  it('parseQueuePageParam bounds the page so page → OFFSET stays inside int4', () => {
    expect(parseQueuePageParam(String(MAX_REVIEW_QUEUE_PAGE + 1))).toBe(MAX_REVIEW_QUEUE_PAGE);
    expect(parseQueuePageParam('999999999999')).toBe(MAX_REVIEW_QUEUE_PAGE);
    // The bound is arithmetic, not a reachability limit — it must stay far above any real queue.
    expect(MAX_REVIEW_QUEUE_PAGE * REVIEW_QUEUE_PAGE_SIZE).toBeGreaterThan(1_000_000);
  });
});
