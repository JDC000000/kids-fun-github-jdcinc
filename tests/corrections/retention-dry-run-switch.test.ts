// tests/corrections/retention-dry-run-switch.test.ts — F1: the CORRECTION_RETENTION_DRY_RUN
// operator kill-switch, table-tested over the spellings an operator actually types, and
// proven IDENTICAL on both runtimes that consume it.
//
// THE DEFECT THIS CLOSES. lib/corrections/retention-config.ts:57 used to read
// `env('CORRECTION_RETENTION_DRY_RUN') === 'true'` — an exact, lowercase, untrimmed literal
// comparison. QA reproduced the consequence in a container against a real database:
// CORRECTION_RETENTION_DRY_RUN="TRUE" and ="1" both failed that comparison, resolved to
// dryRun=false, and PERMANENTLY DELETED real correction_report rows while the operator
// believed deletions were paused. A kill-switch in front of an irreversible action that
// silently ignores the two most obvious spellings of "on" is worse than no kill-switch.
//
// WHY THE ASSERTIONS RUN THROUGH THE CALLERS, NOT JUST THE PARSER. "Both runtimes call the
// same function" is a claim about today's imports. What matters is the value that reaches
// purgeExpiredCorrectionReports() — the boundary where rows die — so each case drives the
// REAL Vercel route (app/api/corrections/retention/run/route.ts) and the REAL worker handler
// (worker/core/corrections-retention.ts) with the purge itself mocked, and compares what
// each one asked for. A future fork of the parse into one call site fails here.
//
// No database: the purge is mocked, so this is unit-lane.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  calls: [] as Array<{ dryRun: boolean | undefined }>,
}));

// One mock covers BOTH import specifiers: the route imports '@/lib/corrections/retention'
// and the worker imports '../../lib/corrections/retention', and vitest.config.ts's '@'
// alias resolves them to the same module id.
vi.mock('@/lib/corrections/retention', () => ({
  purgeExpiredCorrectionReports: vi.fn(async (opts: { dryRun?: boolean } = {}) => {
    shared.calls.push({ dryRun: opts.dryRun });
    return {
      dryRun: opts.dryRun === true,
      expired: 0,
      deleted: 0,
      batches: 0,
      retentionDays: 183,
      truncated: false,
    };
  }),
}));

import { POST } from '../../app/api/corrections/retention/run/route';
import { makeCorrectionsRetentionJobHandler } from '../../worker/core/corrections-retention';
import {
  CORRECTION_RETENTION_DRY_RUN_ENV,
  correctionRetentionDryRunForced,
  resolveCorrectionRetentionDryRun,
  type DryRunResolutionReason,
} from '../../lib/corrections/retention-config';

const SECRET = 'f1-kill-switch-test-secret';

/** `undefined` means the variable is UNSET (not empty — that is a separate case below). */
interface Case {
  raw: string | undefined;
  label: string;
  dryRun: boolean;
  reason: DryRunResolutionReason;
  why: string;
}

// Every spelling QA asked for, plus the empty string and the unset case, each with the mode
// it MUST resolve to. The two rows marked "was the live hazard" are the ones that deleted
// real rows before this fix.
const CASES: Case[] = [
  { raw: undefined, label: '<unset>', dryRun: false, reason: 'unset', why: 'documented default: retention really deletes' },
  { raw: '', label: '""', dryRun: false, reason: 'unset', why: 'empty is indistinguishable from unset (env() trims to undefined)' },
  { raw: 'true', label: '"true"', dryRun: true, reason: 'explicit_pause', why: 'the spelling that already worked' },
  { raw: 'TRUE', label: '"TRUE"', dryRun: true, reason: 'explicit_pause', why: 'WAS THE LIVE HAZARD — deleted real rows' },
  { raw: 'True', label: '"True"', dryRun: true, reason: 'explicit_pause', why: 'case-insensitive' },
  { raw: ' true ', label: '" true "', dryRun: true, reason: 'explicit_pause', why: 'surrounding whitespace trimmed' },
  { raw: '1', label: '"1"', dryRun: true, reason: 'explicit_pause', why: 'WAS THE LIVE HAZARD — deleted real rows' },
  { raw: 'yes', label: '"yes"', dryRun: true, reason: 'explicit_pause', why: 'obvious truthy spelling' },
  { raw: 'on', label: '"on"', dryRun: true, reason: 'explicit_pause', why: 'obvious truthy spelling' },
  { raw: 'false', label: '"false"', dryRun: false, reason: 'explicit_run', why: 'explicit: delete for real' },
  { raw: '0', label: '"0"', dryRun: false, reason: 'explicit_run', why: 'explicit: delete for real' },
  { raw: 'OFF', label: '"OFF"', dryRun: false, reason: 'explicit_run', why: 'explicit falsey, case-insensitive' },
  {
    raw: 'garbage',
    label: '"garbage"',
    dryRun: true,
    reason: 'unrecognised',
    why: 'FAIL SAFE — an unparseable value in front of a permanent delete pauses, loudly',
  },
];

function setSwitch(raw: string | undefined): void {
  if (raw === undefined) delete process.env[CORRECTION_RETENTION_DRY_RUN_ENV];
  else process.env[CORRECTION_RETENTION_DRY_RUN_ENV] = raw;
}

/** What the ROUTE asked the purge for, with no `dryRun` in the request body. */
async function routeDryRun(): Promise<boolean | undefined> {
  shared.calls.length = 0;
  const res = await POST(
    new Request('http://localhost/api/corrections/retention/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': SECRET },
      body: '{}',
    })
  );
  expect(res.status).toBe(200);
  expect(shared.calls).toHaveLength(1);
  return shared.calls[0].dryRun;
}

/** What the WORKER handler asked the purge for. */
async function workerDryRun(): Promise<boolean | undefined> {
  shared.calls.length = 0;
  const logged: string[] = [];
  const handler = makeCorrectionsRetentionJobHandler({ logger: { log: (m: string) => void logged.push(m) } });
  await handler({ id: 'job-f1', sourceId: null, jobType: 'corrections_retention', attempts: 1, maxAttempts: 1 });
  expect(shared.calls).toHaveLength(1);
  // The effective mode has to be READABLE IN THE LOG, not inferred from the env var whose
  // spelling is the thing that went wrong.
  expect(logged.join('\n')).toMatch(/effective mode/i);
  return shared.calls[0].dryRun;
}

describe('F1 — CORRECTION_RETENTION_DRY_RUN resolves the same way for every spelling', () => {
  let savedSwitch: string | undefined;
  let savedSecret: string | undefined;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedSwitch = process.env[CORRECTION_RETENTION_DRY_RUN_ENV];
    savedSecret = process.env.CORRECTION_RETENTION_CRON_SECRET;
    process.env.CORRECTION_RETENTION_CRON_SECRET = SECRET;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    shared.calls.length = 0;
  });

  afterEach(() => {
    if (savedSwitch === undefined) delete process.env[CORRECTION_RETENTION_DRY_RUN_ENV];
    else process.env[CORRECTION_RETENTION_DRY_RUN_ENV] = savedSwitch;
    if (savedSecret === undefined) delete process.env.CORRECTION_RETENTION_CRON_SECRET;
    else process.env.CORRECTION_RETENTION_CRON_SECRET = savedSecret;
    vi.restoreAllMocks();
  });

  for (const c of CASES) {
    it(`${c.label} → dryRun=${c.dryRun} (${c.reason}) — ${c.why}`, async () => {
      setSwitch(c.raw);

      // 1. the shared parser
      const resolved = resolveCorrectionRetentionDryRun();
      expect(resolved.dryRun).toBe(c.dryRun);
      expect(resolved.reason).toBe(c.reason);
      expect(correctionRetentionDryRunForced()).toBe(c.dryRun);

      // 2. what each CALLER actually hands to the purge — the boundary where rows die.
      const fromRoute = await routeDryRun();
      const fromWorker = await workerDryRun();
      expect(fromRoute).toBe(c.dryRun);
      expect(fromWorker).toBe(c.dryRun);

      // 3. and they agree with each other, which is the property the compliance claim
      //    rests on: a kill-switch that stops one runtime and not the other is a trap.
      expect(fromRoute).toBe(fromWorker);
    });
  }

  it('the UNSET default is unchanged: retention still really deletes', () => {
    // Deliberately pinned. Making "unset" mean "paused" would silently turn the automatic-
    // deletion promise off everywhere it has not been explicitly configured — the larger
    // harm, and the opposite of what the route, this module and .env.example all document.
    setSwitch(undefined);
    expect(correctionRetentionDryRunForced()).toBe(false);
    setSwitch('');
    expect(correctionRetentionDryRunForced()).toBe(false);
  });

  it('an unrecognised value WARNS — the pause is loud, not silent', () => {
    // Failing safe without saying so would leave retention quietly off forever. The warning
    // is the thing that gets the typo fixed.
    setSwitch('PAUSE-PLEASE');
    expect(resolveCorrectionRetentionDryRun().dryRun).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('PAUSE-PLEASE');
    expect(String(warn.mock.calls[0][0])).toContain('FAILING SAFE');
  });

  it('a recognised value does NOT warn', () => {
    setSwitch('TRUE');
    expect(resolveCorrectionRetentionDryRun().dryRun).toBe(true);
    setSwitch('false');
    expect(resolveCorrectionRetentionDryRun().dryRun).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('an explicit body {dryRun:true} still forces dry-run even when the switch says delete', async () => {
    // The route ORs the two (route.ts:66). Hardening the env parse must not have taken the
    // caller's own dry-run away.
    setSwitch('false');
    shared.calls.length = 0;
    const res = await POST(
      new Request('http://localhost/api/corrections/retention/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': SECRET },
        body: JSON.stringify({ dryRun: true }),
      })
    );
    expect(res.status).toBe(200);
    expect(shared.calls[0].dryRun).toBe(true);
  });
});
