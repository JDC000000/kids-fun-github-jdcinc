'use client';

// Consistent-help affordance (WCAG 3.2.6) — present in the same place on every
// detail. Fixture stub: acknowledges the report locally (no backend). The real
// corrections inbox lands with Screen 7 (data-health slice).

import { useState } from 'react';

export function ReportWrongInfo() {
  const [sent, setSent] = useState(false);
  if (sent) {
    return (
      <p className="kf-panel" style={{ margin: '10px 0 0', color: 'var(--confirmed-text)', background: 'var(--confirmed-bg)' }}>
        Thanks — we&apos;ll recheck this listing against the source.
      </p>
    );
  }
  return (
    <button type="button" className="kf-link" onClick={() => setSent(true)} style={{ width: '100%' }}>
      ⚑ Report wrong info
    </button>
  );
}
