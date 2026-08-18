// tests/audit/pipeline.test.ts — prefilter → adjudication → findings → report, end to end,
// with the FakeAnthropicBatchClient. No network, no database, no credential.
//
// The properties pinned here are the ones that decide whether anyone trusts the output:
//   • a dry run makes NO API call at all (that is the default mode, and the Operator's first run);
//   • the model's "no" beats the prefilter's "maybe";
//   • a weak-only candidate is never reported unreviewed;
//   • a strong candidate IS reported even when the model never ran;
//   • the per-run cap spends its budget on strong evidence first, and says what it dropped.
import { describe, expect, it, vi } from 'vitest';
import { FakeAnthropicBatchClient, UnprovisionedAnthropicBatchClient } from '@/lib/llm/anthropic-client';
import { prefilter } from '@/lib/audit/prefilter';
import { adjudicateCandidates, buildSafetyAuditRequest, prioritise, toFindings } from '@/lib/llm/safety-audit';
import { buildDelta, buildReport, renderMarkdown, type RunMeta } from '@/lib/audit/report';
import { suitabilityTagsForMode, tagKeysFrom } from '@/lib/audit/tags';
import type { AuditListing } from '@/lib/audit/types';

function listing(id: string, o: Partial<{ title: string; ageWording: string; tags: string[]; bands: string[] }>): AuditListing {
  return {
    id,
    seriesId: null,
    organisation: 'Org',
    sourceUrl: 'https://source.test/x',
    source: {
      title: o.title ?? '',
      description: '',
      ageWording: o.ageWording ?? '',
      venueName: '',
      openHoursLabel: '',
    },
    derived: {
      suitabilityTags: o.tags ?? [],
      categoryTags: ['class_program'],
      primaryCategoryKey: 'class_program',
      ageBandMatches: o.bands ?? ['5-9'],
      ageMinMonths: null,
      ageMaxMonths: null,
    },
  };
}

const STRONG = listing('00000000-0000-0000-0000-00000000000a', {
  title: 'Sportball Outdoor Soccer (5-7yrs) Rain/Shine',
  tags: ['outdoor', 'indoor'],
});
const WEAK = listing('00000000-0000-0000-0000-00000000000b', {
  title: 'Park Board Youth Program',
  tags: ['indoor'],
});

describe('prefilter', () => {
  it('reports the denominator alongside the candidates', () => {
    const result = prefilter([STRONG, WEAK, listing('00000000-0000-0000-0000-00000000000c', { title: 'Chess Club', tags: ['indoor'] })]);
    expect(result.considered).toBe(3);
    expect(result.candidates).toHaveLength(2);
    expect(result.countsByRule.outdoor_source_indoor_tag).toBe(2);
    expect(result.weakOnlyByRule.outdoor_source_indoor_tag).toBe(1);
  });

  it('mints custom_ids Anthropic will accept', () => {
    for (const c of prefilter([STRONG, WEAK]).candidates) {
      expect(c.customId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });
});

describe('adjudication', () => {
  it('a dry run makes no API call — the unprovisioned client would throw if it did', async () => {
    const candidates = prefilter([STRONG, WEAK]).candidates;
    const client = new UnprovisionedAnthropicBatchClient();
    const spy = vi.spyOn(client.messages.batches, 'create');
    const result = await adjudicateCandidates(candidates, { dryRun: true, client });
    expect(spy).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.submitted).toBe(0);
    expect(result.verdicts.size).toBe(0);
  });

  it('keys verdicts by custom_id, not by position', async () => {
    const candidates = prefilter([STRONG, WEAK]).candidates;
    const client = new FakeAnthropicBatchClient({
      responder: (req) => ({
        contradiction: req.custom_id.includes(STRONG.id),
        confidence: 0.95,
        reason: 'r',
      }),
    });
    const result = await adjudicateCandidates(candidates, { client, pollIntervalMs: 0 });
    const strongCandidate = candidates.find((c) => c.listing.id === STRONG.id)!;
    expect(result.verdicts.get(strongCandidate.customId)!.contradiction).toBe(true);
    expect(result.submitted).toBe(2);
    expect(result.unresolved).toBe(0);
  });

  it('treats an errored or unparseable response as unadjudicated, never as a guess', async () => {
    const candidates = prefilter([STRONG]).candidates;
    const client = new FakeAnthropicBatchClient({ responder: () => null });
    const result = await adjudicateCandidates(candidates, { client, pollIntervalMs: 0 });
    expect(result.verdicts.size).toBe(0);
    expect(result.unresolved).toBe(1);
  });

  it('spends a tight cap on strong evidence first, and reports what it dropped', async () => {
    const candidates = prefilter([WEAK, STRONG]).candidates;
    expect(prioritise(candidates)[0].listing.id).toBe(STRONG.id);
    const client = new FakeAnthropicBatchClient({ responder: () => ({ contradiction: true, confidence: 0.9, reason: 'r' }) });
    const result = await adjudicateCandidates(candidates, { client, pollIntervalMs: 0, maxCandidates: 1 });
    expect(result.submitted).toBe(1);
    expect(result.cappedOut).toBe(1);
    const strongCandidate = candidates.find((c) => c.listing.id === STRONG.id)!;
    expect(result.verdicts.has(strongCandidate.customId)).toBe(true);
  });

  it('sends a cacheable system prefix and the volatile evidence in the user turn', () => {
    const req = buildSafetyAuditRequest(prefilter([STRONG]).candidates[0]);
    expect(req.params.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(req.params.messages[0].content[0].text).toContain('Sportball Outdoor Soccer');
    expect(req.params.output_config).toBeDefined();
    expect(req.params.model.startsWith('claude-haiku')).toBe(true);
  });
});

describe('promotion to findings', () => {
  const candidates = prefilter([STRONG, WEAK]).candidates;
  const strongC = candidates.find((c) => c.listing.id === STRONG.id)!;
  const weakC = candidates.find((c) => c.listing.id === WEAK.id)!;

  it('drops an unreviewed weak candidate but keeps an unreviewed strong one', () => {
    const findings = toFindings(candidates, new Map(), 'https://kf.test');
    expect(findings.map((f) => f.listingId)).toEqual([STRONG.id]);
    expect(findings[0].adjudicatedBy).toBe('prefilter');
    expect(findings[0].previewUrl).toBe(`https://kf.test/activity/${STRONG.id}`);
  });

  it("the model's NO overrides the prefilter's MAYBE, even on strong evidence", () => {
    const verdicts = new Map([[strongC.customId, { contradiction: false, confidence: 0.9, reason: 'venue name' }]]);
    expect(toFindings(candidates, verdicts, 'https://kf.test')).toHaveLength(0);
  });

  it("the model's YES rescues a weak candidate", () => {
    const verdicts = new Map([[weakC.customId, { contradiction: true, confidence: 0.85, reason: 'really outdoors' }]]);
    const findings = toFindings(candidates, verdicts, 'https://kf.test');
    expect(findings.map((f) => f.listingId)).toContain(WEAK.id);
    expect(findings.find((f) => f.listingId === WEAK.id)!.adjudicatedBy).toBe('llm');
  });

  it('a low-confidence YES is not promoted', () => {
    const verdicts = new Map([[weakC.customId, { contradiction: true, confidence: 0.4, reason: 'unsure' }]]);
    expect(toFindings(candidates, verdicts, 'https://kf.test').map((f) => f.listingId)).not.toContain(WEAK.id);
  });
});

describe('post-fix tag derivation', () => {
  it('reconstructs the tag keys the repository started from', () => {
    expect(tagKeysFrom(['class_program', 'free'], 'class_program')).toEqual(['free']);
  });

  it('reproduces the CURRENT rule in as_served mode', () => {
    // The catch-all arm: class_program gains `indoor` today.
    expect(suitabilityTagsForMode(['class_program', 'free'], 'class_program', 'as_served')).toEqual(['free', 'indoor']);
    expect(suitabilityTagsForMode(['storytime'], 'storytime', 'as_served')).toEqual(['indoor']);
  });

  it('drops the catch-all arm in post_fix mode but keeps the genuine ones', () => {
    expect(suitabilityTagsForMode(['class_program', 'free'], 'class_program', 'post_fix')).toEqual(['free']);
    expect(suitabilityTagsForMode(['storytime'], 'storytime', 'post_fix')).toEqual(['indoor']);
    expect(suitabilityTagsForMode(['indoor_play'], 'indoor_play', 'post_fix')).toEqual(['indoor']);
    // A source-supplied `outdoor` tag is never touched by either derivation.
    expect(suitabilityTagsForMode(['class_program', 'outdoor'], 'class_program', 'post_fix')).toEqual(['outdoor']);
  });
});

describe('report', () => {
  const meta: RunMeta = {
    generatedAt: '2026-08-18T00:00:00.000Z',
    baseUrl: 'https://kf.test',
    mode: 'as_served',
    catalogueTotal: 4560,
    swept: 4560,
    coverage: 1,
    requests: 190,
    truncatedCells: 0,
    considered: 4560,
    candidates: 2,
    countsByRule: { outdoor_source_indoor_tag: 2, adult_source_child_bands: 0 },
    weakOnlyByRule: { outdoor_source_indoor_tag: 1, adult_source_child_bands: 0 },
    adjudication: { dryRun: true, submitted: 0, cappedOut: 0, unresolved: 0, timedOut: false },
  };

  it('puts coverage above the findings and never prints a numerator alone', () => {
    const findings = toFindings(prefilter([STRONG, WEAK]).candidates, new Map(), 'https://kf.test');
    const md = renderMarkdown(buildReport(meta, findings));
    expect(md.indexOf('## Coverage')).toBeLessThan(md.indexOf('## Reported findings'));
    expect(md).toContain('Listings swept | 4560 (100.0%)');
    expect(md).toContain('DRY RUN');
    expect(md).toContain('Sportball Outdoor Soccer');
  });

  it('computes the delta as resolved / introduced sets, not just counts', () => {
    const delta = buildDelta(
      {
        candidates: [
          { ruleId: 'outdoor_source_indoor_tag', listingId: 'a' },
          { ruleId: 'outdoor_source_indoor_tag', listingId: 'b' },
        ],
        findings: 2,
        countsByRule: { outdoor_source_indoor_tag: 2 },
      },
      {
        candidates: [{ ruleId: 'outdoor_source_indoor_tag', listingId: 'a' }],
        findings: 1,
        countsByRule: { outdoor_source_indoor_tag: 1 },
      }
    );
    expect(delta.candidateDeltaByRule.outdoor_source_indoor_tag).toBe(-1);
    expect(delta.resolvedByFix).toEqual(['outdoor_source_indoor_tag::b']);
    // A non-empty `introducedByFix` is how the auditor would catch the fix regressing rows that
    // were previously fine — it must be empty for a clean fix.
    expect(delta.introducedByFix).toEqual([]);
  });
});
