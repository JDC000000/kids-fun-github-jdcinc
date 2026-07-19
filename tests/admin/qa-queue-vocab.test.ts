// tests/admin/qa-queue-vocab.test.ts — G-T34-5 pure vocab/validator tests (no DB).
import { describe, expect, it } from 'vitest';
import { parseReviewNote, isReviewIntent, REVIEW_STATES, REVIEW_INTENTS, MAX_REVIEW_NOTE } from '@/app/admin/qa-queue/_lib/vocab';

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
});
