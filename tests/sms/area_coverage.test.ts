// tests/sms/area_coverage.test.ts — the three-way classification behind the area waitlist.
import { describe, expect, it } from 'vitest';
import { classifyPostalCoverage, offersWaitlist } from '@/lib/sms/area-coverage';
import {
  WAITLIST_CONSENT_TEXT,
  WAITLIST_CONSENT_VERSION,
  renderWaitlistNotification,
} from '@/lib/sms/waitlist-copy';
import { CONSENT_TEXT_VERSION } from '@/lib/sms/consent-copy';
import { isGsm7, estimateSegments } from '@/lib/sms/message';

const SPARSE = ['wvan', 'bby'];

describe('classifyPostalCoverage', () => {
  it('calls a well-covered municipality covered', () => {
    expect(classifyPostalCoverage('V5L 1A1', SPARSE)).toEqual({ kind: 'covered', regionId: 'van' });
  });

  it('calls a measured-sparse municipality sparse, not covered', () => {
    expect(classifyPostalCoverage('V7V 1A1', SPARSE)).toEqual({ kind: 'sparse', regionId: 'wvan' });
  });

  it('🔴 reads sparseness from the ARGUMENT, never a hardcoded pair', () => {
    // The measurement is live (lib/sms/sparse-measure.ts). If this function ever decided sparseness
    // itself, the notice and the waitlist would drift apart from /search's own coverage answer the
    // first time a municipality filled out.
    expect(classifyPostalCoverage('V7V 1A1', []).kind).toBe('covered');
    expect(classifyPostalCoverage('V5L 1A1', ['van']).kind).toBe('sparse');
  });

  it('calls an uncovered postal code out of area, and returns only its FSA', () => {
    // V3S is Surrey — a real postal code we do not serve.
    expect(classifyPostalCoverage('V3S 1A1', SPARSE)).toEqual({ kind: 'out_of_area', fsa: 'V3S' });
  });

  it('🔴 stores the FSA ONLY — never the full postal code', () => {
    // Migration 0038's data-minimisation choice, asserted where it would actually be violated.
    const result = classifyPostalCoverage('V3S 9Z9', SPARSE);
    expect(result.kind).toBe('out_of_area');
    if (result.kind !== 'out_of_area') return;
    expect(result.fsa).toBe('V3S');
    expect(result.fsa).toHaveLength(3);
    expect('V3S 9Z9').toContain(result.fsa); // and it is genuinely a prefix, not a re-derivation
  });

  it('🔴 says UNKNOWN while somebody is still typing — not out of area', () => {
    // The distinction that stops the page accusing a parent of living outside our coverage on the
    // second keystroke. Only a postal code that resolves to nothing is out of area.
    for (const partial of ['', 'V', 'V3', '   ', 'nonsense']) {
      expect(classifyPostalCoverage(partial, SPARSE).kind, JSON.stringify(partial)).toBe('unknown');
    }
  });

  it('classifies from three characters, which is what makes the warning early', () => {
    // The FSA alone decides coverage, so the last three characters cannot change the answer. Jon's
    // requirement was to tell somebody ASAP rather than after a submit-and-reject round trip.
    expect(classifyPostalCoverage('V3S', SPARSE)).toEqual({ kind: 'out_of_area', fsa: 'V3S' });
    expect(classifyPostalCoverage('V5L', SPARSE).kind).toBe('covered');
  });

  it('offers the waitlist for exactly the two scenarios that have one', () => {
    expect(offersWaitlist(classifyPostalCoverage('V7V 1A1', SPARSE))).toBe(true); // sparse
    expect(offersWaitlist(classifyPostalCoverage('V3S 1A1', SPARSE))).toBe(true); // out of area
    expect(offersWaitlist(classifyPostalCoverage('V5L 1A1', SPARSE))).toBe(false); // covered
    expect(offersWaitlist(classifyPostalCoverage('V3', SPARSE))).toBe(false); // still typing
  });
});

describe('waitlist consent is a separate promise from the weekly picks', () => {
  it('🔴 has its own version constant, independent of CONSENT_TEXT_VERSION', () => {
    // Two purposes, two versions. If these were ever the same string, no audit could say which
    // promise a stamped row referred to.
    expect(WAITLIST_CONSENT_VERSION).not.toBe(CONSENT_TEXT_VERSION);
    expect(WAITLIST_CONSENT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.v\d+$/);
  });

  it('says what is stored, what is sent, and that nothing else follows', () => {
    // Jon ruled out a confirmation SMS, so this sentence IS the entire consent record — there is no
    // second act to lean on.
    expect(WAITLIST_CONSENT_TEXT).toMatch(/phone number/i);
    // "ONE MESSAGE", however it is phrased. This matched the literal word "once" until the
    // 2026-09-03 rewording made the opener "Send me one SMS…", at which point the promise still
    // said exactly the same thing and the assertion no longer did. The property is singularity,
    // not the adverb — so it now accepts either phrasing rather than pinning one of them.
    expect(WAITLIST_CONSENT_TEXT).toMatch(/\bonce\b|\bone (SMS|message)\b/i);
    expect(WAITLIST_CONSENT_TEXT).toMatch(/not a signup for the weekly/i);
  });
});

describe('🔴 the notification is intelligible in isolation — Jon\'s condition for skipping confirmation', () => {
  const url = 'https://kidsfunapp.ca/sms/start';
  const areas = ['your area', 'Burnaby', 'Richmond', 'Vancouver', 'West Vancouver', 'North Vancouver'];

  it('identifies the sender, states WHY they are getting it, and how to stop', () => {
    // The three questions somebody who has forgotten opting in actually has. This message carries
    // the whole burden that a confirmation SMS would otherwise have shared.
    for (const area of areas) {
      const m = renderWaitlistNotification(area, url);
      expect(m.startsWith('KIDS FUN:'), area).toBe(true); // who
      expect(m, area).toContain('You asked to hear when we reached'); // why — the CAUSE, not just the offer
      expect(m, area).toContain(area);
      expect(m, area).toMatch(/reply stop/i); // how to stop
    }
  });

  it('points at signup rather than assuming consent they never gave', () => {
    // A waitlist row is NOT a subscriber. Replying JOIN would also do nothing for them — they have
    // no sms_consent row for the inbound handler to confirm — so the copy must not suggest it.
    const m = renderWaitlistNotification('Burnaby', url);
    expect(m).toContain(url);
    expect(m).not.toMatch(/reply join/i);
  });

  it('fits ONE GSM-7 segment for every municipality label', () => {
    // Measured, not assumed: the first draft was 166-174 septets and would have sent as two
    // segments for everyone. Trimmed until the longest label fits.
    for (const area of areas) {
      const m = renderWaitlistNotification(area, url);
      expect(isGsm7(m), area).toBe(true);
      expect(estimateSegments(m).segments, `${area} (${m.length} chars)`).toBe(1);
    }
  });
});
