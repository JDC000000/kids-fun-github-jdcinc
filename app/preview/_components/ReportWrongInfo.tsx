'use client';

// Consistent-help affordance (WCAG 3.2.6) — present in the same place on every detail.
// Posts a correction to /api/corrections, which persists it into `correction_report`
// keyed to the occurrence + the anon session, then optimistically acknowledges. The
// report is fire-and-safe: a backend failure never blocks the "thanks" the parent sees
// (matching the never-load-bearing posture of the analytics helpers). Real corrections
// now land in the DB for triage; the fixture stub is retired.
//
// BUG-009: the report used to fire on a single click, so an accidental tap (easy on
// mobile, where the button sits just above the sticky Registration/Maps bar) silently
// filed a contentless correction with no undo. A lightweight confirm step now gates the
// write — the first click only asks "report this?"; the POST fires ONLY after an explicit
// "Yes, report it". Cancel returns to the idle button with nothing sent. The transition
// rule lives in the exported pure `nextReportStage` so the "one click never submits"
// guarantee is unit-testable without a DOM.

import { useState } from 'react';
import { reportCorrection } from '@/lib/corrections/client';

export type ReportStage = 'idle' | 'confirming' | 'sent';
export type ReportEvent = 'request' | 'confirm' | 'cancel';

/**
 * Pure state machine for the report affordance. `submit` is true ONLY on the
 * idle → confirming → confirm path, so a single 'request' (the first click) can
 * never trigger the correction write — that is the BUG-009 gate.
 */
export function nextReportStage(
  stage: ReportStage,
  event: ReportEvent,
): { stage: ReportStage; submit: boolean } {
  if (stage === 'idle' && event === 'request') return { stage: 'confirming', submit: false };
  if (stage === 'confirming' && event === 'confirm') return { stage: 'sent', submit: true };
  if (stage === 'confirming' && event === 'cancel') return { stage: 'idle', submit: false };
  return { stage, submit: false };
}

export function ReportWrongInfo({ occurrenceId }: { occurrenceId: string }) {
  const [stage, setStage] = useState<ReportStage>('idle');

  function dispatch(event: ReportEvent) {
    const next = nextReportStage(stage, event);
    if (next.submit) {
      // persisted best-effort; failures are swallowed by reportCorrection
      void reportCorrection(occurrenceId);
    }
    setStage(next.stage);
  }

  if (stage === 'sent') {
    return (
      <p
        className="kf-panel"
        style={{ margin: '10px 0 0', color: 'var(--confirmed-text)', background: 'var(--confirmed-bg)' }}
      >
        Thanks — we&apos;ll recheck this listing against the source.
      </p>
    );
  }

  if (stage === 'confirming') {
    return (
      <div
        role="group"
        aria-label="Confirm reporting this listing"
        style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
      >
        <p style={{ margin: 0, fontWeight: 600 }}>Report this listing as having wrong info?</p>
        <button
          type="button"
          className="kf-link"
          onClick={() => dispatch('confirm')}
          style={{ width: '100%' }}
        >
          ⚑ Yes, report it
        </button>
        <button
          type="button"
          className="kf-link"
          onClick={() => dispatch('cancel')}
          style={{ width: '100%' }}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="kf-link"
      onClick={() => dispatch('request')} // BUG-009: first click only asks — it never submits
      style={{ width: '100%' }}
    >
      ⚑ Report wrong info
    </button>
  );
}
