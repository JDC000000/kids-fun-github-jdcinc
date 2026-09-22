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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { backupRunDir, parseArgs, writeBackup } from '../../scripts/incident/dedup-followup/_harness';
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
// The negative suite's helpers WRITE (UPDATE activity_occurrence, INSERT INTO auth.users) to
// whatever `U` names. Their only protection was the suite's convention of pointing them at a
// replica — a convention, not a control, which is exactly the distinction this whole incident
// turned on. The test tooling should not be the one part exempt from the rule it enforces.
describe('incident toolkit: mutating test helpers refuse a non-loopback target', () => {
  // Every .cjs in negative/ that opens a database connection, not just the ones named helper-*:
  // assert-reset-targets.cjs plants a sentinel row and would have slipped through a name-prefix
  // filter. Shared modules (leading underscore) are excluded — they are the guard, not the caller.
  const helpers = readdirSync(join(TOOLKIT, 'negative')).filter(
    (f) => f.endsWith('.cjs') && !f.startsWith('_')
  );
  const assertLoopback = createRequire(__filename)(
    join(TOOLKIT, 'negative', '_local-only.cjs')
  ).assertLoopback as (u: string | undefined, label?: string) => void;

  it('finds the helpers (guards against a vacuous pass)', () => {
    expect(helpers.length).toBeGreaterThan(0);
  });

  // Review-time, so a helper added LATER cannot quietly skip the guard the way these three did.
  it.each(helpers)('%s calls the guard before connecting', (file) => {
    const src = readFileSync(join(TOOLKIT, 'negative', file), 'utf8');
    expect(src).toContain("require('./_local-only.cjs')");
    expect(src).toMatch(/assertLoopback\(/);
    // Ordering matters as much as presence: a guard that runs after connect() is decoration.
    expect(src.search(/assertLoopback\(/)).toBeLessThan(src.indexOf('c.connect()'));
  });

  // F5: helper-stray-occ.cjs ended in `.catch(() => console.log(''))` — no c.end(), so a failure
  // after a successful connect left the pg socket open and the process hung forever (measured:
  // exit 124). Its two siblings had no handler at all and only exited because Node kills the
  // process on an unhandled rejection. Every path must close the client and fail loudly.
  it.each(helpers)('%s closes its client on every path and exits non-zero on failure', (file) => {
    const src = readFileSync(join(TOOLKIT, 'negative', file), 'utf8');
    expect(src, 'needs try/finally, not a .catch() tail').toMatch(/\bfinally\s*\{/);
    expect(src, 'the finally must actually end the client').toMatch(/finally[\s\S]*c\.end\(\)/);
    expect(src, 'a failure must be visible and non-zero').toMatch(/process\.exit\([1-9]/);
    // The specific shape that caused the hang: swallowing the error and printing an empty line,
    // which the suite then read as a legitimate "nothing found" result.
    expect(src).not.toMatch(/catch\s*\(\s*\)\s*=>\s*\{\s*console\.log\(''\)/);
  });

  // Every other helper requires plain 'pg'. assert-reset-targets.cjs was added with an absolute
  // path into ANOTHER project's node_modules, copied from a tool that lives outside any repo and
  // genuinely needs it. Inside the repo it ties the script to an unrelated checkout's install.
  it.each(helpers)('%s does not require through an absolute node_modules path', (file) => {
    const src = readFileSync(join(TOOLKIT, 'negative', file), 'utf8');
    const requires = [...src.matchAll(/require\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(requires.length, 'guards against a vacuous pass').toBeGreaterThan(0);
    expect(requires.filter((r) => r.includes('node_modules'))).toEqual([]);
  });

  it('accepts loopback in its several spellings (positive control)', () => {
    for (const h of ['127.0.0.1', 'localhost', '[::1]', '127.0.0.53']) {
      expect(() => assertLoopback(`postgresql://u:p@${h}:5432/db`)).not.toThrow();
    }
  });

  it('refuses a managed host, an unset value, and an unparseable one', () => {
    expect(() => assertLoopback('postgresql://u:p@db.abc.supabase.co:5432/postgres')).toThrow(/refusing/);
    expect(() => assertLoopback(undefined)).toThrow(/not set/);
    expect(() => assertLoopback('::::not-a-url::::')).toThrow(/unverifiable/);
  });

  it('is not fooled by a trailing dot or uppercase', () => {
    expect(() => assertLoopback('postgresql://u:p@DB.ABC.SUPABASE.CO./postgres')).toThrow(/refusing/);
  });
});

// ═══ FINDING C (round-5 review): the POST-CREATION realpath re-check was unpinned ═══
// The pre-creation check cannot see through a path whose LEAF does not exist yet: realpathSync
// throws, so the guard falls back to resolve(), which does not follow symlinks. Give it a
// symlinked PARENT and a not-yet-created leaf and the path looks external — then mkdirSync
// follows the link for real and the directory lands inside the repo. Only the re-check AFTER
// creation can see that, and nothing was holding it in place.
//
// Note for the next reader: a fully DANGLING symlink is NOT this case. I wrote that test first and
// it failed with ENOENT — mkdirSync will not create through a link to a nonexistent target, so the
// OS stops it before our guard is consulted. The parent must exist for the hole to open.
describe('incident toolkit: a symlinked parent cannot smuggle backups into the repo', () => {
  const REPO = join(__dirname, '..', '..');
  const created: string[] = [];

  afterEach(() => {
    // Deliberately rmdir (NOT recursive) and only on paths this test created: it fails loudly if
    // anything unexpected is inside rather than removing it. A recursive path-scoped delete is the
    // exact mistake this file exists to prevent, so the cleanup uses the narrowest primitive that
    // can do the job.
    // Deepest first, by path length — reversing the push order got this wrong and tried to
    // remove a parent before its child (ENOTEMPTY). Sorting does not care how they were pushed.
    const deepestFirst = created.splice(0).sort((a, b) => b.length - a.length);
    for (const dir of deepestFirst) if (existsSync(dir)) rmdirSync(dir);
  });

  it('refuses after creation, when realpath can finally follow the link', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kf-backup-parent-'));
    symlinkSync(join(REPO, '.qa-probes'), join(tmp, 'x'), 'dir'); // parent EXISTS, so mkdir follows it
    const target = join(tmp, 'x', `kf-finding-c-${process.pid}`); // leaf does not — pre-check is blind
    const victim = join(REPO, '.qa-probes', `kf-finding-c-${process.pid}`);

    let runDir: string | null = null;
    let message = '';
    try {
      runDir = backupRunDir(parseArgs(['--backup-dir', target], 'unused.json'));
    } catch (err) {
      message = String(err);
    }
    // Both halves stated: it must refuse, and refuse for the RIGHT reason, not an incidental
    // filesystem error that would stop being raised the moment the layout changed.
    expect(runDir).toBeNull();
    expect(message).toMatch(/inside the repository/);

    if (runDir !== null) created.push(runDir);
    for (const leftover of readdirSync(victim)) created.push(join(victim, leftover));
    created.push(victim);
  });
});

// ═══ FINDING D (round-5 review): the jsonb backup fix had ZERO test coverage ═══
// The fix itself came out of a round-trip rehearsal, but nothing pinned it afterwards, so every
// way of reintroducing it survived. A backup that cannot be restored is not a backup, and it
// fails at the exact moment you need it.
describe('incident toolkit: every jsonb shape survives the backup round trip', () => {
  const dirFor = () => mkdtempSync(join(tmpdir(), 'kf-backup-jsonb-'));
  const sqlFor = (rows: Record<string, unknown>[], jsonbCols: string[] = ['detail']): string[] =>
    JSON.parse(readFileSync(writeBackup(dirFor(), 'b', 'llm_batch_decision', rows, { kind: 'insert' }, jsonbCols), 'utf8'))
      .restore_sql;

  // POSITIVE CONTROL — this file must not be able to pass by emitting nothing usable.
  it('emits restorable SQL for an ordinary row, escaping quotes', () => {
    const [sql] = sqlFor([{ id: 1, detail: '{"a":1}', note: "O'Brien" }]);
    expect(sql).toBe(`INSERT INTO llm_batch_decision (id, detail, note) VALUES ('1', '{"a":1}'::jsonb, 'O''Brien');`);
  });

  it('keeps a jsonb SCALAR document as JSON, not as a bare string', () => {
    // Keyed off `typeof v === 'object'`, a jsonb document that is a bare string arrives as a JS
    // primitive, misses the object branch, and restores as `'hi'` — invalid input syntax for json.
    expect(sqlFor([{ id: 1, detail: '"hi"' }])[0]).toContain(`'"hi"'::jsonb`);
    expect(sqlFor([{ id: 1, detail: '42' }])[0]).toContain(`'42'::jsonb`);
    expect(sqlFor([{ id: 1, detail: 'true' }])[0]).toContain(`'true'::jsonb`);
  });

  it('distinguishes the jsonb null DOCUMENT from a SQL NULL', () => {
    // The dangerous one: this pair is indistinguishable if the column is not selected as ::text,
    // and it restores WITHOUT ERROR as the wrong value. Silence is the whole problem.
    expect(sqlFor([{ id: 1, detail: 'null' }])[0]).toContain(`'null'::jsonb`);
    expect(sqlFor([{ id: 1, detail: null }])[0]).toContain('NULL');
    expect(sqlFor([{ id: 1, detail: null }])[0]).not.toContain('::jsonb');
  });

  it('emits a Date as a timestamp literal, not as JSON', () => {
    // A Date is also `typeof 'object'`, so it must be handled BEFORE the object branch or a
    // timestamp restores as '"2026-09-21T00:00:00.000Z"'::jsonb into a timestamptz column. The
    // ordering is deliberate in the source; this is what holds it there. (Added because my
    // mutation pass showed the ordering could be deleted with every test still green.)
    const [sql] = sqlFor([{ id: 1, created_at: new Date('2026-09-21T18:42:11.000Z') }]);
    expect(sql).toContain(`'2026-09-21T18:42:11.000Z'`);
    expect(sql).not.toContain('::jsonb');
  });

  it('casts an unlisted jsonb column defensively rather than emitting [object Object]', () => {
    expect(sqlFor([{ id: 1, detail: { a: 1 } }], [])[0]).toContain(`'{"a":1}'::jsonb`);
  });

  it('writes UPDATEs keyed on the primary key when the script updates in place', () => {
    const path = writeBackup(dirFor(), 'b', 'llm_batch_run', [{ id: 7, watermark: '2026-09-21' }],
      { kind: 'update', key: 'id', columns: ['watermark'] });
    expect(JSON.parse(readFileSync(path, 'utf8')).restore_sql[0])
      .toBe(`UPDATE llm_batch_run SET watermark = '2026-09-21' WHERE id = '7';`);
  });
});

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
