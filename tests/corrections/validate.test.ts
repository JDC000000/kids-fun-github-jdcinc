// tests/corrections/validate.test.ts — parseCorrectionReportBody contract.
import { describe, it, expect } from 'vitest';
import { parseCorrectionReportBody } from '../../lib/corrections/validate';
import { DEFAULT_ISSUE_TYPE, MAX_NOTE_LENGTH } from '../../lib/corrections/types';

const OCC = '11111111-1111-1111-1111-111111111111';

describe('parseCorrectionReportBody', () => {
  it('accepts a minimal report (occurrenceId only) and defaults the issue type', () => {
    const r = parseCorrectionReportBody({ occurrenceId: OCC });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.occurrenceId).toBe(OCC);
      expect(r.value.issueType).toBe(DEFAULT_ISSUE_TYPE);
      expect(r.value.note).toBeNull();
    }
  });

  it('accepts snake_case keys and a `reason` alias for note', () => {
    const r = parseCorrectionReportBody({ occurrence_id: OCC, issue_type: 'wrong_time', reason: '  starts at 10 not 9  ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.issueType).toBe('wrong_time');
      expect(r.value.note).toBe('starts at 10 not 9'); // trimmed
    }
  });

  it('rejects a missing occurrenceId', () => {
    expect(parseCorrectionReportBody({ note: 'hi' }).ok).toBe(false);
  });

  it('rejects a non-UUID occurrenceId', () => {
    expect(parseCorrectionReportBody({ occurrenceId: 'not-a-uuid' }).ok).toBe(false);
  });

  it('rejects an unknown issueType', () => {
    expect(parseCorrectionReportBody({ occurrenceId: OCC, issueType: 'nope' }).ok).toBe(false);
  });

  it('rejects a non-object body', () => {
    expect(parseCorrectionReportBody(null).ok).toBe(false);
    expect(parseCorrectionReportBody([]).ok).toBe(false);
    expect(parseCorrectionReportBody('x').ok).toBe(false);
  });

  it('rejects an over-long note', () => {
    const r = parseCorrectionReportBody({ occurrenceId: OCC, note: 'x'.repeat(MAX_NOTE_LENGTH + 1) });
    expect(r.ok).toBe(false);
  });

  it('normalises a whitespace-only note to null', () => {
    const r = parseCorrectionReportBody({ occurrenceId: OCC, note: '   ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.note).toBeNull();
  });
});
