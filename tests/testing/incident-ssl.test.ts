// tests/testing/incident-ssl.test.ts — coverage for scripts/incident/_ssl.ts.
//
// This module decides whether a PRODUCTION SUPERUSER connection gets certificate verification, and
// until now it had NO test file at all — a reviewer searched the tree and found only the source.
// Zero coverage means every mutation survives trivially: flipping rejectUnauthorized to false,
// deleting any TLS_PARAMS entry, inverting the local/remote fork. None of it would have been
// noticed.
//
// Per the standing rule, this starts with POSITIVE CONTROLS: cases that must SUCCEED, so the file
// cannot pass by refusing everything.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CA_ENV, resolveSslFor, tlsParamsIn } from '../../scripts/incident/_ssl';

const LOCAL = 'postgres://postgres:postgres@127.0.0.1:54322/postgres';
const REMOTE = 'postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres';
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';

function writeCa(contents = PEM): string {
  const p = join(mkdtempSync(join(tmpdir(), 'kf-ca-')), 'ca.crt');
  writeFileSync(p, contents);
  return p;
}

const savedCa = process.env[CA_ENV];
const savedPgHost = process.env.PGHOST;
afterEach(() => {
  if (savedCa === undefined) delete process.env[CA_ENV]; else process.env[CA_ENV] = savedCa;
  if (savedPgHost === undefined) delete process.env.PGHOST; else process.env.PGHOST = savedPgHost;
});

describe('incident _ssl: positive controls (must SUCCEED)', () => {
  it('a clean LOCAL string gets no TLS options', () => {
    delete process.env[CA_ENV];
    const d = resolveSslFor(LOCAL);
    expect(d.ssl).toBeUndefined();
    expect(d.reason).toMatch(/local host/);
  });

  it('a REMOTE string with a valid CA verifies properly', () => {
    process.env[CA_ENV] = writeCa();
    const d = resolveSslFor(REMOTE);
    // Pins BOTH halves: the CA is actually loaded, and verification is ON. A mutation flipping
    // rejectUnauthorized to false — the whole anti-pattern this module exists to remove — fails here.
    expect(d.ssl).toBeDefined();
    expect(d.ssl!.rejectUnauthorized).toBe(true);
    expect(d.ssl!.ca).toContain('BEGIN CERTIFICATE');
    expect(d.reason).toMatch(/verifying against/);
  });
});

describe('incident _ssl: a URL parameter cannot weaken TLS', () => {
  // Each entry of TLS_PARAMS individually — deleting any one from the list fails its own case.
  it.each(['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation', 'uselibpqcompat'])(
    'refuses ?%s on a remote target', (param) => {
      process.env[CA_ENV] = writeCa();
      expect(() => resolveSslFor(`${REMOTE}?${param}=x`)).toThrow(/TLS parameter/);
    }
  );

  it('refuses them on a LOCAL target too (?ssl=false otherwise crashes pg)', () => {
    expect(() => resolveSslFor(`${LOCAL}?ssl=false`)).toThrow(/TLS parameter/);
    expect(() => resolveSslFor(`${LOCAL}?sslmode=disable`)).toThrow(/TLS parameter/);
  });

  it('tlsParamsIn is case-insensitive and clean on a bare string', () => {
    expect(tlsParamsIn(`${REMOTE}?SSLMode=disable`)).toEqual(['sslmode']);
    expect(tlsParamsIn(REMOTE)).toEqual([]);
  });
});

describe('incident _ssl: fails CLOSED on anything it cannot verify', () => {
  it('an UNPARSEABLE connection string is refused, not treated as local', () => {
    // The regression this file was written for: resolveEffectiveHost returned host:null, and
    // isLocalDatabaseHost(null) is true, so a malformed URL took the "no TLS options" branch.
    delete process.env[CA_ENV];
    expect(() => resolveSslFor('::::not-a-url::::')).toThrow(/could not be parsed/);
    const d = (() => { try { return resolveSslFor('::::not-a-url::::'); } catch { return null; } })();
    expect(d).toBeNull(); // never returns a decision
  });

  it('a remote target with NO CA is refused rather than downgraded', () => {
    delete process.env[CA_ENV];
    expect(() => resolveSslFor(REMOTE)).toThrow(/without a CA certificate/);
  });

  it('a CA path that cannot be read is refused', () => {
    process.env[CA_ENV] = '/nonexistent/ca.crt';
    expect(() => resolveSslFor(REMOTE)).toThrow(/could not be read/);
  });

  it('a CA file that is not a PEM is refused', () => {
    process.env[CA_ENV] = writeCa('not a certificate at all');
    expect(() => resolveSslFor(REMOTE)).toThrow(/does not contain a PEM/);
  });

  it('a hostless URL dialed via a remote PGHOST still requires the CA', () => {
    // TLS must be decided on the host pg DIALS, not the one the URL spells.
    process.env.PGHOST = 'db.abcdefgh.supabase.co';
    delete process.env[CA_ENV];
    expect(() => resolveSslFor('postgres:///postgres')).toThrow(/without a CA certificate/);
  });

  it('a hostless URL with a LOOPBACK PGHOST is still local (no false refusal)', () => {
    process.env.PGHOST = '127.0.0.1';
    expect(resolveSslFor('postgres:///postgres').ssl).toBeUndefined();
  });
});
