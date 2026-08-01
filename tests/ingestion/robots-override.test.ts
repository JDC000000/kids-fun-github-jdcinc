// tests/ingestion/robots-override.test.ts — F-5: the unreadable-robots.txt override,
// pure-logic half. The DB half (scheduler ↔ gate equivalence, the CHECK constraints, and
// the "no other source changed" proof against the real table) is
// tests/scheduler/robots-override-db.test.ts — this file deliberately has no DB access so
// it runs in the fast parallel lane.
//
// WHAT THIS IS DEFENDING. Exactly one source (NVDPL) may run despite a robots.txt that
// cannot be read, because a named human decision (D-12) accepted that risk for it by name.
// The failure that matters is not "the override doesn't work" — it is the override working
// for something it was never granted to. So the truth table below is written from the
// negative side first: everything that must STILL fail closed, then the one case that
// passes.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluateLiveFetchGate,
  evaluateTermsGate,
  hasRobotsUnverifiableOverride,
  isRobotsClearedForLiveFetch,
  robotsClearedForLiveFetchSql,
  SOURCE_GATE_COLUMNS,
  type SourceTermsInfo,
} from '../../worker/core/terms-gate';

const APPROVED = 'summarise_only'; // NVDPL's intended terms posture (§6.8)
const D12 = 'D-12';

function src(over: Partial<SourceTermsInfo>): SourceTermsInfo {
  return { id: 's1', termsStatus: APPROVED, robotsStatus: 'pending', ...over };
}

describe('F-5 robots override — what must STILL fail closed', () => {
  // The single most important assertion in this file. 'unknown' is the honest record of
  // "we looked and could not determine", but it is ALSO the state of a source nobody ever
  // checked. Only the decision reference distinguishes them, so only the decision
  // reference may open the gate.
  it('robots_status=unknown with NO decision reference is blocked (never-checked stays closed)', () => {
    const s = src({ robotsStatus: 'unknown' });
    expect(hasRobotsUnverifiableOverride(s)).toBe(false);
    expect(isRobotsClearedForLiveFetch(s)).toBe(false);
    expect(evaluateLiveFetchGate(s, 'production').allowed).toBe(false);
    expect(evaluateLiveFetchGate(s, 'staging').allowed).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['a tab', '\t'],
  ])('robots_status=unknown with a %s decision reference is blocked', (_label, decision) => {
    // '' and '   ' are the ones with teeth: both are non-NULL, so a gate written as
    // `robotsOverrideDecision != null` — the obvious first draft — would hand a blank
    // string the same clearance as a real decision record.
    const s = src({ robotsStatus: 'unknown', robotsOverrideDecision: decision });
    expect(hasRobotsUnverifiableOverride(s)).toBe(false);
    expect(evaluateLiveFetchGate(s, 'production').allowed).toBe(false);
  });

  it.each(['pending', 'disallowed', 'allowed_typo', ''])(
    'a decision reference does NOT clear robots_status=%s — the override only speaks for "unreadable"',
    (robotsStatus) => {
      const s = src({ robotsStatus, robotsOverrideDecision: D12 });
      expect(hasRobotsUnverifiableOverride(s)).toBe(false);
      expect(evaluateLiveFetchGate(s, 'production').allowed).toBe(false);
    }
  );

  it('the override does not discharge the TERMS gate — it answers one question only', () => {
    for (const termsStatus of ['pending', 'disallowed', 'blocked']) {
      const s = src({ termsStatus, robotsStatus: 'unknown', robotsOverrideDecision: D12 });
      expect(evaluateLiveFetchGate(s, 'production').allowed).toBe(false);
      expect(evaluateLiveFetchGate(s, 'production').reason).toMatch(/terms_status/);
    }
  });

  it('an omitted robotsStatus is still blocked, override reference or not', () => {
    expect(evaluateLiveFetchGate({ id: 's', termsStatus: APPROVED }, 'production').allowed).toBe(false);
    expect(
      evaluateLiveFetchGate({ id: 's', termsStatus: APPROVED, robotsOverrideDecision: D12 }, 'production').allowed
    ).toBe(false);
  });
});

describe('F-5 robots override — the one case that passes', () => {
  const nvdpl = src({ termsStatus: APPROVED, robotsStatus: 'unknown', robotsOverrideDecision: D12 });

  it('robots_status=unknown + a real decision reference clears the robots half of the gate', () => {
    expect(hasRobotsUnverifiableOverride(nvdpl)).toBe(true);
    expect(isRobotsClearedForLiveFetch(nvdpl)).toBe(true);
    expect(evaluateLiveFetchGate(nvdpl, 'production').allowed).toBe(true);
    expect(evaluateLiveFetchGate(nvdpl, 'staging').allowed).toBe(true);
  });

  it('the decision reference is named in the gate reason, so exercising it lands in the audit trail', () => {
    // The reason string is persisted by callers (source_check_run.errors / the run log).
    // An override that is invisible every time it fires is an override nobody can audit.
    const reason = evaluateLiveFetchGate(nvdpl, 'production').reason;
    expect(reason).toContain(D12);
    expect(reason).toMatch(/UNREADABLE/i);
  });

  it('a padded reference is honoured but still reported (trim is for detection, not silent repair)', () => {
    const padded = src({ robotsStatus: 'unknown', robotsOverrideDecision: '  D-12  ' });
    expect(hasRobotsUnverifiableOverride(padded)).toBe(true);
    expect(evaluateLiveFetchGate(padded, 'production').allowed).toBe(true);
  });
});

describe('F-5 robots override — no behaviour change for any source without one', () => {
  // The regression proof, stated as an equivalence rather than a list of cases: for every
  // source that carries NO override — which today is every source in the registry except
  // one row — the new predicate must return exactly what the old one did
  // (`robotsStatus === 'allowed'`). If that ever stops holding, this change leaked.
  const OLD_PREDICATE = (s: SourceTermsInfo): boolean => s.robotsStatus === 'allowed';
  const ROBOTS_VALUES = ['pending', 'allowed', 'disallowed', 'unknown', undefined];
  const TERMS_VALUES = ['pending', 'allowed', 'summarise_only', 'disallowed', 'blocked'];

  it.each(ROBOTS_VALUES)('robots_status=%s with no override behaves exactly as before', (robotsStatus) => {
    for (const termsStatus of TERMS_VALUES) {
      for (const decision of [undefined, null]) {
        const s = src({ termsStatus, robotsStatus, robotsOverrideDecision: decision });
        expect(isRobotsClearedForLiveFetch(s)).toBe(OLD_PREDICATE(s));
        // …and end-to-end through the gate, not just the sub-predicate.
        const expected = ['allowed', 'summarise_only'].includes(termsStatus) && OLD_PREDICATE(s);
        expect(evaluateLiveFetchGate(s, 'production').allowed).toBe(expected);
        expect(evaluateLiveFetchGate(s, 'staging').allowed).toBe(expected);
      }
    }
  });

  it('the looser run gate (fixture/staging review) is untouched by the override', () => {
    // evaluateTermsGate only ever cared about robots 'disallowed'. Adding the override must
    // not have widened or narrowed it — a change here would alter fixture-run behaviour for
    // every source in the project.
    for (const robotsStatus of ROBOTS_VALUES) {
      for (const decision of [undefined, D12]) {
        const s = src({ robotsStatus, robotsOverrideDecision: decision });
        expect(evaluateTermsGate(s, 'staging').allowed).toBe(robotsStatus !== 'disallowed');
      }
    }
  });
});

describe('F-5 robots override — the rule is authored once', () => {
  const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

  // THE ORIGINAL BUG, as a test. The robots rule is enforced in two independent machines:
  // TypeScript (per-run gate) and SQL (the scheduler's set-based predicate). QA found that
  // updating only one of them yields a source that passes "is this allowed?" and is never
  // actually enqueued — enabled everywhere a human looks, and silently dead. The DB-backed
  // equivalence proof lives in tests/scheduler/robots-override-db.test.ts; this is the
  // cheap structural half that fails the instant someone re-inlines a second copy.
  it('the scheduler takes its robots predicate from terms-gate.ts rather than restating it', () => {
    const scheduler = read('worker/scheduler/tiered.ts');
    // Interpolated into the WHERE clause specifically — a leftover import would satisfy a
    // bare "the file mentions it" check even after the predicate had been re-inlined.
    expect(scheduler).toMatch(/WHERE[\s\S]*\$\{robotsClearedForLiveFetchSql\('s'\)\}/);
    // No hand-written robots_status literal may reappear in the scheduler.
    expect(scheduler).not.toMatch(/robots_status\s*=\s*'/);
  });

  it('the SQL twin and the TS predicate name the same two states and the same column', () => {
    const sql = robotsClearedForLiveFetchSql('s');
    expect(sql).toMatch(/s\.robots_status\s*=\s*'allowed'/);
    expect(sql).toMatch(/s\.robots_status\s*=\s*'unknown'/);
    expect(sql).toContain('robots_override_decision');
    // Blank-rejection must exist on the SQL side too, not only in TypeScript — the
    // scheduler never runs the TS predicate.
    expect(sql).toMatch(/btrim\(coalesce\(s\.robots_override_decision, ''\)\)\s*<>\s*''/);
    expect(robotsClearedForLiveFetchSql('src')).toContain('src.robots_status');
  });

  it('every SELECT that feeds a live-fetch gate reads the override column', () => {
    // A gate handed a row without robots_override_decision fails closed on an authorised
    // source, and nothing reports the omission — the same "silently never runs" shape,
    // moved from the predicate into the query. These are the three call sites of
    // evaluateLiveFetchGate that build their source from SQL.
    expect(SOURCE_GATE_COLUMNS).toContain('robots_override_decision');
    for (const file of ['worker/core/source-runner.ts', 'worker/adapters/seasonal/index.ts']) {
      const text = read(file);
      expect(text, `${file} must project the shared gate column list`).toContain('SOURCE_GATE_COLUMNS');
      expect(text, `${file} must map the column onto the gate input`).toContain('robotsOverrideDecision');
    }
  });
});

describe('F-5 robots override — the registry declares exactly one, and it is still gated off', () => {
  const seed = readFileSync(resolve(process.cwd(), 'supabase/seeds/sources.sql'), 'utf8');

  it('exactly one statement in the seed grants an override, and it targets NVDPL by name', () => {
    // Counted per STATEMENT, not per literal: the grant's own WHERE clause names the
    // decision a second time (that guard is what makes re-seeding non-destructive), so a
    // naive occurrence count reads 2 for a single grant and would have to be "fixed" by
    // loosening it — the wrong direction for a test whose whole job is "only one".
    const grants = seed
      .split(/\bUPDATE\s+source\b/i)
      .slice(1)
      .filter((stmt) => /robots_override_decision\s*=\s*'/.test(stmt));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain('D-12');
    expect(grants[0]).toContain('North Vancouver District Public Library Events RSS');

    // …and every decision reference anywhere in the seed is that same one.
    const referenced = new Set(
      [...seed.matchAll(/robots_override_decision\s*=\s*'([^']+)'/g)].map((m) => m[1])
    );
    expect([...referenced]).toEqual(['D-12']);
  });

  it('the seed records the FACT as unknown, never as allowed', () => {
    // Writing 'allowed' would assert a robots.txt somebody read. Nobody can read this one.
    expect(seed).toMatch(/robots_status\s*=\s*'unknown'/);
    expect(seed).not.toMatch(/robots_status\s*=\s*'allowed'/);
  });

  it('the seed does not production-enable NVDPL — terms_status promotion stays out-of-band', () => {
    // The override answers the robots question only. With terms_status still 'pending',
    // both enforcement points refuse this row on terms, before robots is even reached —
    // so applying this seed to a live database cannot start a fetch on its own.
    expect(seed).not.toMatch(/terms_status\s*=\s*'/);
    const gated = {
      id: 'nvdpl',
      termsStatus: 'pending',
      robotsStatus: 'unknown',
      robotsOverrideDecision: 'D-12',
    };
    expect(evaluateLiveFetchGate(gated, 'production').allowed).toBe(false);
    expect(evaluateLiveFetchGate(gated, 'staging').allowed).toBe(false);
  });

  it('the note points at the reasoning instead of copying it', () => {
    expect(seed).toMatch(/robots_override_note\s*=\s*'[^']*docs\/source-register\.md[^']*'/);
  });
});
