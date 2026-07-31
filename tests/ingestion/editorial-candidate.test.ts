// tests/ingestion/editorial-candidate.test.ts — G-T10-3 (IR-08, TSD §5 row 11).
//
// AC: "editorial/aggregator items enter as `manual_candidate`; never rendered confirmed
//      until official-source verification."
// Verify: "an editorial item lands as `manual_candidate`, absent from confirmed results."
//
// This file proves BOTH halves without a database:
//   • the WRITE decision — statusForIngestedRecord()'s full three-gate matrix;
//   • the READ consequence — the SAME status, driven through the real search-side
//     classifier and ranker, is absent from the confirmed/primary result list.
// The DB-backed end-to-end (a real editorial source through ingestSource() landing a real
// row) lives in tests/ingestion/ingest-runner.test.ts, which already owns that harness.
//
// WHAT THIS DELIBERATELY DOES NOT DO: build anything new. `manual_candidate` was already
// wired through dedup (lib/llm/dedup.ts), search classification (lib/search/filters/
// status.ts), ranking (lib/search/rank.ts), the admin QA queue and the health sweeps
// (worker/health/{stale,season}.ts). G-T10-3 routes editorial ingestion INTO that existing
// mechanism; these assertions read the real modules rather than restating their values, so
// a future change to any of them fails here instead of drifting apart silently.
import { describe, it, expect } from 'vitest';
import {
  statusForIngestedRecord,
  statusForConfidence,
  isCandidateAuthorityTier,
  CANDIDATE_AUTHORITY_TIER,
  type ConfidenceLabel,
  type IngestStatusState,
} from '../../worker/core/confidence';
import { STATUS_CLASS, isPrimaryResult, isHidden, isExpectedSection } from '../../lib/search/filters/status';
import { STALE_DEMOTE_FROM } from '../../worker/health/stale';
import { SEASON_INHERITABLE_FROM } from '../../worker/health/season';
import type { ListingRecord } from '../../lib/search/types';

const ALL_LABELS: ConfidenceLabel[] = ['high', 'medium', 'low', 'unscored'];
const ALL_TIERS = ['official', 'editorial', 'partner', 'manual', null, 'nonsense'] as const;

function status(
  confidenceLabel: ConfidenceLabel,
  authorityTier: string | null,
  sourceTermsApproved = true
): IngestStatusState {
  return statusForIngestedRecord({ confidenceLabel, authorityTier, sourceTermsApproved });
}

describe('G-T10-3 — an EDITORIAL source ingests as manual_candidate, never confirmed', () => {
  it('the tier that means "this is a lead, not a fact" is `editorial`', () => {
    expect(CANDIDATE_AUTHORITY_TIER).toBe('editorial');
    expect(isCandidateAuthorityTier('editorial')).toBe(true);
    for (const tier of ['official', 'partner', 'manual', null, undefined, 'Editorial']) {
      expect(isCandidateAuthorityTier(tier), `${tier} is not the candidate tier`).toBe(false);
    }
  });

  it('THE ACCEPTANCE CRITERION: a well-parsed editorial item lands as manual_candidate', () => {
    expect(status('high', 'editorial')).toBe('manual_candidate');
    expect(status('medium', 'editorial')).toBe('manual_candidate');
  });

  it('an editorial item can NEVER be written as confirmed, at any confidence', () => {
    // The absolute half of the AC, asserted exhaustively rather than by example.
    for (const label of ALL_LABELS) {
      for (const approved of [true, false]) {
        expect(
          status(label, 'editorial', approved),
          `editorial/${label}/terms=${approved} must not be confirmed`
        ).not.toBe('confirmed');
      }
    }
  });

  it('a LOW-confidence editorial item stays needs_review (hidden) — the safer of the two', () => {
    // Not an oversight: 'needs_review' is HIDDEN and 'manual_candidate' is VISIBLE-but-
    // unverified. Promoting a record the BR-13 gate just rejected into visibility would
    // invert BR-05, so the editorial gate only ever REPLACES a 'confirmed' verdict.
    expect(status('low', 'editorial')).toBe('needs_review');
    expect(status('unscored', 'editorial')).toBe('needs_review');
    expect(STATUS_CLASS.needs_review, 'needs_review really is the stricter class').toBe('hidden');
    expect(STATUS_CLASS.manual_candidate).toBe('expected');
  });

  it('leaves every OTHER authority tier exactly as it was (no collateral change)', () => {
    // The regression guard on the rest of the pipeline: only 'editorial' moved.
    for (const tier of ALL_TIERS) {
      if (tier === 'editorial') continue;
      for (const label of ALL_LABELS) {
        expect(
          status(label, tier),
          `${tier}/${label} must match the pre-existing BR-13 gate`
        ).toBe(statusForConfidence(label));
      }
    }
  });

  it('a PARTNER (organizer-authorised) feed is NOT a candidate — it is first-party', () => {
    // G-T10-2's Eventbrite family is authority_tier 'partner': the organizer describing
    // their OWN event. An editorial round-up is a third party summarising someone else's.
    // Only the latter is a lead awaiting verification.
    expect(status('high', 'partner')).toBe('confirmed');
    expect(status('medium', 'partner')).toBe('confirmed');
  });
});

describe('G-T10-3 — gate precedence: each gate can only make the outcome more conservative', () => {
  it('the Round 27 terms cap still wins over the editorial gate', () => {
    // A non-terms-approved source may not surface AT ALL, and manual_candidate IS a
    // visible class — so the cap covers it too, not just 'confirmed'.
    expect(status('high', 'editorial', false)).toBe('needs_review');
    expect(status('high', 'official', false)).toBe('needs_review');
    expect(status('high', 'partner', false)).toBe('needs_review');
  });

  it('the terms cap never PROMOTES anything (needs_review stays needs_review)', () => {
    for (const tier of ALL_TIERS) {
      expect(status('low', tier, false)).toBe('needs_review');
      expect(status('unscored', tier, false)).toBe('needs_review');
    }
  });

  it('is total and pure — every (label × tier × terms) combination is defined', () => {
    const seen = new Set<IngestStatusState>();
    for (const label of ALL_LABELS) {
      for (const tier of ALL_TIERS) {
        for (const approved of [true, false]) {
          const a = status(label, tier, approved);
          const b = status(label, tier, approved);
          expect(a, 'same inputs → same output').toBe(b);
          expect(['confirmed', 'needs_review', 'manual_candidate']).toContain(a);
          seen.add(a);
        }
      }
    }
    // All three reachable outcomes are actually exercised by the matrix above.
    expect([...seen].sort()).toEqual(['confirmed', 'manual_candidate', 'needs_review']);
  });
});

// ── the READ half: "absent from confirmed results" ────────────────────────────

function listing(statusState: ListingRecord['statusState']): ListingRecord {
  return {
    id: `occ-${statusState}`,
    seriesId: 'series-1',
    activityName: 'Editorial Round-up Listing',
    statusState,
    confidenceLabel: 'editorial',
    categoryTags: [],
    suitabilityTags: [],
  } as unknown as ListingRecord;
}

describe('G-T10-3 — an editorial candidate is absent from confirmed results', () => {
  it('is NOT in the primary/confirmed result list', () => {
    const candidate = listing('manual_candidate');
    expect(isPrimaryResult(candidate), 'never in the primary (confirmed) list').toBe(false);
    // It is not hidden either — it is an explicitly UNVERIFIED lead in the separate
    // "expected" broadening section (§5A.5). That distinction is the whole point of
    // choosing manual_candidate over needs_review for a well-parsed editorial item.
    expect(isExpectedSection(candidate)).toBe(true);
    expect(isHidden(candidate)).toBe(false);

    // …and a genuinely confirmed listing still is.
    expect(isPrimaryResult(listing('confirmed'))).toBe(true);
  });

  it('the auto health sweeps never relabel it — only a human can promote it', () => {
    // "Never rendered confirmed until official-source verification" has to survive the
    // background jobs too. Both sweeps already exclude it; asserted against the REAL
    // lists so a future edit to either one fails here.
    expect(STALE_DEMOTE_FROM).not.toContain('manual_candidate');
    expect(SEASON_INHERITABLE_FROM).not.toContain('manual_candidate');
    // The only path to 'confirmed' is the admin QA queue's explicit human action —
    // app/admin/qa-queue/_lib/data.ts, which requires the row to still BE a live
    // manual_candidate before it will promote it.
  });
});
