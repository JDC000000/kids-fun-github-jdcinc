// tests/testing/env-files-no-prod-db.test.ts — the 2026-09-21 incident's PROXIMATE cause was a
// file, not a line of code: a QA worktree's `.env.qa` held a production superuser DATABASE_URL
// and KIDS_FUN_ALLOW_NONLOCAL_DB=1 together, so a single `set -a; . .env.qa; npm test` aimed the
// whole DB lane at production.
//
// lib/testing/local-db-guard.ts now refuses that at RUN time. This test refuses one CLASS of it at
// REVIEW time: if a `.env*` file sitting in THIS repo root ever names a managed/hosted database or
// ships a guard opt-out, CI says so with the file name — before anyone sources it.
//
// ═══ WHAT THIS DOES *NOT* CATCH — stated plainly, because the first version overstated it ═══
// It scans the repo root of the checkout it runs in, and nothing else. The actual 2026-09-21 file
// lived at `.scratch/kf-prod-qa/.env.qa` — the root of a DIFFERENT worktree — which this scan would
// never have seen. So this is a guardrail against the file being re-created HERE, not proof that no
// such file exists anywhere. Broadening it to scan sibling worktrees was considered and rejected:
// the set of paths is unbounded and machine-specific, so it would give false assurance rather than
// coverage. The run-time guard in local-db-guard.ts is the layer that does not care where the file
// lived, and it is the one that actually closes the incident.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isManagedDatabaseHost } from '@/lib/testing/local-db-guard';
import { resolveConnectionHost } from '@/lib/db/connection-host';

const ROOT = join(__dirname, '..', '..');
/**
 * Which keys count as connection-string-bearing.
 *
 * ═══ WHY A SHAPE TEST AND NOT A LIST ═══
 * The first version enumerated four names. An enumerated list is always one step behind whatever
 * script gets written next, and it was already behind: it missed
 * `.env.recovery-clone.DELETE-AFTER-USE` (RECOVERY_CLONE_DATABASE_URL) sitting in this very
 * worktree, while listing KF_RESTORE_CLONE_URL, which nothing produces. A guard that has to be
 * updated to keep working will eventually not be updated.
 *
 * So: match on the shape of the KEY, and — as a second net that does not depend on the key name at
 * all — on the shape of the VALUE. Anything that parses as a postgres connection string gets
 * checked no matter what it is called.
 */
function isDbKey(key: string): boolean {
  // Deliberately NOT a blanket /_URL$/. That over-matched and produced a real false positive a
  // reviewer planted: NEXT_PUBLIC_SUPABASE_URL is the PUBLIC REST/API origin (https://…), not a
  // connection string, and it legitimately appears in .env.example. Flagging it would have trained
  // everyone to ignore this test — the failure mode that kills a guard faster than a missed case.
  //
  // Key shape stays narrow; the value-shape net below is what makes coverage broad, because it
  // keys off `postgres://` rather than off anyone remembering a naming convention.
  return /(^|_)(DATABASE|DB)_URL$/.test(key);
}

/** Value-shape net: a postgres/supabase connection string, whatever the key is named. */
function looksLikeConnectionString(value: string): boolean {
  return /^postgres(ql)?:\/\//i.test(value.trim());
}

/** Guard-defeating switches that must never be shipped pre-set in a file. */
const OPT_OUT_KEYS = ['KIDS_FUN_ALLOW_NONLOCAL_DB', 'KIDS_FUN_TEST_ALLOW_NONLOCAL_DB_HOST'];

/**
 * The scan itself, as a PURE function over file CONTENT.
 *
 * Pulled out so the matching rules can be proven against synthetic fixtures rather than against
 * whatever `.env*` files happen to exist on disk. That mattered immediately: once the temporary
 * clone credential was removed, the repo root held only `.env.example`, and the value-shape net —
 * the half that provides all the breadth — had nothing left to bite on. A guard whose coverage
 * depends on a hazard being present is not covered at all.
 */
export function managedHostsIn(content: string): { key: string; host: string }[] {
  const found: { key: string; host: string }[] = [];
  for (const [key, value] of parseEnv(content)) {
    if (!value) continue;
    if (!isDbKey(key) && !looksLikeConnectionString(value)) continue;
    const host = resolveConnectionHost(value);
    if (isManagedDatabaseHost(host)) found.push({ key, host: host ?? '' });
  }
  return found;
}

/** Opt-out switches present and enabled in file CONTENT. */
export function optOutsIn(content: string): string[] {
  const env = parseEnv(content);
  return OPT_OUT_KEYS.filter((k) => {
    const v = env.get(k);
    return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  });
}

function envFiles(): string[] {
  return readdirSync(ROOT)
    .filter((f) => f.startsWith('.env'))
    .filter((f) => statSync(join(ROOT, f)).isFile());
}

/**
 * Parse `KEY=value` lines, ignoring comments/blanks. Values are used only for host extraction.
 *
 * `export KEY=value` is accepted as well, and that is not cosmetic: `set -a; . file` sources both
 * forms identically, so a file written with `export ` arms exactly the same way. The first version
 * missed it, which meant a verbatim reconstruction of the real incident file passed this test 5/5
 * while the same file without `export ` correctly failed — a blind spot for precisely the artifact
 * this test exists to catch. (Found by the independent re-check.)
 */
function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^["']|["']$/g, ''));
  }
  return out;
}

describe('repo-root .env* files never name a managed/hosted database', () => {
  it('has env files to check (guards against the scan silently finding nothing)', () => {
    // .env.example is committed, so this is never legitimately zero. Without this assertion a
    // broken glob would make every case below vacuously pass.
    expect(envFiles().length).toBeGreaterThan(0);
  });

  it.each(envFiles())('%s — no managed host in a DB connection key', (file) => {
    const env = parseEnv(readFileSync(join(ROOT, file), 'utf8'));
    for (const [key, value] of env) {
      if (!value) continue;
      if (!isDbKey(key) && !looksLikeConnectionString(value)) continue;
      const host = resolveConnectionHost(value);
      expect(
        isManagedDatabaseHost(host),
        `${file} sets ${key} to the managed/hosted host "${host}". A repo-root env file is one ` +
          `\`set -a; . ./${file}\` away from aiming the DB test lane at a real database — that is ` +
          `the 2026-09-21 incident verbatim. Keep production connection strings out of the repo ` +
          `root, in a secret store, under a purpose-built read-only env var — never ${key}.`
      ).toBe(false);
    }
  });

  it.each(envFiles())('%s — ships no guard-defeating opt-out (either form)', (file) => {
    const env = parseEnv(readFileSync(join(ROOT, file), 'utf8'));
    for (const key of OPT_OUT_KEYS) {
      const v = env.get(key);
      expect(
        v === undefined || v === '' || v === '0' || v.toLowerCase() === 'false',
        `${file} pre-sets ${key}=${v}. Sourcing that file arms the opt-out for everything that runs ` +
          `afterwards in the same shell, which is how 2026-09-21 happened. The test path ignores ` +
          `KIDS_FUN_ALLOW_NONLOCAL_DB now, and KIDS_FUN_TEST_ALLOW_NONLOCAL_DB_HOST is deliberately ` +
          `target-named — but neither belongs parked in a file.`
      ).toBe(true);
    }
  });

  it('parses `export KEY=value` the same way `set -a; . file` does', () => {
    const parsed = parseEnv('export DATABASE_URL=postgres://u:p@db.x.supabase.co:5432/d\nexport KIDS_FUN_ALLOW_NONLOCAL_DB=1\n');
    expect(parsed.get('DATABASE_URL')).toBe('postgres://u:p@db.x.supabase.co:5432/d');
    expect(parsed.get('KIDS_FUN_ALLOW_NONLOCAL_DB')).toBe('1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNTHETIC FIXTURES — coverage that does not depend on what is on disk.
//
// Every case below is content, not a file. Before these existed the matching rules were exercised
// only by whichever `.env*` files happened to be present, so with just `.env.example` at the root
// the value-shape net was entirely unproven — it could have been deleted without a single test
// noticing. These pin both halves, in both directions.
// ─────────────────────────────────────────────────────────────────────────────
describe('env scan rules, proven against synthetic content', () => {
  it('catches a managed host under a key nobody enumerated (VALUE-shape net)', () => {
    // The whole point of the value net: an unlisted key still gets checked because the VALUE
    // parses as a postgres connection string.
    const hits = managedHostsIn('SOME_BRAND_NEW_TOOL_TARGET=postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres\n');
    expect(hits).toHaveLength(1);
    expect(hits[0].host).toBe('db.abcdefgh.supabase.co');
  });

  it('catches a managed host under a conventional key (KEY-shape net)', () => {
    expect(managedHostsIn('RECOVERY_CLONE_DATABASE_URL=postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres\n')).toHaveLength(1);
    expect(managedHostsIn('USER_DATABASE_URL=postgresql://u:p@aws-0-ca-central-1.pooler.supabase.com:6543/postgres\n')).toHaveLength(1);
  });

  it('catches the `export ` form, which `set -a; . file` sources identically', () => {
    expect(managedHostsIn('export DATABASE_URL=postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres\n')).toHaveLength(1);
  });

  it('catches the trailing-dot and homoglyph host forms too', () => {
    expect(managedHostsIn('DATABASE_URL=postgresql://u:p@db.abcdefgh.supabase.co.:5432/postgres\n')).toHaveLength(1);
    expect(managedHostsIn('DATABASE_URL=postgresql://u:p@db.abcdefgh.supabase．co:5432/postgres\n')).toHaveLength(1);
  });

  it('does NOT flag the public Supabase API origin (the false positive a reviewer planted)', () => {
    // https://<ref>.supabase.co is the REST/API origin, not a connection string, and it belongs in
    // env files. Flagging it would train everyone to ignore this test.
    expect(managedHostsIn('NEXT_PUBLIC_SUPABASE_URL=https://abcdefghijkl.supabase.co\nSUPABASE_ANON_KEY=fake.anon.key\n')).toHaveLength(0);
  });

  it('does NOT flag local targets, comments, or blank values', () => {
    expect(managedHostsIn('DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres\n')).toHaveLength(0);
    expect(managedHostsIn('# DATABASE_URL=postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres\n')).toHaveLength(0);
    expect(managedHostsIn('DATABASE_URL=\n')).toHaveLength(0);
  });

  it('detects opt-out switches in either form, and only when actually enabled', () => {
    expect(optOutsIn('KIDS_FUN_ALLOW_NONLOCAL_DB=1\n')).toEqual(['KIDS_FUN_ALLOW_NONLOCAL_DB']);
    expect(optOutsIn('export KIDS_FUN_ALLOW_NONLOCAL_DB=true\n')).toEqual(['KIDS_FUN_ALLOW_NONLOCAL_DB']);
    expect(optOutsIn('KIDS_FUN_TEST_ALLOW_NONLOCAL_DB_HOST=db.x.internal\n')).toEqual(['KIDS_FUN_TEST_ALLOW_NONLOCAL_DB_HOST']);
    expect(optOutsIn('KIDS_FUN_ALLOW_NONLOCAL_DB=0\n')).toEqual([]);
    expect(optOutsIn('KIDS_FUN_ALLOW_NONLOCAL_DB=false\n')).toEqual([]);
  });

  it('reproduces the 2026-09-21 incident file verbatim and flags BOTH hazards', () => {
    const incidentFile = [
      'export DATABASE_URL=postgresql://postgres:REDACTED@db.rnqaofjhiqmqaipqpiua.supabase.co:5432/postgres',
      'export USER_DATABASE_URL=postgresql://kids_fun_user_app.rnqaofjhiqmqaipqpiua:REDACTED@aws-0-ca-central-1.pooler.supabase.com:6543/postgres',
      'export KIDS_FUN_ALLOW_NONLOCAL_DB=1',
      '',
    ].join('\n');
    expect(managedHostsIn(incidentFile)).toHaveLength(2);
    expect(optOutsIn(incidentFile)).toEqual(['KIDS_FUN_ALLOW_NONLOCAL_DB']);
  });
});
