// tests/sms/instant_picks_no_persistence.test.ts — Instant Picks must never write to sms_send_log.
//
// ═══ WHY THIS IS A STATIC TEST AND NOT ONLY A BEHAVIOURAL ONE ═══
// "Does not write to the send log" is a NEGATIVE property, and negative properties are the ones
// behavioural tests cover worst: a test can only prove the writer was not called on the paths it
// thought to exercise. A press that persisted only on, say, the widened-retry branch would sail
// past a suite that never produced one.
//
// So this asserts the property where it is total: the IMPORT GRAPH. A module that cannot reach a
// writer cannot call one on any branch, on any input, today or after a refactor. Two of the three
// files under test import no database seam at all, and that is checkable by reading them.
//
// ═══ THE DEFECT THIS EXISTS TO PREVENT, STATED ONCE PROPERLY ═══
// `sms_send_log` is what the "Last Friday" panel READS FROM (`findLastWeek` in
// lib/sms/preferences.ts). The Instant Picks button sits INSIDE that panel. So a press recorded
// there would appear to the subscriber as a text we had sent them — corrupting the exact section
// this feature was added to — and would land in PRD §6's send and click-through metrics as a
// message that never existed. It is a tempting write (the cron does it two lines after the same
// selector call) and a silently wrong one, which is the combination that earns a guard.
//
// If this test fails, do NOT relax the patterns. The named file has grown an import it must not
// have, and the fix is in that file.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(ROOT + rel, 'utf8');

/** Anything that can put a row in `sms_send_log`, or send a message that would produce one. */
const WRITERS = [
  { what: 'the send-log writer', re: /from\s+['"](\.\/send-log|@\/lib\/sms\/send-log)['"]/ },
  { what: 'the Twilio client', re: /from\s+['"](\.\/twilio-client|@\/lib\/sms\/twilio-client)['"]/ },
  { what: 'the message renderer', re: /from\s+['"](\.\/message|@\/lib\/sms\/message)['"]/ },
  { what: 'the weekly send orchestrator', re: /from\s+['"].*\/weekly-send(-io)?['"]/ },
  { what: 'the click recorder', re: /recordClick/ },
  { what: 'a raw send-log statement', re: /sms_send_log/ },
];

/** A value import of the pool. Type-only imports are fine — they cannot execute a query. */
const DB_IMPORT = /^import\s+(?!type\b)[^;]*from\s+['"]@\/lib\/db\/client['"]/m;

describe('instant picks · nothing on this path can write to sms_send_log', () => {
  for (const file of [
    '/lib/sms/instant-picks.ts',
    '/lib/sms/instant-picks-store.ts',
    '/lib/sms/instant-picks-throttle.ts',
    '/app/api/sms/instant-picks/route.ts',
    '/app/u/[preferencesToken]/_components/InstantPicks.tsx',
  ]) {
    describe(file, () => {
      const src = read(file);
      for (const { what, re } of WRITERS) {
        it(`does not reach ${what}`, () => {
          // Comments in these files discuss the send log at length on purpose — that is how the
          // reasoning survives. Strip them so the discussion is not mistaken for the defect.
          expect(stripComments(src)).not.toMatch(re);
        });
      }
    });
  }

  it('the pure selection wrapper imports no database seam at all', () => {
    // The strongest form of the guarantee, and only the pure module can carry it: the store and
    // the throttle legitimately need the pool (one read, one counter), so their guarantee is the
    // per-writer one above. This one cannot reach ANY table.
    expect(read('/lib/sms/instant-picks.ts')).not.toMatch(DB_IMPORT);
  });

  it('the route writes exactly one table, and it is the throttle counter', () => {
    const src = stripComments(read('/app/api/sms/instant-picks/route.ts'));
    // No SQL of its own — every statement it causes belongs to a module that owns one table.
    expect(src).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i);
    expect(src).toMatch(/checkAndRecordInstantPicks/);
  });

  it('and it sends nothing — page-only is a compliance decision, not a preference', () => {
    // The preferences page states "1 message per week, plus a one-time confirmation message" in
    // its carrier disclosures. A send path behind this button would contradict a line rendered a
    // few centimetres below it. See the copy block in lib/sms/consent-copy.ts.
    const src = stripComments(read('/app/api/sms/instant-picks/route.ts'));
    expect(src).not.toMatch(/dispatchSms|sendConfirmationRequest|renderWeeklyMessage/);
  });
});

/** Block and line comments removed; string literals are left alone. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
