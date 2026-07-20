// tests/llm/prompts.test.ts — the cacheable-prefix design + fail-closed parsers.
import { describe, expect, it } from 'vitest';
import {
  buildDedupSystem,
  buildDedupUser,
  buildAgeSystem,
  buildAgeUser,
  buildCategoryCostSystem,
  buildCategoryCostUser,
  parseDedupVerdict,
  parseAgeVerdict,
  parseCategoryCostVerdict,
  textOf,
} from '../../lib/llm/prompts';

describe('cacheable system prefix', () => {
  it('marks the LAST system block with a 1-hour cache_control breakpoint (all use cases)', () => {
    for (const system of [buildDedupSystem(), buildAgeSystem(), buildCategoryCostSystem()]) {
      const last = system[system.length - 1];
      expect(last.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    }
  });

  it('is byte-identical across records (a genuine shared prefix), while user content varies', () => {
    // Stable prefix: two independent builds serialize identically.
    expect(JSON.stringify(buildDedupSystem())).toEqual(JSON.stringify(buildDedupSystem()));
    expect(JSON.stringify(buildAgeSystem())).toEqual(JSON.stringify(buildAgeSystem()));
    expect(JSON.stringify(buildCategoryCostSystem())).toEqual(JSON.stringify(buildCategoryCostSystem()));

    // Volatile content: per-record, and NO cache_control on the user blocks.
    const u1 = buildDedupUser({ leftSource: 'A', leftName: 'x', leftDescription: null, rightSource: 'B', rightName: 'y', rightDescription: null, startUtc: null });
    const u2 = buildDedupUser({ leftSource: 'A', leftName: 'z', leftDescription: null, rightSource: 'B', rightName: 'w', rightDescription: null, startUtc: null });
    expect(JSON.stringify(u1)).not.toEqual(JSON.stringify(u2));
    expect((u1[0] as { cache_control?: unknown }).cache_control).toBeUndefined();

    const a1 = buildAgeUser({ activityName: 'Camp', rawAgeText: 'walkers to 3 yrs' });
    const a2 = buildAgeUser({ activityName: 'Camp', rawAgeText: 'see poster' });
    expect(JSON.stringify(a1)).not.toEqual(JSON.stringify(a2));

    const c1 = buildCategoryCostUser({ activityName: 'Swim', description: 'free drop-in', needsCategory: true, needsCost: true });
    const c2 = buildCategoryCostUser({ activityName: 'Swim', description: 'admission $10', needsCategory: true, needsCost: true });
    expect(JSON.stringify(c1)).not.toEqual(JSON.stringify(c2));
    expect((c1[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
  });
});

describe('textOf', () => {
  it('extracts the first text block, else null', () => {
    expect(textOf([{ type: 'text', text: 'hello' }])).toBe('hello');
    expect(textOf([{ type: 'image' }, { type: 'text', text: 'x' }])).toBe('x');
    expect(textOf([{ type: 'image' }])).toBeNull();
  });
});

describe('parseDedupVerdict (fail-closed)', () => {
  it('parses a valid verdict and clamps confidence into [0,1]', () => {
    expect(parseDedupVerdict('{"isDuplicate":true,"confidence":0.9,"reason":"same"}')).toEqual({ isDuplicate: true, confidence: 0.9, reason: 'same' });
    expect(parseDedupVerdict('{"isDuplicate":false,"confidence":1.5,"reason":"x"}')?.confidence).toBe(1);
    expect(parseDedupVerdict('{"isDuplicate":true,"confidence":-3,"reason":"x"}')?.confidence).toBe(0);
  });
  it('returns null for malformed / wrong-typed / non-JSON output', () => {
    for (const bad of ['not json', '', null, '[]', '{"isDuplicate":"yes","confidence":0.9,"reason":"x"}', '{"confidence":0.9,"reason":"x"}', '{"isDuplicate":true,"confidence":"hi","reason":"x"}']) {
      expect(parseDedupVerdict(bad as string | null)).toBeNull();
    }
  });
});

describe('parseAgeVerdict (fail-closed)', () => {
  it('parses a valid resolved verdict', () => {
    expect(parseAgeVerdict('{"resolved":true,"ageMinMonths":12,"ageMaxMonths":48,"confidence":0.8,"reason":"r"}')).toEqual({ resolved: true, ageMinMonths: 12, ageMaxMonths: 48, confidence: 0.8, reason: 'r' });
  });
  it('accepts an open-ended (null max) resolved verdict', () => {
    expect(parseAgeVerdict('{"resolved":true,"ageMinMonths":60,"ageMaxMonths":null,"confidence":0.85,"reason":"5+"}')?.ageMaxMonths).toBeNull();
  });
  it('accepts an unresolved verdict with null bounds', () => {
    expect(parseAgeVerdict('{"resolved":false,"ageMinMonths":null,"ageMaxMonths":null,"confidence":0.9,"reason":"none"}')).toMatchObject({ resolved: false, ageMinMonths: null, ageMaxMonths: null });
  });
  it('rejects an inverted / degenerate / negative / non-integer / both-null-resolved band', () => {
    for (const bad of [
      '{"resolved":true,"ageMinMonths":48,"ageMaxMonths":12,"confidence":0.9,"reason":"x"}', // inverted
      '{"resolved":true,"ageMinMonths":24,"ageMaxMonths":24,"confidence":0.9,"reason":"x"}', // degenerate
      '{"resolved":true,"ageMinMonths":-5,"ageMaxMonths":12,"confidence":0.9,"reason":"x"}', // negative
      '{"resolved":true,"ageMinMonths":1.5,"ageMaxMonths":12,"confidence":0.9,"reason":"x"}', // non-integer
      '{"resolved":true,"ageMinMonths":null,"ageMaxMonths":null,"confidence":0.9,"reason":"x"}', // resolved but no band
      '{"resolved":true,"ageMinMonths":"a","ageMaxMonths":12,"confidence":0.9,"reason":"x"}', // wrong type
    ]) {
      expect(parseAgeVerdict(bad)).toBeNull();
    }
  });
});

describe('parseCategoryCostVerdict (fail-closed)', () => {
  const ok = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      primaryCategory: 'storytime',
      categoryConfidence: 0.9,
      costStatus: 'free',
      costMinCad: 0,
      costMaxCad: 0,
      costConfidence: 0.9,
      reason: 'r',
      ...over,
    });

  it('parses a valid category+cost verdict and clamps both confidences into [0,1]', () => {
    expect(parseCategoryCostVerdict(ok())).toEqual({
      primaryCategory: 'storytime',
      categoryConfidence: 0.9,
      costStatus: 'free',
      costMinCad: 0,
      costMaxCad: 0,
      costConfidence: 0.9,
      reason: 'r',
    });
    expect(parseCategoryCostVerdict(ok({ categoryConfidence: 5, costConfidence: -2 }))).toMatchObject({
      categoryConfidence: 1,
      costConfidence: 0,
    });
  });

  it('parses a known cost with a numeric range', () => {
    expect(parseCategoryCostVerdict(ok({ costStatus: 'known', costMinCad: 8, costMaxCad: 20 }))).toMatchObject({
      costStatus: 'known',
      costMinCad: 8,
      costMaxCad: 20,
    });
  });

  it('degrades individual fields independently: an unknown key / bad status / bad amount collapse to null, siblings survive', () => {
    // Unknown / generic 'class_program' category → null category, but cost survives.
    expect(parseCategoryCostVerdict(ok({ primaryCategory: 'class_program' }))).toMatchObject({ primaryCategory: null, costStatus: 'free' });
    expect(parseCategoryCostVerdict(ok({ primaryCategory: 'not_a_key' }))).toMatchObject({ primaryCategory: null });
    expect(parseCategoryCostVerdict(ok({ primaryCategory: 42 }))).toMatchObject({ primaryCategory: null, categoryConfidence: 0.9 });
    // 'unknown' is an input state, never a valid output status → null.
    expect(parseCategoryCostVerdict(ok({ costStatus: 'unknown' }))).toMatchObject({ costStatus: null });
    expect(parseCategoryCostVerdict(ok({ costStatus: 'known', costMinCad: -3 }))).toMatchObject({ costStatus: 'known', costMinCad: null });
    expect(parseCategoryCostVerdict(ok({ costStatus: 'known', costMinCad: 'ten' }))).toMatchObject({ costMinCad: null });
  });

  it('returns null for a structurally-unusable response (non-JSON / missing/invalid confidence)', () => {
    for (const bad of [
      'not json',
      '',
      null,
      '[]',
      '{"primaryCategory":"storytime","costStatus":"free","costMinCad":0,"costMaxCad":0,"costConfidence":0.9,"reason":"x"}', // missing categoryConfidence
      ok({ categoryConfidence: 'hi' }),
      ok({ costConfidence: null }),
    ]) {
      expect(parseCategoryCostVerdict(bad as string | null)).toBeNull();
    }
  });
});
