// tests/testing/local-db-guard.test.ts — unit coverage for the Round 27 loopback DB
// safety net (lib/testing/local-db-guard.ts). Pure string logic, no database needed, so
// it runs in every CI lane and proves the guard blocks a remote DB URL while allowing the
// legitimate local ones (CI's localhost, docker 127.0.0.1, the e2e harness, unix sockets).
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLocalDatabaseUrl,
  assertTestDatabaseUrl,
  databaseUrlHost,
  isLocalDatabaseHost,
  isManagedDatabaseHost,
  TEST_HOST_OVERRIDE_ENV,
} from '@/lib/testing/local-db-guard';
import { hasIllegalHostChars, resolveEffectiveHost } from '@/lib/db/connection-host';

describe('local-db-guard: isLocalDatabaseHost', () => {
  it('accepts loopback / local hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '127.0.0.5', '0.0.0.0', '::1', '[::1]', 'db.localhost', '']) {
      expect(isLocalDatabaseHost(h)).toBe(true);
    }
    expect(isLocalDatabaseHost(null)).toBe(true);
    expect(isLocalDatabaseHost(undefined)).toBe(true);
    expect(isLocalDatabaseHost('/var/run/postgresql')).toBe(true); // unix socket path
  });

  it('rejects remote / real database hosts', () => {
    for (const h of [
      'db.abcdefgh.supabase.co',
      'aws-0-us-west-1.pooler.supabase.com',
      'my-instance.rds.amazonaws.com',
      '10.0.0.5',
      '192.168.1.20',
      'example.org',
    ]) {
      expect(isLocalDatabaseHost(h)).toBe(false);
    }
  });
});

describe('local-db-guard: databaseUrlHost', () => {
  it('extracts host from URL forms, incl. unix sockets, and reports unparseable', () => {
    expect(databaseUrlHost('postgres://postgres:postgres@localhost:5432/kids_fun_ci')).toBe('localhost');
    expect(databaseUrlHost('postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres')).toBe(
      'db.abcdefgh.supabase.co'
    );
    expect(databaseUrlHost('postgres://u:p@[::1]:5432/db')).toBe('[::1]');
    expect(databaseUrlHost('postgres:///db?host=/var/run/postgresql')).toBe('/var/run/postgresql');
    expect(databaseUrlHost('not a url at all')).toBeNull();
  });

  // Round 27 F1 regression: node-postgres treats a `?host=` query param as an OVERRIDE of the
  // URL hostname (pg/lib/connection-parameters.js → pg-connection-string parse().host), in BOTH
  // directions. The old implementation read `new URL(url).hostname` first and only fell back to
  // `?host=` when the hostname was empty, so a remote-via-?host= URL reported as local and slipped
  // past the guard. These assert the host we report equals the host pg will actually connect to.
  it('honours the ?host= override the same way node-postgres does (both directions)', () => {
    // Local-looking hostname, remote ?host= override → we must report the REMOTE host.
    expect(databaseUrlHost('postgres://127.0.0.1/db?host=db.x.supabase.co')).toBe('db.x.supabase.co');
    expect(databaseUrlHost('postgres://127.0.0.1:5432/db?host=db.real.supabase.co')).toBe(
      'db.real.supabase.co'
    );
    // Remote-looking hostname, local ?host= override → we must report the LOCAL host.
    expect(databaseUrlHost('postgres://db.real.supabase.co:5432/db?host=127.0.0.1')).toBe('127.0.0.1');
    // An empty ?host= does NOT override (matches pg) → falls back to the URL hostname.
    expect(databaseUrlHost('postgres://localhost/db?host=')).toBe('localhost');
  });
});

describe('local-db-guard: assertLocalDatabaseUrl', () => {
  const savedOverride = process.env.KIDS_FUN_ALLOW_NONLOCAL_DB;
  afterEach(() => {
    if (savedOverride === undefined) delete process.env.KIDS_FUN_ALLOW_NONLOCAL_DB;
    else process.env.KIDS_FUN_ALLOW_NONLOCAL_DB = savedOverride;
  });

  it('is a no-op when the URL is unset', () => {
    expect(() => assertLocalDatabaseUrl(undefined)).not.toThrow();
    expect(() => assertLocalDatabaseUrl('')).not.toThrow();
  });

  it('allows the CI / local / e2e connection strings', () => {
    delete process.env.KIDS_FUN_ALLOW_NONLOCAL_DB;
    expect(() =>
      assertLocalDatabaseUrl('postgres://postgres:postgres@localhost:5432/kids_fun_ci')
    ).not.toThrow();
    expect(() =>
      assertLocalDatabaseUrl('postgres://authenticated:x@127.0.0.1:54322/postgres', 'USER_DATABASE_URL')
    ).not.toThrow();
  });

  it('throws on a non-local host and names the env var + host', () => {
    delete process.env.KIDS_FUN_ALLOW_NONLOCAL_DB;
    expect(() =>
      assertLocalDatabaseUrl('postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres')
    ).toThrow(/non-local host "db\.abcdefgh\.supabase\.co"/);
    expect(() =>
      assertLocalDatabaseUrl('postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres', 'USER_DATABASE_URL')
    ).toThrow(/USER_DATABASE_URL/);
  });

  it('throws on an unparseable-but-set URL (fails closed)', () => {
    delete process.env.KIDS_FUN_ALLOW_NONLOCAL_DB;
    expect(() => assertLocalDatabaseUrl('::::not-a-url::::')).toThrow(/not a parseable connection URL/);
  });

  // Round 27 F1 regression (QA-specified): a URL whose hostname LOOKS local but whose `?host=`
  // override points at a real database must be REJECTED — that URL genuinely connects to the
  // remote host in practice, so allowing the test to run reopens the approval-bypass accident
  // vector this guard exists to close.
  it('rejects a local-looking URL whose ?host= override targets a real database (QA F1 case)', () => {
    delete process.env.KIDS_FUN_ALLOW_NONLOCAL_DB;
    expect(() => assertLocalDatabaseUrl('postgres://127.0.0.1/db?host=db.x.supabase.co')).toThrow(
      /non-local host "db\.x\.supabase\.co"/
    );
    // Names the env var in the error, same as a plain remote host.
    expect(() =>
      assertLocalDatabaseUrl('postgres://127.0.0.1/db?host=db.x.supabase.co', 'USER_DATABASE_URL')
    ).toThrow(/USER_DATABASE_URL/);
  });

  it('allows a remote-looking URL whose ?host= override points back to local (reverse direction)', () => {
    delete process.env.KIDS_FUN_ALLOW_NONLOCAL_DB;
    // pg would actually connect to 127.0.0.1 here, so this is genuinely local and must be allowed.
    expect(() =>
      assertLocalDatabaseUrl('postgres://db.real.supabase.co:5432/db?host=127.0.0.1')
    ).not.toThrow();
    // A unix-socket override is also local.
    expect(() =>
      assertLocalDatabaseUrl('postgres://db.real.supabase.co:5432/db?host=/var/run/postgresql')
    ).not.toThrow();
  });

  it('honours the KIDS_FUN_ALLOW_NONLOCAL_DB escape hatch', () => {
    process.env.KIDS_FUN_ALLOW_NONLOCAL_DB = '1';
    expect(() =>
      assertLocalDatabaseUrl('postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres')
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-21 PRODUCTION POLLUTION REGRESSION.
//
// What happened: a QA worktree's .env.qa held a production superuser DATABASE_URL and
// KIDS_FUN_ALLOW_NONLOCAL_DB=1 in the SAME file. `set -a; . .env.qa; npm test` ran the whole
// DB lane against production — 56 fixture `source` rows, 604 synthetic analytics events, an
// unscoped `DELETE FROM job_queue`, and 16,561 REAL occurrences flipped to 'stale' by the
// genuine scheduler these suites run on purpose.
//
// The tests below pin the fix at the level the bug actually lived: the SHAPE of the override.
// The first one is the incident itself, and it must fail closed no matter what any env var says.
// ─────────────────────────────────────────────────────────────────────────────
describe('local-db-guard: assertTestDatabaseUrl (test path — no boolean override)', () => {
  const savedBool = process.env.KIDS_FUN_ALLOW_NONLOCAL_DB;
  const savedHost = process.env[TEST_HOST_OVERRIDE_ENV];
  afterEach(() => {
    if (savedBool === undefined) delete process.env.KIDS_FUN_ALLOW_NONLOCAL_DB;
    else process.env.KIDS_FUN_ALLOW_NONLOCAL_DB = savedBool;
    if (savedHost === undefined) delete process.env[TEST_HOST_OVERRIDE_ENV];
    else process.env[TEST_HOST_OVERRIDE_ENV] = savedHost;
  });

  const PROD = 'postgresql://postgres:pw@db.rnqaofjhiqmqaipqpiua.supabase.co:5432/postgres';
  const POOLER =
    'postgresql://kids_fun_user_app.rnqaofjhiqmqaipqpiua:pw@aws-0-ca-central-1.pooler.supabase.com:6543/postgres';

  it('REFUSES the exact 2026-09-21 configuration: prod URL + KIDS_FUN_ALLOW_NONLOCAL_DB=1', () => {
    process.env.KIDS_FUN_ALLOW_NONLOCAL_DB = '1';
    expect(() => assertTestDatabaseUrl(PROD)).toThrow(/REFUSING TO RUN/);
    expect(() => assertTestDatabaseUrl(POOLER, 'USER_DATABASE_URL')).toThrow(/REFUSING TO RUN/);
    // and it names the var it is refusing, so the error is actionable
    expect(() => assertTestDatabaseUrl(POOLER, 'USER_DATABASE_URL')).toThrow(/USER_DATABASE_URL/);
  });

  // ═══ TRAILING-DOT FQDN — found independently by BOTH reviewers, demonstrated live ═══
  // `db.<ref>.supabase.co.` is the DNS-absolute form of the same name; pg dials it identically.
  // Before the shared normaliser it matched neither the managed patterns nor the override's
  // equality check, so one extra character walked straight past a guarantee that says "no env
  // variable can permit this". QA got a real DNS lookup out of it, not a refusal.
  it('refuses the TRAILING-DOT (DNS-absolute) form of a managed host', () => {
    const DOTTED = 'postgresql://postgres:pw@db.rnqaofjhiqmqaipqpiua.supabase.co.:5432/postgres';
    expect(isManagedDatabaseHost('db.rnqaofjhiqmqaipqpiua.supabase.co.')).toBe(true);
    expect(isManagedDatabaseHost('aws-0-ca-central-1.pooler.supabase.com.')).toBe(true);
    expect(() => assertTestDatabaseUrl(DOTTED)).toThrow(/REFUSING TO RUN/);
    // …and no env var rescues it, which is the actual guarantee being defended
    process.env.KIDS_FUN_ALLOW_NONLOCAL_DB = '1';
    process.env[TEST_HOST_OVERRIDE_ENV] = 'db.rnqaofjhiqmqaipqpiua.supabase.co.';
    expect(() => assertTestDatabaseUrl(DOTTED)).toThrow(/REFUSING TO RUN/);
  });

  // ═══ HOMOGLYPH FULL STOPS — the trailing-dot fix was NOT enough ═══
  // `db.<ref>.supabase．co` with U+FF0E (also U+3002 IDEOGRAPHIC FULL STOP and U+FF61 HALFWIDTH
  // IDEOGRAPHIC FULL STOP) is a different STRING from the ASCII form but resolvers map it onto the
  // same HOST — a reviewer demonstrated it end to end. It therefore matched none of the managed
  // patterns and fell through to the OVERRIDABLE branch, defeating the "no env var can permit
  // this" guarantee a second time, by a second route.
  //
  // These exist because the fix was landed with no test at all: a one-line refactor dropping the
  // non-ASCII check would have left every other test green while silently reopening a bypass that
  // had been proven live. That is the failure mode worth spending a test on.
  it.each([
    ['U+FF0E FULLWIDTH FULL STOP', 'db.rnqaofjhiqmqaipqpiua.supabase．co'],
    ['U+3002 IDEOGRAPHIC FULL STOP', 'db.rnqaofjhiqmqaipqpiua.supabase。co'],
    ['U+FF61 HALFWIDTH IDEOGRAPHIC FULL STOP', 'db.rnqaofjhiqmqaipqpiua.supabase｡co'],
  ])('refuses a homoglyph managed host (%s)', (_label, host) => {
    expect(hasIllegalHostChars(host)).toBe(true);
    // never classified local, and never allowed to reach the overridable branch
    expect(isLocalDatabaseHost(host)).toBe(false);
    expect(isManagedDatabaseHost(host)).toBe(true);
    expect(() => assertTestDatabaseUrl(`postgresql://postgres:pw@${host}:5432/postgres`)).toThrow(
      /REFUSING TO RUN/
    );
  });

  it('no env var rescues a homoglyph host — including one that names it exactly', () => {
    const host = 'db.rnqaofjhiqmqaipqpiua.supabase．co';
    process.env.KIDS_FUN_ALLOW_NONLOCAL_DB = '1';
    process.env[TEST_HOST_OVERRIDE_ENV] = host; // the exact-host override must not apply either
    expect(() => assertTestDatabaseUrl(`postgresql://postgres:pw@${host}:5432/postgres`)).toThrow(
      /non-ASCII hostname/
    );
  });

  it('a homoglyph smuggled through ?host= is refused too (same as the ASCII case)', () => {
    // The ?host= parameter is what pg actually dials, so it is the value that must be classified.
    expect(() =>
      assertTestDatabaseUrl('postgres://127.0.0.1/db?host=db.x.supabase．co')
    ).toThrow(/REFUSING TO RUN/);
  });

  // ═══ PINS THE NON-ASCII BRANCH *INSIDE isLocalDatabaseHost* SPECIFICALLY ═══
  // A per-branch mutation matrix showed that branch was load-bearing but UNPINNED: deleting it
  // alone caused zero failures, because every other homoglyph case here fails for a different
  // reason anyway (they match a managed pattern). This one cannot: a Cyrillic 'е' in front of
  // `.localhost` matches no managed pattern at all, so without the non-ASCII check it normalises
  // to something ending in `.localhost` and is classified LOCAL — i.e. silently allowed.
  it('does not classify a homoglyph LOOPBACK host as local (isLocalDatabaseHost branch)', () => {
    const cyrillic = '\u0435vil.localhost'; // U+0435 CYRILLIC SMALL LETTER IE, not ASCII 'e'
    expect(cyrillic).not.toBe('evil.localhost');
    expect(hasIllegalHostChars(cyrillic)).toBe(true);
    expect(isLocalDatabaseHost(cyrillic)).toBe(false); // ← the branch under test
    expect(() => assertTestDatabaseUrl(`postgres://u:p@${cyrillic}:5432/db`)).toThrow(/non-ASCII hostname/);
  });

  it('leaves ordinary ASCII hosts alone (no false positives from the non-ASCII check)', () => {
    delete process.env.KIDS_FUN_ALLOW_NONLOCAL_DB;
    delete process.env[TEST_HOST_OVERRIDE_ENV];
    expect(hasIllegalHostChars('localhost')).toBe(false);
    expect(hasIllegalHostChars('db.abcdefgh.supabase.co')).toBe(false);
    expect(() => assertTestDatabaseUrl('postgres://postgres:p@127.0.0.1:54322/postgres')).not.toThrow();
  });

  it('treats the trailing-dot form as the SAME host on the override path (no smuggling)', () => {
    // A dotted override must not authorise an undotted target or vice versa by accident — they are
    // the same host, so both directions must behave identically.
    process.env[TEST_HOST_OVERRIDE_ENV] = 'disposable-pg.internal';
    expect(() => assertTestDatabaseUrl('postgres://u:p@disposable-pg.internal.:5432/db')).not.toThrow();
    process.env[TEST_HOST_OVERRIDE_ENV] = 'disposable-pg.internal.';
    expect(() => assertTestDatabaseUrl('postgres://u:p@disposable-pg.internal:5432/db')).not.toThrow();
    // a DIFFERENT host is still refused, dotted or not
    expect(() => assertTestDatabaseUrl('postgres://u:p@other.internal.:5432/db')).toThrow(/non-local host/);
  });

  it('treats a trailing-dot loopback form as local', () => {
    expect(isLocalDatabaseHost('localhost.')).toBe(true);
    expect(() => assertTestDatabaseUrl('postgres://postgres:p@localhost.:5432/db')).not.toThrow();
  });

  it('refuses a managed host even when the exact-host override names it (no override at all)', () => {
    process.env[TEST_HOST_OVERRIDE_ENV] = 'db.rnqaofjhiqmqaipqpiua.supabase.co';
    process.env.KIDS_FUN_ALLOW_NONLOCAL_DB = 'true';
    expect(() => assertTestDatabaseUrl(PROD)).toThrow(/NO\s+environment variable that permits this/);
  });

  it('still allows the legitimate local / CI / e2e targets', () => {
    delete process.env.KIDS_FUN_ALLOW_NONLOCAL_DB;
    delete process.env[TEST_HOST_OVERRIDE_ENV];
    for (const u of [
      'postgres://postgres:postgres@localhost:5432/kids_fun_ci',
      'postgres://postgres:postgres@127.0.0.1:54322/postgres',
      'postgres://postgres:postgres@127.0.0.1:54329/postgres',
      'postgres:///db?host=/var/run/postgresql',
      // a remote-LOOKING url whose ?host= override really connects to loopback
      'postgres://db.real.supabase.co:5432/db?host=127.0.0.1',
    ]) {
      expect(() => assertTestDatabaseUrl(u)).not.toThrow();
    }
    expect(() => assertTestDatabaseUrl(undefined)).not.toThrow();
    expect(() => assertTestDatabaseUrl('')).not.toThrow();
  });

  it('refuses an unparseable-but-set URL (fails closed)', () => {
    expect(() => assertTestDatabaseUrl('::::not-a-url::::')).toThrow(/not a parseable connection URL/);
  });

  it('refuses a non-managed remote host by default, and tells you how to name it', () => {
    delete process.env[TEST_HOST_OVERRIDE_ENV];
    expect(() => assertTestDatabaseUrl('postgres://u:p@10.0.0.5:5432/db')).toThrow(
      /non-local host "10\.0\.0\.5"/
    );
    expect(() => assertTestDatabaseUrl('postgres://u:p@10.0.0.5:5432/db')).toThrow(
      /KIDS_FUN_TEST_ALLOW_NONLOCAL_DB_HOST="10\.0\.0\.5"/
    );
  });

  it('allows a non-managed remote host ONLY when the override names it exactly', () => {
    process.env[TEST_HOST_OVERRIDE_ENV] = '10.0.0.5';
    expect(() => assertTestDatabaseUrl('postgres://u:p@10.0.0.5:5432/db')).not.toThrow();
    // case/bracket normalisation
    process.env[TEST_HOST_OVERRIDE_ENV] = 'Disposable-PG.Internal';
    expect(() => assertTestDatabaseUrl('postgres://u:p@disposable-pg.internal:5432/db')).not.toThrow();
  });

  it('a stale override for a DIFFERENT host does not authorise this one (non-sticky)', () => {
    // This is the property a boolean flag cannot have, and the whole point of the redesign.
    process.env[TEST_HOST_OVERRIDE_ENV] = '10.0.0.5';
    expect(() => assertTestDatabaseUrl('postgres://u:p@10.0.0.9:5432/db')).toThrow(/non-local host/);
  });

  it('the override compares the RESOLVED host, so ?host= cannot smuggle a different target', () => {
    process.env[TEST_HOST_OVERRIDE_ENV] = '10.0.0.5';
    // URL hostname is the permitted one, but pg would really connect to 10.0.0.9 → refuse.
    expect(() => assertTestDatabaseUrl('postgres://10.0.0.5/db?host=10.0.0.9')).toThrow(
      /non-local host "10\.0\.0\.9"/
    );
    // …and the reverse: permitted host supplied via ?host= is accepted, because that is what connects.
    expect(() => assertTestDatabaseUrl('postgres://10.0.0.9/db?host=10.0.0.5')).not.toThrow();
  });
});

describe('connection-host: isManagedDatabaseHost', () => {
  it('flags hosted Postgres endpoints', () => {
    for (const h of [
      'db.rnqaofjhiqmqaipqpiua.supabase.co',
      'aws-0-ca-central-1.pooler.supabase.com',
      'my-instance.rds.amazonaws.com',
      'ep-cool-db-123.neon.tech',
      'pg.fly.dev',
    ]) {
      expect(isManagedDatabaseHost(h)).toBe(true);
    }
  });

  it('does not flag local hosts, unix sockets, private IPs or empty/null', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', 'db.localhost', '', '/var/run/postgresql', '10.0.0.5']) {
      expect(isManagedDatabaseHost(h)).toBe(false);
    }
    expect(isManagedDatabaseHost(null)).toBe(false);
    expect(isManagedDatabaseHost(undefined)).toBe(false);
  });

  it('respects a ?host= override that lands on loopback (not managed in practice)', () => {
    // resolveConnectionHost is what the guard feeds in; assert the pairing behaves.
    expect(isManagedDatabaseHost(databaseUrlHost('postgres://db.x.supabase.co/db?host=127.0.0.1'))).toBe(
      false
    );
    expect(isManagedDatabaseHost(databaseUrlHost('postgres://127.0.0.1/db?host=db.x.supabase.co'))).toBe(
      true
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PGHOST — the bypass that defeated ALL THREE guard layers at once.
//
// `postgres:///dbname` names no host. The old guard asked the PARSER, got an empty string, and
// concluded "unix socket, therefore local, therefore allowed". But pg does not ask the parser —
// pg/lib/connection-parameters.js resolves `config.host || process.env.PGHOST || 'localhost'`, so
// with PGHOST pointed at a hosted database that URL connects straight to it. A reviewer ran the
// real exported functions and watched the guard not only allow it but PROVISION THE MARKER inside
// the remote database, which would have made that host permanently self-vouching for the
// exact-host override too — the guard poisoning its own last check.
//
// Parity with a parser is not parity with a connection.
// ─────────────────────────────────────────────────────────────────────────────
describe('local-db-guard: PGHOST resolution (parser parity is not connection parity)', () => {
  const saved = process.env.PGHOST;
  afterEach(() => {
    if (saved === undefined) delete process.env.PGHOST;
    else process.env.PGHOST = saved;
  });

  // F11: the check was "is it non-ASCII", written for homoglyphs. NUL/TAB/CR/LF/the other C0
  // controls and SPACE are all INSIDE \x00-\x7F, so they read as ordinary ASCII and survived into
  // the hostname, breaking the suffix match exactly the way a homoglyph does.
  it.each([
    ['NUL', '\u0000'], ['TAB', '\t'], ['CR', '\r'], ['LF', '\n'], ['US', '\u001f'], ['SPACE', ' '],
  ])('refuses a host carrying a %s control character', (_name, ch) => {
    const host = `db.abcdefgh.supabase.co${ch}.evil.example`;
    expect(hasIllegalHostChars(host)).toBe(true);
    expect(isLocalDatabaseHost(host)).toBe(false);   // never classified local
    expect(isManagedDatabaseHost(host)).toBe(true);  // refused absolutely
  });

  it('still accepts every character a real host legitimately uses (positive control)', () => {
    for (const ok of ['localhost', 'db.abcdefgh.supabase.co', '127.0.0.1', '::1', '[::1]',
                      'my-host_1.example.com', '/var/run/postgresql', 'host:5432']) {
      expect(hasIllegalHostChars(ok), ok).toBe(false);
    }
  });

  it('treats the IPv4-mapped IPv6 loopback as local, in the form URL parsing actually produces', () => {
    // '::ffff:127.0.0.1' was in LOOPBACK_HOSTS and could never match: WHATWG URL normalises it to
    // '::ffff:7f00:1'. Dead code that looked like coverage.
    expect(isLocalDatabaseHost('::ffff:7f00:1')).toBe(true);
    expect(isLocalDatabaseHost('::ffff:7f00:2')).toBe(true);   // 127.0.0.2 mapped — only the regex can see this
    expect(isLocalDatabaseHost('[::ffff:7f00:1]')).toBe(true);
    expect(resolveEffectiveHost('postgres://u@[::ffff:127.0.0.1]:5432/db').host).toBe('[::ffff:7f00:1]');
    expect(isLocalDatabaseHost('::ffff:8efa:1')).toBe(false); // 142.250.x.x mapped — NOT loopback
  });

  it('reports UNPARSEABLE distinctly from absent — they are different answers', () => {
    // Both return host:null, so a caller checking only `host` behaves identically and a mutation
    // reverting this to source:'url' survives in _ssl.ts. Pinned HERE, at the source, because the
    // distinction is what stops the next caller repeating the F1 bug: it destructured `host`
    // alone, fed null to isLocalDatabaseHost (true for null, legitimately), and routed a malformed
    // connection string to the no-TLS branch.
    expect(resolveEffectiveHost('::::not-a-url::::')).toEqual({ host: null, source: 'unparseable' });
    expect(resolveEffectiveHost('not a url at all')).toEqual({ host: null, source: 'unparseable' });
    // …and a genuinely hostless-but-VALID url is 'default', not 'unparseable'
    delete process.env.PGHOST;
    expect(resolveEffectiveHost('postgres:///db')).toEqual({ host: 'localhost', source: 'default' });
  });

  it('resolves the host the way pg actually does', () => {
    process.env.PGHOST = 'db.x.supabase.co';
    expect(resolveEffectiveHost('postgres:///db')).toEqual({ host: 'db.x.supabase.co', source: 'PGHOST' });
    // an explicit host in the URL still wins, exactly as `config.host ||` does
    expect(resolveEffectiveHost('postgres://u@127.0.0.1:5432/db')).toEqual({ host: '127.0.0.1', source: 'url' });
    delete process.env.PGHOST;
    expect(resolveEffectiveHost('postgres:///db')).toEqual({ host: 'localhost', source: 'default' });
  });

  it('REFUSES a hostless URL when PGHOST points somewhere remote, and says so', () => {
    process.env.PGHOST = 'db.rnqaofjhiqmqaipqpiua.supabase.co';
    // The error must name PGHOST — otherwise it reads as nonsense to someone whose URL plainly
    // contains no supabase host at all.
    expect(() => assertTestDatabaseUrl('postgres:///postgres')).toThrow(/PGHOST="db\.rnqaofjhiqmqaipqpiua\.supabase\.co"/);
  });

  it('REFUSES a hostless URL with no PGHOST rather than assuming local', () => {
    delete process.env.PGHOST;
    // Deliberately stricter than pg: a destructive lane must not take its target from ambient
    // defaults, even though pg itself would happily use localhost.
    expect(() => assertTestDatabaseUrl('postgres:///postgres')).toThrow(/names no host/);
  });

  it('still allows a hostless URL when PGHOST is loopback (no false refusal)', () => {
    process.env.PGHOST = '127.0.0.1';
    expect(() => assertTestDatabaseUrl('postgres:///postgres')).not.toThrow();
  });

  it('an explicit ?host= socket path is not ambient and still works', () => {
    process.env.PGHOST = 'db.evil.supabase.co';
    expect(() => assertTestDatabaseUrl('postgres:///db?host=/var/run/postgresql')).not.toThrow();
  });
});
