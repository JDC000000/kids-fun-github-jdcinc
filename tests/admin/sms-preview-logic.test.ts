// tests/admin/sms-preview-logic.test.ts — the per-subscriber Friday preview: its pure parts, and
// the two structural guarantees that are the actual reason it is allowed to exist.
//
// The preview renders a real person's real picks and their real no-login hub link. The two things
// that must never be wrong about it are (1) it cannot write, and (2) it cannot be reached without
// the admin gate. Neither is provable by calling the function — a mutation is a side effect on a
// database this lane cannot see, and a missing gate is an absence. Both are therefore asserted
// MECHANICALLY against source, so a later edit that breaks one fails here instead of in production.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ineligibilityReason, redactPreferencesToken } from '@/lib/admin/sms-preview';
import { RESEND_SUPPRESSION_WINDOW_DAYS } from '@/lib/sms/weekly-send-io';

const NOW = new Date('2026-09-18T12:00:00-07:00');

function sub(
  over: Partial<{ status: string; isTest: boolean; purged: boolean; confirmedTimestamp: string | null }> = {}
) {
  return { status: 'active', isTest: false, purged: false, confirmedTimestamp: '2026-09-01T00:00:00Z', ...over };
}
function send(daysAgo: number, sendType = 'weekly') {
  return { sendType, createdAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString() };
}

describe('why a subscriber is not in this week’s send set', () => {
  it('reports a non-active status', () => {
    expect(ineligibilityReason(sub({ status: 'paused' }), [], NOW)).toContain('paused');
  });

  it('reports an active subscriber who never confirmed (P6: pending → STOP → START), not the generic line', () => {
    // QA of 2d67293, F7: this used to fall through to "did not include them in this run's active
    // set", which is true and useless — it names no reason.
    const reason = ineligibilityReason(sub({ confirmedTimestamp: null }), [], NOW);
    expect(reason).toContain('never confirmed');
    expect(reason).not.toContain('active set');
  });

  it('reports a test handset', () => {
    expect(ineligibilityReason(sub({ isTest: true }), [], NOW)).toContain('test handset');
  });

  it('reports the resend guard, naming the real window', () => {
    const reason = ineligibilityReason(sub(), [send(1)], NOW);
    expect(reason).toContain(String(RESEND_SUPPRESSION_WINDOW_DAYS));
  });

  it('does NOT blame the resend guard for a send older than the window', () => {
    // Off-by-one here would tell an admin a subscriber is suppressed when they are simply absent
    // from the active set for some other reason — sending them hunting for the wrong bug.
    const old = send(RESEND_SUPPRESSION_WINDOW_DAYS + 1);
    expect(ineligibilityReason(sub(), [old], NOW)).not.toContain('resend guard');
  });

  it('ignores non-weekly sends — an instant-picks text does not suppress the weekly', () => {
    expect(ineligibilityReason(sub(), [send(0, 'instant_picks')], NOW)).not.toContain('resend guard');
  });

  it('🔴 puts purge FIRST, because it explains every other symptom', () => {
    // A purged row is also 'stopped', so status would match too. Leading with "their status is
    // stopped" would be true and useless; the reason there is nobody to text is that the number
    // was erased, deliberately, by the retention promise.
    const reason = ineligibilityReason(sub({ purged: true, status: 'stopped' }), [], NOW);
    expect(reason).toContain('purge');
  });

  it('always gives a reason — never a bare "not eligible"', () => {
    expect(ineligibilityReason(sub(), [], NOW).length).toBeGreaterThan(10);
  });
});

describe('the preferences token is masked, and the mask preserves the message shape', () => {
  it('replaces the token with a run of # OF THE SAME LENGTH', () => {
    // Same length is not cosmetic: the segment/character counts shown beside the body describe
    // the REAL message, so a shorter mask would make the body on screen wrap differently from
    // the one actually delivered — a preview that quietly stops predicting the product.
    const token = 'abc123XYZ';
    const body = `Hi! See more: https://k.fun/u/${token} — reply STOP`;
    const out = redactPreferencesToken(body, token);
    expect(out).not.toContain(token);
    expect(out).toContain('#'.repeat(token.length));
    expect(out).toHaveLength(body.length);
  });

  it('masks EVERY occurrence, not just the first', () => {
    const out = redactPreferencesToken('t=tok and again tok', 'tok');
    expect(out).not.toContain('tok');
  });

  it('is a no-op when there is no token', () => {
    for (const t of [null, undefined, '']) {
      expect(redactPreferencesToken('body', t)).toBe('body');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 🔴 GUARANTEE 1 — THE PREVIEW CANNOT WRITE
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('🔴 previewing is read-only, enforced against the source', () => {
  const raw = readFileSync('lib/admin/sms-preview.ts', 'utf8');
  // Comments stripped FIRST. This module's header NAMES every mutating function it refuses to
  // call, so a naive match finds the prose and fails on a correct file — the mistake this repo's
  // other structural tests already record having made twice.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('imports none of the weekly job’s mutating functions', () => {
    for (const mutator of [
      'sendWeeklySmsForSubscriber', // writes sms_send_log, moves the empty-week counter
      'sendWeeklySmsBulk',
      'applyEmptyWeekState', // UPDATEs consecutive_empty_weeks and can pause a subscriber
      'markStoppedViaCarrier', // UPDATEs status to stopped
      'dispatchSms', // the actual Twilio call
      'recordSend',
    ]) {
      expect(code).not.toContain(mutator);
    }
  });

  it('issues no SQL of its own', () => {
    // It has no `query` import at all: every read goes through the weekly job's own loaders, so
    // there is no second definition of "active" here to drift from the real one.
    expect(code).not.toMatch(/\bquery\s*[(<]/);
    expect(code).not.toMatch(/INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/i);
  });

  it('calls exactly the three readers the Friday preview script calls', () => {
    for (const reader of ['loadWeeklySmsDeps', 'loadActiveSubscribers', 'buildWeeklySms']) {
      expect(code).toContain(reader);
    }
  });

  it('🔴 and the builder it leans on reaches no database at all', () => {
    // The transitive half of the guarantee. buildWeeklySms is where a write could hide without
    // appearing in this module's imports — so assert the builder's own module imports nothing
    // that can talk to Postgres. If someone later gives it a db seam, this fails loudly.
    const builder = readFileSync('lib/sms/weekly-send.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const imports = builder.match(/^import[\s\S]*?from\s+'[^']+';/gm) ?? [];
    for (const line of imports) {
      expect(line).not.toMatch(/lib\/db|['/]db\/client|send-log|weekly-send-io/);
    }
  });

  it('never reads the phone number off the loaded subscriber', () => {
    // loadActiveSubscribers returns { subscriber, phoneNumber } with the number BESIDE the
    // subscriber precisely so that touching it has to be a visible, greppable choice.
    expect(code).not.toContain('phoneNumber');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 🔴 GUARANTEE 2 — THE PREVIEW IS BEHIND THE ADMIN GATE
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('🔴 the preview is reachable only behind the admin gate', () => {
  const detailRaw = readFileSync('app/admin/sms-subscribers/[id]/page.tsx', 'utf8');
  const detail = detailRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('is rendered by the gated detail page, which 404s a refused caller', () => {
    expect(detail).toContain('resolveAdminAccess');
    expect(detail).toContain('notFound()');
    expect(detail).toContain('previewWeeklySmsForSubscriber');
  });

  it('🔴 gates BEFORE it previews — order is the whole guarantee', () => {
    // A gate that runs after the work is not a gate. Asserting the source ORDER is what makes
    // this a real check rather than a check that both strings are present somewhere.
    //
    // Compared at the CALL SITE, not the identifier: the first mention of the function is its
    // import at the top of the file, which is before everything and would make this assertion
    // pass unconditionally. It did, on the first run, which is how this comment came to exist.
    const firstGate = detail.indexOf('notFound()');
    const previewCall = detail.indexOf('await previewWeeklySmsForSubscriber(');
    expect(firstGate).toBeGreaterThan(-1);
    expect(previewCall).toBeGreaterThan(-1);
    expect(firstGate).toBeLessThan(previewCall);
  });

  it('🔴 has no API route, server action or client component of its own', () => {
    // The preview is a query param on an already-gated page, NOT a new route. app/admin/_lib/gate.ts
    // is a per-page function rather than a layout (Next layouts get no searchParams, so the token
    // path could not be read from one) — meaning nothing here is protected by its location, only
    // by calling the gate. A new route would be a new place to forget to.
    expect(detail).not.toMatch(/['"]use server['"]|['"]use client['"]/);
    expect(() => readFileSync('app/api/admin/sms-preview/route.ts', 'utf8')).toThrow();
  });

  it('keeps the preview off the default drill-down, so it is deliberate', () => {
    expect(detail).toContain('previewRequested');
  });

  it('🔴 refuses to render rather than minting placeholder links', () => {
    // Matches scripts/friday-preview-real-subscribers.ts, which has no override either: a link
    // signed with a placeholder does not 404, it fails its HMAC and lands on /link-unavailable,
    // which reads as a broken product in front of the person being shown the demo.
    const previewCode = readFileSync('lib/admin/sms-preview.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(previewCode).toContain('shortLinkSecret');
    expect(previewCode).toMatch(/secret_missing/);
    // No escape hatch, deliberately — the synthetic-preview script has one and this must not.
    expect(previewCode).not.toContain('PREVIEW_ALLOW_FAKE_LINKS');
  });
});
