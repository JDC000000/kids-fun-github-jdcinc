// tests/testing/incident-toolkit-safety.test.ts — standing guards on the incident remediation
// toolkit (scripts/incident/**), written after I did the thing they prevent.
//
// While rehearsing these tools I ran `rm -rf` on their backup directory three times, believing the
// files were mine. They weren't: two reviewer sessions were running the same tools in the same
// worktree, their backups landed in the same directory, and a path-scoped delete cannot tell whose
// files it is removing. That is the incident this toolkit exists to clean up, reproduced in
// miniature by the cleanup toolkit itself.
//
// The fixes were: backups go to a per-run directory OUTSIDE the repo, a run refuses a directory
// holding files it did not write, and nothing here ever deletes by path. The first two are enforced
// at run time in _harness.ts. These tests enforce all of it at REVIEW time, because "we agreed not
// to" is not a control — the agreement was already in place when I broke it.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupRunDir, parseArgs } from '../../scripts/incident/dedup-followup/_harness';
import { resolveSslFor, tlsParamsIn, CA_ENV } from '../../scripts/incident/_ssl';

const TOOLKIT = join(__dirname, '..', '..', 'scripts', 'incident');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'backups') continue; // runtime residue, never source
      out.push(...sourceFiles(full));
    } else if (/\.(ts|sh)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sourceFiles(TOOLKIT);

describe('incident toolkit: no path-scoped deletion, ever', () => {
  it('finds the toolkit sources (guards against a vacuous pass)', () => {
    expect(FILES.length).toBeGreaterThan(6);
  });

  it.each(FILES.map((f) => [f.slice(f.indexOf('scripts/')), f]))(
    '%s contains no recursive or path-scoped delete',
    (_label, full) => {
      const src = readFileSync(full, 'utf8');
      // Comments narrate the incident, so only flag EXECUTABLE occurrences: strip // and # lines
      // and /* */ blocks before matching.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|#)/.test(l))
        .join('\n');
      for (const pattern of [/\brm\s+-[a-z]*r/, /rmSync\s*\([^)]*recursive/, /rimraf/, /rmdirSync/]) {
        expect(
          pattern.test(code),
          `${full} appears to delete by path (${pattern}). This toolkit deletes only the specific ` +
            `file paths it created and recorded this run — a path-scoped delete destroyed another ` +
            `session's backups once already.`
        ).toBe(false);
      }
    }
  );
});

describe('incident toolkit: backups never default inside the repo', () => {
  it('no source hard-codes an in-repo backups path as a destination', () => {
    for (const full of FILES) {
      const src = readFileSync(full, 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
      // A literal like 'scripts/incident/<x>/backups' used as a path would put real production row
      // values back inside the tree, where a stray `git clean` removes the only rollback.
      expect(
        /['"`]scripts\/incident\/[^'"`]*backups/.test(code),
        `${full} hard-codes an in-repo backups directory. Backups hold real production row values ` +
          `and must resolve outside the repository (see backupRunDir()).`
      ).toBe(false);
    }
  });

  it('the harness exposes the run-dir resolver and records what it writes', () => {
    const harness = readFileSync(join(TOOLKIT, 'dedup-followup', '_harness.ts'), 'utf8');
    expect(harness).toContain('export function backupRunDir');
    expect(harness).toContain('export function writtenBackups');
    // the ownership refusal must be present, not merely documented
    expect(harness).toMatch(/did not create/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backups must never resolve INSIDE the repository. These hold real production row values, and a
// directory in the tree is one `git clean` — or one path-scoped `rm` by a session that believes the
// directory is its own — away from being the rollback that no longer exists.
//
// Two escapes were found by review, both reproduced here:
//   · `relative(repo, repo)` is the EMPTY STRING, which the first version read as "outside". So
//     `--backup-dir .` — the most natural thing anyone would type — wrote dumps to the repo root.
//   · resolve() does not follow symlinks, so a link outside the tree pointing back into it passed.
// ─────────────────────────────────────────────────────────────────────────────
describe('incident toolkit: backups cannot resolve inside the repo', () => {
  const REPO = join(__dirname, '..', '..');
  const argsFor = (dir: string) => parseArgs(['--backup-dir', dir], 'unused.json');

  it.each(['.', './', './/', ''])('refuses --backup-dir %j (empty relative path = IS the repo root)', (dir) => {
    const target = dir === '' ? REPO : dir;
    expect(() => backupRunDir(argsFor(target))).toThrow(/inside the repository/);
  });

  it('refuses a subdirectory of the repo', () => {
    expect(() => backupRunDir(argsFor(join(REPO, 'scripts', 'incident')))).toThrow(/inside the repository/);
  });

  it('refuses a symlink that launders a path back into the repo', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kf-backup-symlink-'));
    const link = join(tmp, 'looks-external');
    symlinkSync(join(REPO, 'scripts'), link, 'dir');
    expect(() => backupRunDir(argsFor(link))).toThrow(/inside the repository/);
  });

  it('still accepts a genuinely external directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kf-backup-ok-'));
    expect(() => backupRunDir(argsFor(tmp))).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A URL parameter must not be able to switch off certificate verification.
//
// pg merges the parsed connection string OVER any ssl object supplied in code
// (`Object.assign({}, config, parse(connectionString))`), so a single `?sslmode=` silently discards
// the CA this toolkit enforces. Measured against pg's own ConnectionParameters:
//   (none)             ca=PRESENT rejectUnauthorized=true
//   ?sslmode=no-verify ca=ABSENT  rejectUnauthorized=false
//   ?sslmode=disable   ssl=false  — no TLS at all, production superuser password in cleartext
// It arrives through the same env channel as the boolean flag that caused the incident. A
// guarantee a URL parameter can defeat is not a guarantee.
// ─────────────────────────────────────────────────────────────────────────────
describe('incident toolkit: TLS cannot be weakened from the connection string', () => {
  const savedCa = process.env[CA_ENV];
  const savedPgHost = process.env.PGHOST;
  afterEach(() => {
    if (savedCa === undefined) delete process.env[CA_ENV]; else process.env[CA_ENV] = savedCa;
    if (savedPgHost === undefined) delete process.env.PGHOST; else process.env.PGHOST = savedPgHost;
  });

  it.each(['sslmode=no-verify', 'sslmode=disable', 'sslmode=require', 'sslrootcert=/tmp/x', 'ssl=true'])(
    'refuses a remote connection string carrying %s',
    (param) => {
      expect(() => resolveSslFor(`postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres?${param}`))
        .toThrow(/TLS parameter/);
    }
  );

  it('detects the parameters case-insensitively', () => {
    expect(tlsParamsIn('postgresql://u:p@h.example:5432/db?SSLMode=disable')).toEqual(['sslmode']);
    expect(tlsParamsIn('postgresql://u:p@h.example:5432/db')).toEqual([]);
  });

  it('refuses BEFORE asking for a CA, so the message names the real problem', () => {
    delete process.env[CA_ENV];
    // Without this ordering the operator is told to supply a CA that would then be ignored anyway.
    expect(() => resolveSslFor('postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres?sslmode=disable'))
      .toThrow(/TLS parameter/);
  });

  it('refuses TLS params on LOCAL strings too — ?ssl=false crashes pg with a TypeError', () => {
    // pg-connection-string yields the STRING "false" (truthy), and pg later dies on `'key' in ssl`.
    // Refusing costs nothing locally: the local branch sets no ssl options anyway.
    expect(() => resolveSslFor('postgres://postgres:postgres@127.0.0.1:54322/postgres?ssl=false'))
      .toThrow(/TLS parameter/);
    expect(() => resolveSslFor('postgres://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable'))
      .toThrow(/TLS parameter/);
  });

  it('a clean local string is still accepted', () => {
    expect(resolveSslFor('postgres://postgres:postgres@127.0.0.1:54322/postgres').ssl).toBeUndefined();
  });

  it('decides TLS on the host pg DIALS, so a hostless URL cannot skip it via PGHOST', () => {
    process.env.PGHOST = 'db.abcdefgh.supabase.co';
    delete process.env[CA_ENV];
    // Before the effective-host fix this resolved to ssl:undefined — no TLS to a hosted database.
    expect(() => resolveSslFor('postgres:///postgres')).toThrow(/without a CA certificate/);
  });
});
