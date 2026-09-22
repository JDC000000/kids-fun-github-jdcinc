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
