// tests/llm/dedup-deterministic.test.ts — Option D's decider, as pure logic. No DB, no model.
//
// C4 IS THE POINT OF THIS FILE: "no reachable configuration yields auto_merge" has to be a
// proof, not a policy. Production makes that urgent rather than theoretical — a read-only
// estimate found exactly 40 candidate pairs in the live catalogue and ALL 40 clear the 0.55
// auto-merge similarity bar, so if an auto-merge were reachable today it would fire on every
// one of them and irreversibly archive 40 real, distinct library-branch events.
//
// The guard is enforced in three independent registers, because a runtime test alone would
// only prove that today's code happens not to merge:
//   1. TYPE — DeterministicDedupAction = Exclude<DedupAction,'auto_merge'>, pinned below by an
//      expect-error directive that FAILS THE BUILD if 'auto_merge' becomes assignable again.
//      (That directive is spelled out only at its use site: tsc honours the token inside ANY
//      comment, so writing it in prose here would create a second, dangling one — which it
//      did, and which tsc caught.)
//   2. BEHAVIOUR — a sweep over the decision space (every score incl. degenerate ones, both
//      canonical orderings, every authority/confidence rank) asserting the set of reachable
//      actions is exactly {route_to_review, skip}.
//   3. CONFIGURATION — the same sweep with every LLM env var set to its most permissive
//      value, so "we simply never turned it on" is not what is doing the work.
import { afterEach, describe, expect, it } from 'vitest';
import {
  chooseCanonical,
  decideDedupDeterministic,
  type DedupCandidate,
  type DeterministicDedupAction,
  type OccurrenceSide,
  type VenueLookup,
} from '@/lib/llm/dedup';
import {
  DEDUP_AUTO_MERGE_MIN_SIMILARITY,
  DEDUP_BLOCKING_MIN_SIMILARITY,
  DEDUP_REVIEW_MIN_SIMILARITY,
} from '@/lib/llm/config';

const AUTHORITIES = ['official', 'editorial', 'partner', 'manual', 'nonsense'];
const CONFIDENCES = ['high', 'medium', 'low', 'unscored', 'nonsense'];

function side(id: string, over: Partial<OccurrenceSide> = {}): OccurrenceSide {
  return {
    id,
    name: 'Preschool Storytime',
    description: null,
    sourceName: 'Richmond Public Library',
    authorityTier: 'official',
    confidenceLabel: 'unscored',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function candidate(score: number, left = side('a'), right = side('b', { sourceName: 'Vancouver Public Library' })): DedupCandidate {
  return { left, right, startUtc: '2026-09-01T18:00:00.000Z', deterministicScore: score, customId: `dedup-${left.id}` };
}

/** Every score worth trying: a fine sweep plus the values that break naive comparisons. */
function scoreSpace(): number[] {
  const scores: number[] = [];
  for (let i = 0; i <= 1000; i++) scores.push(i / 1000);
  return scores.concat([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    2,
    1e308,
    Number.EPSILON,
    DEDUP_REVIEW_MIN_SIMILARITY,
    DEDUP_BLOCKING_MIN_SIMILARITY,
    DEDUP_AUTO_MERGE_MIN_SIMILARITY,
    0.9999999999,
  ]);
}

const VENUE_CASES: Array<{ label: string; venues: VenueLookup }> = [
  { label: 'no venue data', venues: new Map() },
  {
    label: 'same venue',
    venues: new Map([
      ['a', { venueId: 'v1', venueName: 'Brighouse Branch' }],
      ['b', { venueId: 'v1', venueName: 'Brighouse Branch' }],
    ]),
  },
  {
    label: 'different venues',
    venues: new Map([
      ['a', { venueId: 'v1', venueName: 'Brighouse Branch' }],
      ['b', { venueId: 'v2', venueName: 'Kitsilano Branch' }],
    ]),
  },
  { label: 'one side unknown', venues: new Map([['a', { venueId: 'v1', venueName: 'Brighouse Branch' }]]) },
];

describe('Option D — deterministic dedup decider', () => {
  describe('C4: auto_merge is unreachable', () => {
    it('TYPE: the action type cannot express auto_merge (build fails if this stops erroring)', () => {
      // @ts-expect-error — 'auto_merge' must NOT be assignable to DeterministicDedupAction.
      const forbidden: DeterministicDedupAction = 'auto_merge';
      // Both legal members must still be assignable, so the pin above is not vacuously
      // satisfied by the type having collapsed to `never`.
      const review: DeterministicDedupAction = 'route_to_review';
      const skip: DeterministicDedupAction = 'skip';
      expect([forbidden, review, skip]).toHaveLength(3);
    });

    it('BEHAVIOUR: the reachable action set over the whole decision space is exactly {route_to_review, skip}', () => {
      const seen = new Set<string>();
      let evaluated = 0;
      for (const score of scoreSpace()) {
        for (const authority of AUTHORITIES) {
          for (const confidence of CONFIDENCES) {
            for (const { venues } of VENUE_CASES) {
              const l = side('a', { authorityTier: authority, confidenceLabel: confidence });
              const r = side('b', { authorityTier: 'official', confidenceLabel: 'high' });
              // Both orderings, though chooseCanonical is in fact order-INSENSITIVE for any
              // input the detector can produce: rank() (dedup.ts) ends in side.id and the
              // comparison is element-wise, so with distinct ids the tie always resolves
              // before the argument-order fallback — and detectDedupCandidates guarantees
              // distinctness via `r.id <> f.id`. Swept forward and reversed over the rank
              // space at 8fe6268: 0 asymmetric results. (This comment previously claimed the
              // opposite, "order-sensitive by construction"; migration 0030's key design
              // depends on which is true, so the account is corrected rather than left to
              // contradict it. Sweeping both orders here is still worth the cost — it is what
              // would CATCH a future edit that made the function order-sensitive.)
              seen.add(decideDedupDeterministic(candidate(score, l, r), venues).action);
              seen.add(decideDedupDeterministic(candidate(score, r, l), venues).action);
              evaluated += 2;
            }
          }
        }
      }
      // Guard against a vacuous pass: assert the sweep actually ran at scale.
      expect(evaluated).toBeGreaterThan(100_000);
      expect(seen.has('auto_merge')).toBe(false);
      expect([...seen].sort()).toEqual(['route_to_review', 'skip']);
    });

    it('CONFIGURATION: the most permissive LLM env still yields no auto_merge', () => {
      // Everything an operator could flip, flipped the wrong way at once. The decider reads
      // none of it — which is exactly the claim being pinned. The key is a literal dummy;
      // no request is constructed on this path, so nothing can be sent anywhere.
      process.env.LLM_BATCH_ENABLED = 'true';
      process.env.LLM_BATCH_DRY_RUN = 'false';
      process.env.ANTHROPIC_API_KEY = 'not-a-real-key-never-used-on-this-path';
      process.env.LLM_BATCH_MODEL = 'claude-haiku-4-5';
      process.env.LLM_BATCH_MAX_CANDIDATES = '100000';

      for (const score of [0, 0.4, 0.55, 0.9, 0.99, 1]) {
        for (const { venues } of VENUE_CASES) {
          const d = decideDedupDeterministic(candidate(score), venues);
          expect(d.action).not.toBe('auto_merge');
        }
      }
    });

    it('scores far above the auto-merge bar route to review rather than merging', () => {
      // The exact shape of the 40 real production pairs: well clear of 0.55, still a human's call.
      for (const score of [0.56, 0.7, 0.85, 0.95, 1]) {
        expect(score).toBeGreaterThan(DEDUP_AUTO_MERGE_MIN_SIMILARITY);
        expect(decideDedupDeterministic(candidate(score)).action).toBe('route_to_review');
      }
    });

    afterEach(() => {
      delete process.env.LLM_BATCH_ENABLED;
      delete process.env.LLM_BATCH_DRY_RUN;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.LLM_BATCH_MODEL;
      delete process.env.LLM_BATCH_MAX_CANDIDATES;
    });
  });

  describe('no model is consulted', () => {
    it('always records a NULL confidence — never a fabricated number', () => {
      for (const score of [0, 0.39, 0.4, 0.75, 1]) {
        expect(decideDedupDeterministic(candidate(score)).llmConfidence).toBeNull();
      }
    });

    it('names the absence of a model in the reason the reviewer reads', () => {
      expect(decideDedupDeterministic(candidate(0.8)).reason).toMatch(/no model was consulted/i);
    });
  });

  describe('the review floor', () => {
    it('routes exactly at the floor and skips just below it (inclusive boundary)', () => {
      expect(decideDedupDeterministic(candidate(DEDUP_REVIEW_MIN_SIMILARITY)).action).toBe('route_to_review');
      const justBelow = DEDUP_REVIEW_MIN_SIMILARITY - 1e-9;
      expect(decideDedupDeterministic(candidate(justBelow)).action).toBe('skip');
    });

    it('is the blocking floor — the deterministic pass routes everything the blocker detected', () => {
      expect(DEDUP_REVIEW_MIN_SIMILARITY).toBe(DEDUP_BLOCKING_MIN_SIMILARITY);
    });

    it('sends a NaN score to the non-mutating branch', () => {
      expect(decideDedupDeterministic(candidate(Number.NaN)).action).toBe('skip');
    });
  });

  describe('venue is a review SIGNAL, never a filter', () => {
    it('does not change the decision — only the text a human reads', () => {
      const actions = VENUE_CASES.map((c) => decideDedupDeterministic(candidate(0.8), c.venues).action);
      expect(new Set(actions).size).toBe(1);
      expect(actions[0]).toBe('route_to_review');

      // …and it is genuinely surfaced, differently, per case.
      const reasons = VENUE_CASES.map((c) => decideDedupDeterministic(candidate(0.8), c.venues).reason);
      expect(reasons[1]).toContain('same venue (Brighouse Branch)');
      expect(reasons[2]).toContain('DIFFERENT venue rows');
      expect(reasons[2]).toContain('Kitsilano Branch');
      expect(reasons[3]).toContain('venue unknown');
      expect(reasons[0]).toContain('venue unknown');
    });

    it('records the signal structurally, so the adjudicated pairs are analysable later', () => {
      const signals = VENUE_CASES.map((c) => decideDedupDeterministic(candidate(0.8), c.venues).venueSignal);
      expect(signals).toEqual(['venue_unknown', 'same_venue', 'different_venue', 'venue_unknown']);
    });

    it('does NOT exclude the different-venue case, which is every real production pair', () => {
      // All 40 live candidate pairs have populated, DIFFERING venue_ids. Filtering on that
      // would silently resolve them — but `venue` has no unique constraint on any column, so
      // two rows may be one place. The pair must still reach a human.
      const differentVenues = VENUE_CASES[2].venues;
      expect(decideDedupDeterministic(candidate(0.92), differentVenues).action).toBe('route_to_review');
    });
  });

  describe('survivor selection', () => {
    it('delegates to chooseCanonical rather than re-deciding it', () => {
      const l = side('a', { authorityTier: 'partner' });
      const r = side('b', { authorityTier: 'official' });
      const { canonical, duplicate } = chooseCanonical(l, r);
      const d = decideDedupDeterministic(candidate(0.8, l, r));
      expect(d.canonicalId).toBe(canonical.id);
      expect(d.duplicateId).toBe(duplicate.id);
    });

    it('flags the DUPLICATE (never the canonical) as the record routed to review', () => {
      const l = side('a', { authorityTier: 'official' });
      const r = side('b', { authorityTier: 'partner' });
      const d = decideDedupDeterministic(candidate(0.8, l, r));
      expect(d.duplicateId).toBe('b');
      expect(d.canonicalId).toBe('a');
    });
  });
});
