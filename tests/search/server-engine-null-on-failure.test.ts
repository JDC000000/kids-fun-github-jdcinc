// tests/search/server-engine-null-on-failure.test.ts
//
// lib/search/server-engine.ts states one contract in its header: on a genuine failure to
// load the read model it returns NULL, never an engine. That contract was prose only, and
// prose does not execute.
//
// It matters because of what /account does with the answer. `getServerSearchEngine()` → null
// means the row renders NO line (app/account/page.tsx). An engine that is merely WRONG —
// the hand-authored fixture bundle standing in for an unreachable production database — is
// far worse than no engine: nearly every real saved search comes back empty against it, so
// /account confidently prints "No matches right now — removing the X would show results."
// That is "we could not check" rendering as "nothing matched", which is the exact falsehood
// this whole unit exists to prevent, reintroduced through the one module whose job is to
// prevent it.
//
// The obvious tired-developer rewrite of the catch block — fall back to the fixture engine,
// three lines, suite stays green — is the mutation this file exists to redden.
//
// NB this is a UNIT-lane file and must stay one: it never reaches a database, it proves the
// path where reaching one FAILS. So it deliberately uses neither of the two signals
// tests/vitest-lane-split.test.ts scans source text for — the repo's DB-gate idiom, and a
// value import of the pool-constructing db client. (That scan is textual, so quoting either
// signal in a comment here would route this file into the serial lane by accident.)
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Local host (so lib/testing/local-db-guard is satisfied), port with nothing listening. */
const UNREACHABLE_DB = 'postgres://postgres:postgres@127.0.0.1:55599/nope';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadEngine() {
  vi.resetModules();
  const mod = await import('@/lib/search/server-engine');
  return mod.getServerSearchEngine();
}

describe('getServerSearchEngine — "could not check" must never become "nothing matched"', () => {
  it('returns null in database mode when the read model cannot be loaded', async () => {
    vi.stubEnv('KIDS_FUN_SEARCH_BACKEND', 'database');
    vi.stubEnv('DATABASE_URL', UNREACHABLE_DB);

    // NOT "an engine over fixtures". Null, so /account renders no line at all.
    await expect(loadEngine()).resolves.toBeNull();
  });

  // Positive control: the same harness DOES observe a real engine when one is available,
  // so the assertion above is a measurement rather than a vacuous null.
  it('still returns a working engine in fixture mode', async () => {
    vi.stubEnv('KIDS_FUN_SEARCH_BACKEND', 'fixture');
    const engine = await loadEngine();
    expect(engine).not.toBeNull();
    expect(engine?.search({ q: 'storytime', minResults: 0 }).total).toBeGreaterThan(0);
  });
});
