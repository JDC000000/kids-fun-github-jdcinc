// tests/sms/sms_send_paths_consent.test.ts — every outbound SMS path, and the consent rule it is under.
//
// ═══ WHY THIS EXISTS (CASL fix, 2026-09-24) ═══
// The Instant Picks send texted never-confirmed subscribers because it borrowed a status rule
// written for something else (the on-page list) and nothing forced anyone to ask "what consent
// does this SEND require?". The fix gates that one path; this file is what stops the NEXT send
// path from repeating the mistake. It enumerates every module that can reach Twilio and fails if
// one appears that has not been classified below — so adding a send path means deciding, in
// review, which consent rule it is under.
//
// THE CLASSIFICATION (the boundary the fix draws):
//   • CONTENT — picks, "show me more", anything beyond the consent handshake. Only a subscriber
//     whose double opt-in is COMPLETE and not paused/withdrawn may receive one.
//   • CONSENT FLOW — the one confirmation request to a pending number, and the welcome that
//     acknowledges the JOIN reply. These are the handshake itself and MUST keep reaching pending /
//     just-confirmed rows; blocking them would make confirmation impossible.
//   • SEPARATE CONSENT SCOPE — the area waitlist's one promised notification, recorded in its own
//     table with its own consent (migration 0038) and held behind its own switch.
// STOP / START / HELP / unknown-keyword replies ride on the inbound webhook's TwiML response, not
// on `dispatchSms`, and are pinned by tests/sms/inbound_*.test.ts.
//
// Reads source only — no database, so it stays in the `unit` lane.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['lib', 'app', 'worker', 'scripts'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Every module that imports the Twilio seam, or talks to Twilio's API / SDK directly. */
function modulesThatCanSend(): string[] {
  const hits: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      if (rel === 'lib/sms/twilio-client.ts') continue; // the seam itself
      const src = readFileSync(file, 'utf8');
      if (
        /from\s+['"](\.\/|@\/lib\/sms\/|\.\.\/lib\/sms\/|(\.\.\/)+lib\/sms\/)twilio-client['"]/.test(src) &&
        /\bdispatchSms\b/.test(src)
      ) {
        hits.push(rel);
      } else if (/api\.twilio\.com|from\s+['"]twilio['"]|require\(\s*['"]twilio['"]\s*\)/.test(src)) {
        hits.push(rel);
      }
    }
  }
  return hits.sort();
}

const CLASSIFIED: Record<string, 'content' | 'consent-flow' | 'separate-consent-scope'> = {
  'lib/sms/instant-picks-send.ts': 'content',
  'lib/sms/weekly-send-io.ts': 'content',
  'lib/sms/signup-store.ts': 'consent-flow', // the one confirmation request (pending, by design)
  'lib/sms/welcome.ts': 'consent-flow', // acknowledges JOIN; route sends it only on `applied`
  'lib/sms/waitlist-notify.ts': 'separate-consent-scope',
};

describe('⛔ every outbound SMS path is classified under a consent rule', () => {
  it('no module can reach Twilio without appearing in the classification above', () => {
    // If this fails with a NEW file: decide which consent rule it is under, add it to CLASSIFIED,
    // and — if it sends CONTENT — make it prove confirmed, active consent before it dispatches.
    expect(modulesThatCanSend()).toEqual(Object.keys(CLASSIFIED).sort());
  });
});

describe('⛔ CONTENT paths gate on confirmed, active consent', () => {
  it('Instant Picks: the consent gate runs before the throttle, the render and the dispatch', () => {
    const src = read('lib/sms/instant-picks-send.ts');
    const body = src.slice(src.indexOf('export async function sendInstantPicksText'));
    const gate = body.indexOf('if (!hasConfirmedActiveConsent(subscriber)) return held;');
    expect(gate).toBeGreaterThan(-1);
    for (const later of [
      'options.checkThrottle ?? checkAndRecordInstantPicksSend',
      'renderInstantPicksMessage(',
      'options.dispatch ?? dispatchSms',
      'options.record ?? recordSmsSend',
    ]) {
      const at = body.indexOf(later);
      expect(at, later).toBeGreaterThan(gate);
    }
  });

  it('Instant Picks: the predicate requires BOTH active status and a recorded confirmation', () => {
    const src = read('lib/sms/instant-picks-send.ts');
    expect(src).toMatch(
      /return subscriber\.status === 'active' && subscriber\.confirmedTimestamp != null;/
    );
    // …and the loader actually reads the two columns it is judged on.
    expect(src).toMatch(/SELECT id, phone_number, preferences_token, consent_text_version,\s+status, confirmed_timestamp/);
  });

  it('Weekly: the subscriber load selects only active rows', () => {
    const src = read('lib/sms/weekly-send-io.ts');
    const fn = src.slice(src.indexOf('export async function loadActiveSubscribers'));
    const sql = fn.slice(0, fn.indexOf('`,') + 2);
    expect(sql).toMatch(/WHERE c\.status = 'active'/);
  });

  it('Weekly: the single-subscriber run route resolves its target from the ACTIVE set only', () => {
    const src = read('app/api/sms/weekly/run/route.ts');
    // The one path that sends to a named subscriber must pick them out of loadActiveSubscribers(),
    // never load a row by id on its own.
    expect(src).toMatch(/loadActiveSubscribers\(\)/);
    expect(src).not.toMatch(/FROM\s+sms_consent/);
  });
});

describe('CONSENT-FLOW paths are NOT blocked by the fix', () => {
  it('the confirmation request does not consult subscriber status — it IS the pending handshake', () => {
    const src = read('lib/sms/signup-store.ts');
    const fn = src.slice(src.indexOf('export async function sendConfirmationRequest'));
    expect(fn).not.toMatch(/hasConfirmedActiveConsent/);
  });

  it('the welcome is not gated on the content rule — it is sent on the JOIN transition itself', () => {
    expect(read('lib/sms/welcome.ts')).not.toMatch(/hasConfirmedActiveConsent/);
  });
});
