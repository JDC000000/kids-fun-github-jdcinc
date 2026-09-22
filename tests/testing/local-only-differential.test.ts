// tests/testing/local-only-differential.test.ts — differential property test for the only control
// standing between the incident toolkit's MUTATING helpers and a real database.
//
// ═══ WHY THIS IS IN THE REPO AND NOT A ONE-OFF SCRIPT ═══
// This property was first checked ad hoc, by the same people who wrote the fix. A developer
// re-running a property check against their own implementation is CI, not a second opinion — and
// the check itself is the valuable artefact, not the run. It lives here so it keeps asking.
//
// ═══ THE ORACLE IS pg's ConnectionParameters, NOT pg-connection-string.parse() ═══
// parse() is the right thing for the IMPLEMENTATION to delegate to, and the wrong thing to judge
// it by. pg resolves `config.host || process.env.PGHOST || default`, so a hostless string parses
// to '' — which compares "equal" under a parse()-only oracle while pg genuinely dials PGHOST.
// Measured: parse('postgres://u:p@/db').host === '' while ConnectionParameters resolves it to
// whatever PGHOST names. Judging the guard by parse() alone would be the SAME mistake as the bug
// this test exists to catch, moved one level up into the test.
//
// Today's implementation is PGHOST-safe by construction — it refuses anything whose resolved host
// is not loopback, and a truthy parsed host means pg ignores PGHOST anyway — so the weaker oracle
// would give the right answer right now. That is exactly why it must not be used: it would wave
// through a future "improvement" that resolved hostless URLs via PGHOST.
//
// ═══ THE TEST MUST PROVE IT CAN STILL FAIL ═══
// Two known-bad implementations are kept as fixtures and run through the same corpus. If either
// stops being caught, the corpus has gone blind and this file says so — rather than reporting a
// reassuring pass against an implementation nothing is testing any more.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const ConnectionParameters = req('pg/lib/connection-parameters.js');
const GUARD = '../../scripts/incident/negative/_local-only.cjs';
const NUL = String.fromCharCode(0);
const REMOTE = 'db.abcdefgh.supabase.co';

// Orthogonal axes rather than a hand-listed set: hand-listing only covers the shapes you already
// thought of, which is precisely how the original hole survived review.
const SCHEMES = ['postgres://', 'postgresql://'];
const USERINFO = ['', 'u:p@', 'u:p%40x@'];
const HOSTS = ['127.0.0.1', 'localhost', '[::1]', '127.0.0.1.', 'LOCALHOST', '', REMOTE, '10.0.0.5'];
const PORTS = ['', ':5432'];
const HOSTVALS = ['127.0.0.1', 'localhost', REMOTE, '', '/var/run/postgresql', '[::1]',
  '::ffff:7f00:1', '127.0.0.1.', `${REMOTE}.`, `${REMOTE}${NUL}.evil`, '127.0.0.1 ', ' 127.0.0.1',
  `${REMOTE}:5432`, '%2Fvar%2Frun', '0177.0.0.1'];
const KEYCASE = ['host', 'HOST', 'hOsT'];

function queries(): string[] {
  const out: string[] = [''];
  for (const k of KEYCASE) for (const v of HOSTVALS) out.push(`${k}=${v}`);
  for (const v of HOSTVALS) out.push(`sslmode=disable&host=${v}`);
  // Duplicate host params — the axis the first attempted fix failed on, in both orders.
  for (const v of HOSTVALS) out.push(`host=127.0.0.1&host=${v}`, `host=${v}&host=127.0.0.1`);
  for (const v of HOSTVALS) out.push(`host=${v}&HOST=${REMOTE}`, `host=127.0.0.1&host=${v}&host=${REMOTE}`);
  out.push('host', 'host=&', `&host=${REMOTE}`);
  return out;
}

function corpus(): string[] {
  const qs = queries();
  const out: string[] = [];
  for (const s of SCHEMES) for (const ui of USERINFO) for (const h of HOSTS) for (const p of PORTS)
    for (const q of qs) out.push(`${s}${ui}${h}${p}/db${q ? `?${q}` : ''}`);
  return out;
}

function pgWillDial(cs: string): string | null {
  try { return new ConnectionParameters({ connectionString: cs }).host; } catch { return null; }
}

/** Is the host pg will REALLY dial a loopback/socket target? Independent of the implementation. */
function isTrulyLocal(h: string | null): boolean {
  if (typeof h !== 'string') return false;
  if (h.startsWith('/')) return true;
  const n = h.trim().toLowerCase().replace(/\.+$/, '').replace(/^\[|\]$/g, '');
  return n === 'localhost' || n === '::1' || n === '0.0.0.0' || n === '::ffff:7f00:1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(n);
}

type Result = { total: number; unsafe: number; overStrict: number; samples: string[] };

function score(modulePath: string, cases: string[] = corpus()): Result {
  const { assertLoopback } = req(modulePath) as { assertLoopback: (cs: string) => void };
  const saved = process.env.PGHOST;
  const r: Result = { total: 0, unsafe: 0, overStrict: 0, samples: [] };
  try {
    for (const pgh of [undefined, REMOTE, '127.0.0.1']) {
      if (pgh === undefined) delete process.env.PGHOST; else process.env.PGHOST = pgh;
      for (const cs of cases) {
        r.total++;
        let allowed = true;
        try { assertLoopback(cs); } catch { allowed = false; }
        const truth = isTrulyLocal(pgWillDial(cs));
        // UNSAFE is the only direction that matters: the guard said yes to something pg would
        // dial off-box. Over-strict is recorded but tolerated — these helpers only ever target a
        // TCP loopback replica, so refusing a socket or hostless form is correct, not a defect.
        if (allowed && !truth) {
          r.unsafe++;
          if (r.samples.length < 5) {
            r.samples.push(`PGHOST=${String(pgh)} ${JSON.stringify(cs)} -> pg dials ${JSON.stringify(pgWillDial(cs))}`);
          }
        } else if (!allowed && truth) r.overStrict++;
      }
    }
  } finally {
    if (saved === undefined) delete process.env.PGHOST; else process.env.PGHOST = saved;
  }
  return r;
}

describe('_local-only: the guard agrees with the host pg actually dials', () => {
  it('the corpus is large and varied enough to be worth running', () => {
    expect(corpus().length).toBeGreaterThan(5000);
  });

  it('CURRENT implementation: zero unsafe verdicts across the corpus', () => {
    const r = score(GUARD);
    expect(
      r.unsafe,
      `allowed ${r.unsafe} connection strings pg would dial off-box, e.g.\n  ${r.samples.join('\n  ')}`
    ).toBe(0);
  });

  // ═══ PROOF THE CORPUS STILL HAS TEETH ═══
  // Without these, a corpus that silently stopped generating dangerous shapes would report a clean
  // pass forever. These assert the test can still FAIL, which is the only thing that makes the
  // assertion above mean anything.
  // ═══ THESE ASSERTIONS USED TO BE NARROWER THAN THEIR OWN TITLES ═══
  // Both simply asked for `unsafe > 0` over the WHOLE corpus. A reviewer deleted both
  // duplicate-host axes from the generator and all five tests stayed green, because the
  // first-attempt fixture still scores plenty of unsafe results through unrelated shapes
  // (bare remote host, host=&, ...). So the test that claimed to prove the corpus could still
  // see duplicate-host blindness proved nothing of the kind.
  //
  // Each fixture is now scored on the SUBSET that actually exercises its bug, and the subset
  // itself is asserted to be substantial. A floor of `> 0` would still pass on one lucky case.

  it('still catches the ORIGINAL bug, on genuine ?host= bypasses specifically', () => {
    // The defining shape: the URL SPELLS loopback while pg DIALS somewhere else.
    const bypasses = corpus().filter((cs) => {
      let spelled = '';
      try { spelled = new URL(cs).hostname; } catch { return false; }
      return isTrulyLocal(spelled) && !isTrulyLocal(pgWillDial(cs));
    });
    expect(bypasses.length, 'the corpus no longer generates ?host= bypasses — it has gone blind')
      .toBeGreaterThan(500);
    expect(score('./fixtures/assertloopback-bad-original.cjs', bypasses).unsafe).toBeGreaterThan(500);
  });

  it('still catches the FIRST-ATTEMPT fix, on duplicate-host shapes specifically', () => {
    // Two or more host= params is the ONLY axis that separates first-of-duplicates from
    // last-of-duplicates. If this subset empties, the fixture stops being a meaningful control
    // even though it would keep failing for unrelated reasons.
    const dupes = corpus().filter((cs) => (cs.match(/[?&]host=/gi) ?? []).length >= 2);
    expect(dupes.length, 'the corpus no longer generates duplicate-host spellings — it has gone blind')
      .toBeGreaterThan(500);
    expect(score('./fixtures/assertloopback-bad-firstfix.cjs', dupes).unsafe).toBeGreaterThan(100);
  });

  it('the oracle is pg-CONNECTION truth, not parser truth', () => {
    // Pins the distinction this file's header argues for, so nobody can "simplify" the oracle to
    // parse().host without a test objecting.
    const saved = process.env.PGHOST;
    try {
      process.env.PGHOST = REMOTE;
      expect(pgWillDial('postgres://u:p@/db')).toBe(REMOTE);
      expect(req('pg-connection-string').parse('postgres://u:p@/db').host ?? '').toBe('');
    } finally {
      if (saved === undefined) delete process.env.PGHOST; else process.env.PGHOST = saved;
    }
  });
});
