// tests/search/search-cap-probe-tls.test.ts — the probe's TLS decision, asserted against pg's OWN
// resolution rather than against the object this repo hands it.
//
// The defect these tests exist for was invisible from the call site and looked correct in review:
// `new Pool({ connectionString, ssl })` reads as "this string, with this TLS", but pg does
// `config = Object.assign({}, config, parse(config.connectionString))`
// (pg/lib/connection-parameters.js), so for ANY url carrying `sslmode=` the parsed string wins and
// the sibling `ssl` is dropped on the floor. Concretely: `KF_PROBE_ALLOW_SELF_SIGNED_TLS=1` did
// nothing against `?sslmode=require` while the probe still printed a warning announcing that
// certificate verification was disabled — the operator was told the opposite of what happened.
//
// So these tests do not inspect `buildPoolConfig`'s return value alone; that is the object that
// used to be discarded. They build pg's real `ConnectionParameters` (constructing a `Client` does
// that and opens nothing) and read the ssl pg would ACTUALLY connect with.

import { afterEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildPoolConfig } from '../../scripts/search-cap-probe';

const NO_SSLMODE = 'postgres://u:p@db.example.com:5432/kf';
const WITH_SSLMODE = 'postgres://u:p@db.example.com:5432/kf?sslmode=require';

/** What pg would connect with, taken from pg's own parameter resolution. No socket is opened. */
function effectiveSsl(config: object): unknown {
  return (new Client(config) as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
}

afterEach(() => {
  delete process.env.KF_PROBE_ALLOW_SELF_SIGNED_TLS;
});

describe('search-cap probe TLS', () => {
  it('applies the self-signed bypass even when the url carries sslmode (the reported defect)', () => {
    process.env.KF_PROBE_ALLOW_SELF_SIGNED_TLS = '1';

    expect(effectiveSsl(buildPoolConfig(WITH_SSLMODE))).toEqual({ rejectUnauthorized: false });
    expect(effectiveSsl(buildPoolConfig(NO_SSLMODE))).toEqual({ rejectUnauthorized: false });
  });

  it('is the fix, not a coincidence: the old connectionString+ssl shape really does lose the bypass', () => {
    // Pinning the pg behaviour the fix is built on. If a future pg stops discarding the caller's
    // `ssl`, this fails and `buildPoolConfig` can be simplified — deliberately, not by accident.
    expect(effectiveSsl({ connectionString: WITH_SSLMODE, ssl: { rejectUnauthorized: false } })).toEqual({});
    expect(effectiveSsl({ connectionString: NO_SSLMODE, ssl: { rejectUnauthorized: false } })).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('leaves TLS exactly as the connection string asked when the bypass is off', () => {
    // No sslmode → no TLS (what a local probe needs). sslmode=require → pg's own handling, which
    // in the installed pg 8.22.0 is an alias for verify-full. Nothing here re-interprets sslmode.
    expect(effectiveSsl(buildPoolConfig(NO_SSLMODE))).toBe(false);
    expect(effectiveSsl(buildPoolConfig(WITH_SSLMODE))).toEqual({});
  });

  it('keeps the single connection the read-only guard depends on, and the rest of the string', () => {
    // `SET default_transaction_read_only` without LOCAL is per-connection, so max: 1 is what makes
    // the guard cover every statement the probe issues. Parsing must not lose the target either.
    const config = buildPoolConfig(WITH_SSLMODE);
    expect(config.max).toBe(1);

    const params = (new Client(config) as unknown as {
      connectionParameters: { host: string; port: number; database: string; user: string };
    }).connectionParameters;
    expect(params.host).toBe('db.example.com');
    expect(params.port).toBe(5432);
    expect(params.database).toBe('kf');
    expect(params.user).toBe('u');
  });
});
