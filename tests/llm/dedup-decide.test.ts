// tests/llm/dedup-decide.test.ts — the PURE dedup adjudication logic (no DB): canonical
// choice + the conservative, fail-closed decision matrix.
import { describe, expect, it } from 'vitest';
import { chooseCanonical, decideDedup, type DedupCandidate, type OccurrenceSide } from '../../lib/llm/dedup';
import type { DedupVerdict } from '../../lib/llm/prompts';

function side(over: Partial<OccurrenceSide> & { id: string }): OccurrenceSide {
  return {
    name: 'Storytime',
    description: null,
    sourceName: 'src',
    authorityTier: 'editorial',
    confidenceLabel: 'unscored',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function candidate(det: number, over: Partial<DedupCandidate> = {}): DedupCandidate {
  return {
    left: side({ id: 'L', authorityTier: 'partner' }),
    right: side({ id: 'R', authorityTier: 'official' }),
    startUtc: '2026-08-01T18:00:00.000Z',
    deterministicScore: det,
    customId: 'dedup:L:R',
    ...over,
  };
}

describe('chooseCanonical', () => {
  it('keeps the higher-authority source as canonical', () => {
    const c = chooseCanonical(side({ id: 'a', authorityTier: 'partner' }), side({ id: 'b', authorityTier: 'official' }));
    expect(c.canonical.id).toBe('b');
    expect(c.duplicate.id).toBe('a');
  });
  it('breaks ties by confidence, then age, then id', () => {
    const older = side({ id: 'old', authorityTier: 'official', confidenceLabel: 'medium', createdAt: '2026-01-01T00:00:00Z' });
    const newer = side({ id: 'new', authorityTier: 'official', confidenceLabel: 'medium', createdAt: '2026-06-01T00:00:00Z' });
    expect(chooseCanonical(newer, older).canonical.id).toBe('old');
    const hi = side({ id: 'hi', authorityTier: 'official', confidenceLabel: 'high' });
    const lo = side({ id: 'lo', authorityTier: 'official', confidenceLabel: 'low' });
    expect(chooseCanonical(lo, hi).canonical.id).toBe('hi');
  });
});

const dup = (confidence: number): DedupVerdict => ({ isDuplicate: true, confidence, reason: 'r' });
const notDup = (confidence: number): DedupVerdict => ({ isDuplicate: false, confidence, reason: 'r' });

describe('decideDedup — conservative, fail-closed matrix', () => {
  it('AUTO-MERGE only when BOTH model confidence ≥ 0.90 AND deterministic similarity ≥ 0.55', () => {
    expect(decideDedup(candidate(0.6), dup(0.95)).action).toBe('auto_merge');
    expect(decideDedup(candidate(0.55), dup(0.9)).action).toBe('auto_merge'); // exactly on both bars
  });

  it('routes to review when the model thinks duplicate but a bar is missed', () => {
    expect(decideDedup(candidate(0.6), dup(0.89)).action).toBe('route_to_review'); // confidence too low
    expect(decideDedup(candidate(0.5), dup(0.99)).action).toBe('route_to_review'); // similarity too low
  });

  it('SKIPS a confident non-duplicate (never merges — under-merge is the safe failure)', () => {
    expect(decideDedup(candidate(0.9), notDup(0.95)).action).toBe('skip');
    expect(decideDedup(candidate(0.9), notDup(0.2)).action).toBe('skip');
  });

  it('routes to review when there is NO usable verdict (errored / unparseable)', () => {
    expect(decideDedup(candidate(0.9), null).action).toBe('route_to_review');
  });

  it('always names the higher-authority record as canonical and the other as the duplicate', () => {
    const d = decideDedup(candidate(0.6), dup(0.95));
    expect(d.canonicalId).toBe('R'); // official beats partner
    expect(d.duplicateId).toBe('L');
  });
});
