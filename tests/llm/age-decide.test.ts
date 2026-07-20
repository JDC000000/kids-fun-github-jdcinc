// tests/llm/age-decide.test.ts — the PURE age-fallback decision (no DB).
import { describe, expect, it } from 'vitest';
import { decideAge } from '../../lib/llm/age-fallback';
import type { AgeVerdict } from '../../lib/llm/prompts';

const v = (over: Partial<AgeVerdict>): AgeVerdict => ({ resolved: true, ageMinMonths: 12, ageMaxMonths: 48, confidence: 0.9, reason: 'r', ...over });

describe('decideAge — apply only a confident, resolved band; else no-op', () => {
  it('APPLIES a resolved verdict at or above the confidence bar', () => {
    const d = decideAge(v({ confidence: 0.8 }));
    expect(d.action).toBe('apply');
    expect(d).toMatchObject({ ageMinMonths: 12, ageMaxMonths: 48 });
  });

  it('NO-OPs a resolved verdict below the confidence bar', () => {
    expect(decideAge(v({ confidence: 0.79 })).action).toBe('no_op');
  });

  it('NO-OPs an unresolved verdict regardless of confidence', () => {
    expect(decideAge(v({ resolved: false, ageMinMonths: null, ageMaxMonths: null, confidence: 0.99 })).action).toBe('no_op');
  });

  it('NO-OPs when there is no usable verdict (errored / unparseable)', () => {
    const d = decideAge(null);
    expect(d.action).toBe('no_op');
    expect(d.llmConfidence).toBeNull();
  });
});
