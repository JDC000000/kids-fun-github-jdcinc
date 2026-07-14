'use client';

// Consistent-help affordance (WCAG 3.2.6) — present in the same place on every detail.
// Posts a correction to /api/corrections, which persists it into `correction_report`
// keyed to the occurrence + the anon session, then optimistically acknowledges. The
// report is fire-and-safe: a backend failure never blocks the "thanks" the parent sees
// (matching the never-load-bearing posture of the analytics helpers). Real corrections
// now land in the DB for triage; the fixture stub is retired.

import { useState } from 'react';
import { reportCorrection } from '@/lib/corrections/client';

export function ReportWrongInfo({ occurrenceId }: { occurrenceId: string }) {
  const [sent, setSent] = useState(false);
  if (sent) {
    return (
      <p className="kf-panel" style={{ margin: '10px 0 0', color: 'var(--confirmed-text)', background: 'var(--confirmed-bg)' }}>
        Thanks — we&apos;ll recheck this listing against the source.
      </p>
    );
  }
  return (
    <button
      type="button"
      className="kf-link"
      onClick={() => {
        setSent(true); // optimistic — the acknowledgement shows immediately
        void reportCorrection(occurrenceId); // persisted best-effort; failures are swallowed
      }}
      style={{ width: '100%' }}
    >
      ⚑ Report wrong info
    </button>
  );
}
