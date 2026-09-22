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
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
