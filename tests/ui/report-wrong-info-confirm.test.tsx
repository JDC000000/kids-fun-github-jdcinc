import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Spy on the correction write so we can assert that merely rendering the affordance
// (or reaching the idle state) never triggers a POST. vi.hoisted keeps the spy available
// to the hoisted vi.mock factory.
const { reportCorrection } = vi.hoisted(() => ({ reportCorrection: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/corrections/client', () => ({ reportCorrection }));

// BUG-009 (bug bash G-T39-3, Round 27): "Report wrong info" fired the POST on a single
// click with no confirmation, so an accidental tap filed a contentless correction with no
// undo. The fix adds a confirm step; the write is gated behind an explicit "Yes, report it".
//
// This project runs vitest in the `node` environment (no jsdom), so real click simulation
// is not available. The gate is therefore proven two ways: (1) the pure `nextReportStage`
// state machine that the component uses — a single 'request' (first click) yields
// submit=false, and submit is true ONLY after an explicit 'confirm'; and (2) an SSR markup
// check that the default (idle) render shows the trigger, not the acknowledgement.

import { ReportWrongInfo, nextReportStage } from '../../app/preview/_components/ReportWrongInfo';

describe('BUG-009: report confirm step gates submission (pure state machine)', () => {
  it('a single click (request) moves to confirming and NEVER submits', () => {
    const r = nextReportStage('idle', 'request');
    expect(r.stage).toBe('confirming');
    expect(r.submit).toBe(false);
  });

  it('submission fires ONLY after an explicit confirm', () => {
    const r = nextReportStage('confirming', 'confirm');
    expect(r.stage).toBe('sent');
    expect(r.submit).toBe(true);
  });

  it('cancel returns to idle with nothing submitted', () => {
    const r = nextReportStage('confirming', 'cancel');
    expect(r.stage).toBe('idle');
    expect(r.submit).toBe(false);
  });

  it('no other transition ever submits (idle can never submit directly)', () => {
    for (const event of ['confirm', 'cancel'] as const) {
      expect(nextReportStage('idle', event).submit).toBe(false);
    }
    // Once sent, further events are inert (no double-submit).
    for (const event of ['request', 'confirm', 'cancel'] as const) {
      expect(nextReportStage('sent', event).submit).toBe(false);
    }
  });
});

describe('BUG-009: default render is the trigger, not an auto-acknowledgement', () => {
  it('idle render shows "Report wrong info" and does NOT show the sent acknowledgement', () => {
    reportCorrection.mockClear();
    const html = renderToStaticMarkup(<ReportWrongInfo occurrenceId="occ-1" />);
    expect(html).toContain('Report wrong info');
    expect(html).not.toContain("Thanks — we'll recheck");
    expect(html).not.toContain('Yes, report it'); // the confirm affordance is not shown until asked
    // Nothing is submitted merely by rendering the affordance.
    expect(reportCorrection).not.toHaveBeenCalled();
  });
});
