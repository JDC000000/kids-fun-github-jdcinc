// scripts/incident/dedup-followup/_harness.ts — shared plumbing for the two 2026-09-21 dedup
// follow-up fixes. Same safety model as scripts/incident/cleanup-2026-09-21-fixture-pollution.ts,
// factored out because two one-off scripts repeating sixty lines of transaction/flag/backup
// handling is two places for that handling to be subtly different — and "subtly different" is
// exactly the property you do not want in the thing standing between a typo and production.
//
// WHAT EVERY SCRIPT BUILT ON THIS GETS, WITHOUT HAVING TO REMEMBER TO ASK FOR IT:
//   • KF_CLEANUP_TARGET_URL, never DATABASE_URL — a remediation tool must not be reachable by the
//     environment that caused the incident, and must stay invisible to `npm test` / dev / CI.
//   • DRY RUN BY DEFAULT: the work really executes inside a transaction and is then ROLLED BACK,
//     so the printed numbers are a result, not a prediction. Committing needs BOTH --commit and
//     --yes-write-production; one flag is one arrow-up in shell history away from an accident.
//   • A JSON BACKUP OF EVERY ROW IT IS ABOUT TO REMOVE, written before the delete, containing
//     ready-to-run restore SQL. Written in dry-run mode too, so the backup can be inspected and
//     the restore path reviewed before anyone commits anything.
//   • Any precondition failure aborts the whole transaction — never a partial application.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
// Relative, not '@/': run under vite-node, which does not load the Vitest alias.
import { isLocalDatabaseHost, resolveConnectionHost } from '../../../lib/db/connection-host';

export class Abort extends Error {}

/** Every precondition routes through here, so a failure always rolls back and reads the same. */
export function require_(cond: boolean, message: string): void {
  if (!cond) throw new Abort(message);
}

export const log = (s = ''): void => void process.stdout.write(`${s}\n`);

export interface Args {
  commit: boolean;
  confirmed: boolean;
  manifestPath: string;
  /** Explicit --backup-dir, if the caller gave one. Resolution happens in backupRunDir(). */
  backupDirOverride: string | null;
}

/**
 * ═══ WHERE BACKUPS GO, AND WHY NOT IN THE REPO ═══
 * These files hold REAL PRODUCTION ROW VALUES, and the first version defaulted them to a
 * gitignored directory INSIDE the shared worktree. That was wrong twice over, and both halves
 * actually bit:
 *
 *   • SHARED: several sessions ran these tools in the same worktree, so everyone's backups landed
 *     in one directory with no ownership marker. I then ran `rm -rf` on it believing it was mine
 *     and destroyed two reviewers' evidence. A path-scoped delete cannot tell whose files it is
 *     deleting — the same mistake, in miniature, as the incident this toolkit exists to clean up.
 *   • GITIGNORED: because they never showed in `git status`, nobody could SEE them accumulating
 *     from multiple writers. The ignore rule made the collision invisible at the same time as the
 *     shared default made it likely.
 *
 * So: OUTSIDE the repo (a stray `git clean` in a shared worktree would otherwise delete the only
 * rollback that exists), and PER RUN, so two runs can never share a directory and no run can ever
 * be handed files it did not write.
 */
export const DEFAULT_BACKUP_ROOT_NAME = 'kf-incident-backups';

/** Absolute paths this process has written, in order. The ONLY thing any cleanup may ever touch. */
const written: string[] = [];
export function writtenBackups(): readonly string[] {
  return written;
}

/**
 * Resolve the per-run backup directory, create it, and prove it is safe to write into.
 *
 * Refuses when: the resolved root is inside the repo · the run directory already holds files this
 * run did not write · commit mode is requested without an explicit destination.
 */
export function backupRunDir(args: Args): string {
  const repoRoot = resolve(process.cwd());
  const explicit = args.backupDirOverride ?? process.env.KF_INCIDENT_BACKUP_ROOT ?? null;

  // A real write must not silently inherit a default location. Choosing where an irreversible
  // operation's only rollback lives is the operator's decision, not a fallback.
  if (args.commit && args.confirmed && !explicit) {
    throw new Abort(
      `refusing to COMMIT without an explicit backup destination. These files are the only ` +
        `rollback for an irreversible delete, so their location must be chosen deliberately: pass ` +
        `--backup-dir <abs path> or set KF_INCIDENT_BACKUP_ROOT. (Dry runs may use the default.)`
    );
  }

  const root = explicit ?? join(repoRoot, '..', DEFAULT_BACKUP_ROOT_NAME);
  const absRoot = isAbsolute(root) ? resolve(root) : resolve(repoRoot, root);

  const rel = relative(repoRoot, absRoot);
  const insideRepo = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  if (insideRepo) {
    throw new Abort(
      `refusing to write backups inside the repository (${absRoot}). They contain real production ` +
        `row values, and a directory in the tree is one concurrent \`git clean\` — or one ` +
        `path-scoped \`rm\` by a session that thinks the directory is its own — away from being ` +
        `the rollback that no longer exists. Choose a path outside the repo.`
    );
  }

  const runId = process.env.KF_BACKUP_RUN_ID ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-pid${process.pid}`;
  const runDir = join(absRoot, runId);
  mkdirSync(runDir, { recursive: true });

  // Per-run by construction, so anything already here was written by someone else.
  const existing = readdirSync(runDir).filter((f) => !written.includes(join(runDir, f)));
  if (existing.length > 0) {
    throw new Abort(
      `refusing to write into ${runDir}: it already contains ${existing.length} file(s) this run ` +
        `did not create (${existing.slice(0, 3).join(', ')}). Another run may be using it — this ` +
        `tool never shares a backup directory, and never deletes a file it did not write.`
    );
  }
  return runDir;
}

export function parseArgs(argv: string[], defaultManifest: string): Args {
  const flags = new Set<string>();
  let manifest = '';
  let backupDir = '';
  // Both `--key value` and `--key=value` are accepted. The `=` form was silently IGNORED by the
  // first version, so `--manifest=path` fell through to the DEFAULT manifest while looking like it
  // had been honoured — a genuine footgun for whoever runs this against production for real.
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    const inlineValue = eq >= 0 ? raw.slice(eq + 1) : null;
    const take = (): string => (inlineValue !== null ? inlineValue : (argv[++i] ?? ''));
    if (key === '--manifest') { manifest = take(); continue; }
    if (key === '--backup-dir') { backupDir = take(); continue; }
    flags.add(key);
  }
  return {
    commit: flags.has('--commit'),
    confirmed: flags.has('--yes-write-production'),
    // Resolved from cwd (the wrapper cds to the repo root); under vite-node argv[1] is the
    // vite-node binary, not this file.
    manifestPath: manifest || join(process.cwd(), defaultManifest),
    backupDirOverride: backupDir || null,
  };
}

/**
 * Write the rows this script is about to delete, plus SQL that puts them back.
 * Returns the path, which the caller prints — a backup nobody can find is not a backup.
 */
/**
 * How the backup's `restore_sql` should put the rows back.
 *  · 'insert' (default) — for scripts that DELETE rows: re-insert them verbatim.
 *  · 'update'           — for scripts that MUTATE rows in place: re-`UPDATE` the named columns,
 *                         keyed by `key`. Emitting INSERTs for a script that updates produces SQL
 *                         that collides on the primary key of rows which never went away — i.e. a
 *                         backup that cannot restore. Caught by a round-trip rehearsal.
 */
export type RestoreMode =
  | { kind: 'insert' }
  | { kind: 'update'; key: string; columns: string[] };

export function writeBackup(
  dir: string,
  name: string,
  table: string,
  rows: Record<string, unknown>[],
  mode: RestoreMode = { kind: 'insert' },
  /**
   * Columns that are jsonb IN THE TABLE and which the caller selected as `col::text`.
   *
   * ═══ WHY THE COLUMN TYPE, AND NOT THE JS RUNTIME TYPE ═══
   * The first version keyed off `typeof v === 'object'`. That is wrong twice over, and a reviewer
   * reproduced it: a jsonb column whose document is a SCALAR (bare string/number/boolean) arrives
   * from node-postgres as a JS primitive, misses the object branch, and is emitted with no
   * ::jsonb cast and no JSON quoting — the restore then fails with `invalid input syntax for type
   * json`. Worse, a jsonb `null` DOCUMENT arrives as JS `null`, indistinguishable from SQL NULL,
   * and would silently restore as SQL NULL with no error at all.
   *
   * Selecting these columns as ::text removes the ambiguity at the source — SQL NULL stays null,
   * the JSON document `null` arrives as the four-character string "null" — and this list tells the
   * writer to re-cast them with ::jsonb. Byte-exactness then holds for every jsonb shape, not just
   * objects.
   */
  jsonbTextColumns: readonly string[] = []
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${name}-${stamp}.json`);
  mkdirSync(dirname(path), { recursive: true });
  const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
  // ═══ WHY THIS IS NOT JUST String(v) ═══
  // Found by a round-trip rehearsal, which is the only way this class of bug ever shows up: the
  // first version stringified every value, so a jsonb column (llm_batch_decision.detail) was
  // written as "[object Object]" and the generated restore SQL failed with `invalid input syntax
  // for type json`. A backup that cannot be restored is not a backup — and it fails at the exact
  // moment you need it. Objects are now emitted as real JSON with an explicit ::jsonb cast; Dates
  // are handled before the object branch because a Date is also typeof 'object'.
  const jsonb = new Set(jsonbTextColumns);
  const q = (t: string): string => `'${t.replace(/'/g, "''")}'`;
  const lit = (v: unknown, col: string): string => {
    if (v === null || v === undefined) return 'NULL'; // genuine SQL NULL
    if (jsonb.has(col)) return `${q(String(v))}::jsonb`; // already ::text — every jsonb shape
    if (v instanceof Date) return q(v.toISOString());
    // Defensive only: a jsonb column the caller forgot to list still round-trips rather than
    // producing invalid SQL.
    if (typeof v === 'object') return `${q(JSON.stringify(v))}::jsonb`;
    return q(String(v));
  };
  const restoreSql =
    mode.kind === 'insert'
      ? rows.map(
          (r) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => lit(r[c], c)).join(', ')});`
        )
      : rows.map(
          (r) =>
            `UPDATE ${table} SET ${mode.columns.map((c) => `${c} = ${lit(r[c], c)}`).join(', ')} ` +
            `WHERE ${mode.key} = ${lit(r[mode.key], mode.key)};`
        );
  written.push(path);
  writeFileSync(
    path,
    JSON.stringify(
      {
        table,
        captured_at: new Date().toISOString(),
        row_count: rows.length,
        restore_mode: mode.kind,
        note:
          mode.kind === 'insert'
            ? 'Backup taken BEFORE deleting these rows. restore_sql re-inserts them verbatim.'
            : `Backup taken BEFORE updating these rows in place. restore_sql re-UPDATEs ${
                (mode as { columns: string[] }).columns.join(', ')
              } back to the values recorded here, keyed by ${(mode as { key: string }).key}.`,
        rows,
        restore_sql: restoreSql,
      },
      null,
      1
    )
  );
  return path;
}

/**
 * Open a transaction against KF_CLEANUP_TARGET_URL, run `body`, then COMMIT only if both flags
 * were given — otherwise ROLLBACK. Any throw rolls back and exits non-zero. The caller never
 * writes BEGIN/COMMIT/ROLLBACK itself, so a script cannot forget one.
 */
export async function runGuarded(
  args: Args,
  body: (c: PoolClient) => Promise<void>
): Promise<void> {
  const url = process.env.KF_CLEANUP_TARGET_URL;
  if (!url) {
    log('KF_CLEANUP_TARGET_URL is not set. Refusing to guess a target database.');
    process.exit(2);
  }
  // Decide SSL with the repo's OWN resolver rather than a substring test. A substring match on
  // "127.0.0.1" is exactly the anti-pattern this whole incident fix exists to remove: it says
  // nothing about the host pg will actually dial (a `?host=` override flips it), and it was how
  // the original Round 27 bug worked. resolveConnectionHost delegates to the same parser pg uses.
  const isLocal = isLocalDatabaseHost(resolveConnectionHost(url));
  const pool = new Pool({ connectionString: url, ssl: isLocal ? undefined : { rejectUnauthorized: true } });
  const c = await pool.connect();
  let committed = false;
  try {
    await c.query('BEGIN');
    log(`\n── target: ${new URL(url).host}  ·  mode: ${args.commit && args.confirmed ? 'COMMIT' : 'DRY RUN (rollback)'} ──\n`);
    await body(c);
    if (args.commit && args.confirmed) {
      await c.query('COMMIT');
      committed = true;
      log('\n★ COMMITTED.');
    } else {
      await c.query('ROLLBACK');
      log('\n● ROLLED BACK — nothing was changed. The counts above are from a real execution.');
      if (args.commit !== args.confirmed) {
        // Exit 3, not 0. A plain dry run succeeding is exit 0; a HALF-confirmation means someone
        // meant to write and did not, and inside a wrapper script an exit 0 there reads as "done".
        log('  (both --commit AND --yes-write-production are required to commit — exiting 3)');
        c.release();
        await pool.end();
        process.exit(3);
      }
    }
  } catch (err) {
    if (!committed) await c.query('ROLLBACK').catch(() => {});
    const msg = err instanceof Abort ? `ABORTED: ${err.message}` : `FAILED: ${(err as Error).message}`;
    log(`\n✖ ${msg}\n  Transaction rolled back; the database is unchanged.`);
    c.release();
    await pool.end();
    process.exit(1);
  }
  c.release();
  await pool.end();
}
