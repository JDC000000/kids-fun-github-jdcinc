// lib/corrections/client.ts — browser helper that POSTs a "Report wrong info"
// correction to /api/corrections.
//
// Unlike the analytics beacon this is a deliberate user action tied to an optimistic
// on-screen acknowledgement, so it uses a normal fetch and resolves with whether the
// server accepted it. It NEVER throws — a network failure resolves to { ok:false } so
// the component's optimistic "thanks" is never contradicted by an exception.
'use client';

import type { CorrectionIssueType } from './types';

export interface ReportCorrectionInput {
  issueType?: CorrectionIssueType;
  note?: string;
}

const ENDPOINT = '/api/corrections';

/** Fire a correction report from the browser. Returns { ok } (ok=false on any
 *  transport failure); never throws. */
export async function reportCorrection(
  occurrenceId: string,
  input: ReportCorrectionInput = {}
): Promise<{ ok: boolean }> {
  try {
    if (typeof fetch === 'undefined') return { ok: false };
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ occurrenceId, ...input }),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}
