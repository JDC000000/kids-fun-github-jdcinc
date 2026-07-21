// tests/testing/local-db-guard.test.ts — unit coverage for the Round 27 loopback DB
// safety net (lib/testing/local-db-guard.ts). Pure string logic, no database needed, so
// it runs in every CI lane and proves the guard blocks a remote DB URL while allowing the
// legitimate local ones (CI's localhost, docker 127.0.0.1, the e2e harness, unix sockets).
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLocalDatabaseUrl,
  databaseUrlHost,
  isLocalDatabaseHost,
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

  it('honours the KIDS_FUN_ALLOW_NONLOCAL_DB escape hatch', () => {
    process.env.KIDS_FUN_ALLOW_NONLOCAL_DB = '1';
    expect(() =>
      assertLocalDatabaseUrl('postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres')
    ).not.toThrow();
  });
});
