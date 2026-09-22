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
 * Connection-string-bearing keys a run can actually pick up. KF_CLEANUP_TARGET_URL is included
 * because the incident-remediation scripts read it and it legitimately points at production — the
 * point is that it must never be PARKED IN A FILE where `set -a; . file` can arm it silently.
 */
const DB_KEYS = ['DATABASE_URL', 'USER_DATABASE_URL', 'KF_CLEANUP_TARGET_URL', 'KF_RESTORE_CLONE_URL'];

/** Guard-defeating switches that must never be shipped pre-set in a file. */
const OPT_OUT_KEYS = ['KIDS_FUN_ALLOW_NONLOCAL_DB', 'KIDS_FUN_TEST_ALLOW_NONLOCAL_DB_HOST'];

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
    for (const key of DB_KEYS) {
      const value = env.get(key);
      if (!value) continue;
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
