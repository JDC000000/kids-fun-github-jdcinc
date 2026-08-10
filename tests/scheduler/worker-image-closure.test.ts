// tests/scheduler/worker-image-closure.test.ts — everything the worker imports is actually
// SHIPPED IN THE IMAGE, and can actually be REQUIRED once it gets there.
//
// WHY THIS EXISTS. worker/ is a separate npm package with its own tsconfig, and the image is
// built from an explicit COPY list in worker/Dockerfile — not from the whole repo. CI's
// "Worker build" step (.github/workflows/ci.yml:86) runs `npm run build` inside a FULL repo
// checkout, so every file is on disk there whether the Dockerfile copies it or not. That
// makes CI structurally blind to the failure this file catches: add an import from worker/
// to a file the Dockerfile does not copy and the repo build stays green while the container
// build breaks — the same blind spot H5 documented in that workflow comment, one level down.
//
// The second failure it catches is subtler and does not break any build at all. `@/*` is a
// BUNDLER alias (root tsconfig `paths`, vitest.config.ts resolve.alias, Next's webpack). tsc
// type-checks it and then emits `require("@/lib/...")` verbatim; under bare node in the
// container that throws MODULE_NOT_FOUND at runtime, not at build time. Nothing else in the
// suite would notice — the worker's build passes and every test resolves the alias fine.
//
// This became load-bearing when worker/core/corrections-retention.ts started importing
// lib/corrections/retention.ts so the worker's retention job and the Vercel route share ONE
// purge implementation and ONE window. Both the shared surface and the alias rule now have
// a tripwire instead of a comment.
//
// Pure static analysis — no database, no build, no container. Unit lane.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const rel = (abs: string): string => relative(ROOT, abs).split(sep).join('/');
const abs = (repoPath: string): string => join(ROOT, repoPath);

/** tsconfig `include` roots — the worker's own compilation units. */
const WORKER_SOURCE_ROOTS = ['worker/src', 'worker/core', 'worker/adapters', 'worker/scheduler', 'worker/health'];

/** Any import/export-from/require/dynamic-import specifier. */
const SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__fixtures__' || entry.name === 'dist') continue;
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Drop whole-line comments before scanning. Necessary, not cosmetic: this repo documents
 * module boundaries in prose, and lib/corrections/retention.ts's header literally quotes
 * `require("@/lib/db/retention-purge")` while explaining why that spelling is forbidden. A
 * scanner that reads comments would fail on the comment that exists to prevent the failure.
 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*\/?|\/\*)/.test(line))
    .join('\n');
}

function specifiersIn(file: string): string[] {
  const src = stripComments(readFileSync(file, 'utf8'));
  const found: string[] = [];
  for (const m of src.matchAll(SPECIFIER_RE)) found.push(m[1] ?? m[2]);
  return found;
}

/** Resolve a relative specifier the way tsc/node do for this project's CommonJS output. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = join(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.d.ts`, `${base}.json`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** npm package name from a bare specifier ('@scope/pkg/sub' → '@scope/pkg'). */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

interface Closure {
  files: Set<string>;
  /** repo-relative importer → the '@/'-prefixed specifier it used. */
  aliased: Array<{ file: string; specifier: string }>;
  bare: Set<string>;
  unresolved: Array<{ file: string; specifier: string }>;
}

/** Every local file the worker's entrypoints can reach, transitively. */
function workerModuleClosure(): Closure {
  const seed = WORKER_SOURCE_ROOTS.flatMap((r) => listTsFiles(abs(r)));
  const files = new Set<string>(seed.map(rel));
  const aliased: Closure['aliased'] = [];
  const bare = new Set<string>();
  const unresolved: Closure['unresolved'] = [];
  const queue = [...seed];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    for (const specifier of specifiersIn(file)) {
      if (specifier.startsWith('@/')) {
        aliased.push({ file: rel(file), specifier });
        continue;
      }
      if (!specifier.startsWith('.')) {
        bare.add(packageName(specifier));
        continue;
      }
      const resolved = resolveRelative(file, specifier);
      if (!resolved) {
        unresolved.push({ file: rel(file), specifier });
        continue;
      }
      if (!files.has(rel(resolved))) {
        files.add(rel(resolved));
        queue.push(resolved);
      }
    }
  }
  return { files, aliased, bare, unresolved };
}

/** Repo-relative source paths the builder stage COPYs (i.e. what the image gets). */
function dockerfileCopySources(): string[] {
  const lines = readFileSync(abs('worker/Dockerfile'), 'utf8').split('\n');
  const sources: string[] = [];
  for (const line of lines) {
    const m = /^\s*COPY\s+(.*)$/.exec(line);
    if (!m || /--from=/.test(m[1])) continue;
    const parts = m[1].trim().split(/\s+/);
    sources.push(...parts.slice(0, -1)); // last token is the destination
  }
  return sources;
}

function dockerCmdEntrypoint(): string {
  const m = /^\s*CMD\s+\[([^\]]*)\]/m.exec(readFileSync(abs('worker/Dockerfile'), 'utf8'));
  const args = (m?.[1] ?? '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
  return args[args.length - 1] ?? '';
}

const closure = workerModuleClosure();
const copySources = dockerfileCopySources();

/** True if `file` sits under one of the Dockerfile's COPY sources. */
function isShipped(file: string): boolean {
  return copySources.some((src) => file === src || file.startsWith(`${posix.normalize(src)}/`));
}

describe('worker image closure — the Dockerfile ships everything the worker imports', () => {
  it('discovers a real module graph (no vacuous pass on a bad walk)', () => {
    const files = [...closure.files];
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain('worker/src/scheduler.ts');
    expect(files).toContain('worker/core/job-handlers.ts');
    // The shared-lib edge this guard exists for.
    expect(files).toContain('lib/corrections/retention.ts');
    expect(files).toContain('lib/db/retention-purge.ts');
  });

  it('every relative import resolves to a file that exists', () => {
    expect(closure.unresolved).toEqual([]);
  });

  it('every file in the closure is COPYed into the image', () => {
    // If this fails, the repo build and the whole test suite stay green while `docker build`
    // fails (or, worse, a require throws at runtime). Fix it by adding the file's directory
    // to worker/Dockerfile's COPY list — deliberately, because that widens the app code the
    // worker image carries — not by deleting this assertion.
    const missing = [...closure.files].filter((f) => !isShipped(f)).sort();
    expect(missing).toEqual([]);
  });

  it('the shared app surface is exactly lib/corrections + lib/db, and no wider', () => {
    // Not a style rule. Every lib/ directory the worker reaches is app code that now has to
    // compile under the worker's Node-only tsconfig and run under bare node in a container.
    // Growing this set is a real architectural decision; it should be a deliberate edit here.
    const libDirs = [...closure.files]
      .filter((f) => f.startsWith('lib/'))
      .map((f) => f.split('/').slice(0, 2).join('/'));
    expect([...new Set(libDirs)].sort()).toEqual(['lib/corrections', 'lib/db']);
  });

  it("no '@/' path alias anywhere in the closure — tsc emits it verbatim and node cannot resolve it", () => {
    // A '@/' import type-checks, builds, and passes every test in this repo, then throws
    // MODULE_NOT_FOUND inside the container. Use a relative specifier in any file the worker
    // compiles. lib/corrections/retention.ts:31 is the one that had to be converted.
    expect(closure.aliased).toEqual([]);
  });

  it('every npm package the closure imports is in the WORKER lockfile, not just the root one', () => {
    // lib/ is app code: it can legitimately import @supabase/ssr or next/headers, neither of
    // which the worker image installs. Catching that here beats catching it in a container
    // build CI never runs.
    const workerLock = readFileSync(abs('worker/package-lock.json'), 'utf8');
    const builtins = new Set(builtinModules);
    const unavailable = [...closure.bare]
      .filter((pkg) => !pkg.startsWith('node:') && !builtins.has(pkg))
      .filter((pkg) => !workerLock.includes(`"node_modules/${pkg}"`))
      .sort();
    expect(unavailable).toEqual([]);
  });

  it('pg-connection-string — a transitive-only dependency the shared lib relies on — is in the worker lockfile', () => {
    // lib/db/connection-host.ts:28 imports it and NEITHER package.json declares it: it comes
    // in as a dependency of `pg` (pg 8.22.0 → pg-connection-string ^2.14.0). The app has
    // always relied on that, and the worker now does too. Declaring it would mean editing a
    // package.json AND regenerating a lockfile, which is not this change's job — but if the
    // resolution ever disappears, the worker breaks at runtime, so it gets an assertion.
    expect(readFileSync(abs('worker/package-lock.json'), 'utf8')).toContain(
      '"node_modules/pg-connection-string"'
    );
  });
});

describe('worker image closure — the build/run paths agree with each other', () => {
  const pkg = JSON.parse(readFileSync(abs('worker/package.json'), 'utf8')) as {
    main: string;
    scripts: Record<string, string>;
  };
  const tsconfig = readFileSync(abs('worker/tsconfig.json'), 'utf8');

  it('tsconfig compiles with rootDir ".." — the reason the emitted paths carry a worker/ segment', () => {
    expect(tsconfig).toMatch(/"rootDir"\s*:\s*"\.\."/);
    expect(tsconfig).toMatch(/"outDir"\s*:\s*"dist"/);
    // A "@/*" alias here would type-check imports that node cannot resolve at runtime.
    expect(tsconfig).not.toMatch(/"paths"/);
  });

  it('package.json entrypoints match what rootDir ".." actually emits', () => {
    // Reverting rootDir without reverting these (or vice versa) yields an image whose CMD
    // points at a file that was never emitted — a crash loop on deploy, not a build error.
    expect(pkg.main).toBe('dist/worker/src/index.js');
    expect(pkg.scripts.start).toBe('node dist/worker/src/index.js');
    expect(pkg.scripts.smoke).toBe('node dist/worker/src/chromium-smoke.js');
    expect(pkg.scripts['ingest:once']).toBe('node dist/worker/src/ingest-once.js');
  });

  it("the Dockerfile's CMD is the same entrypoint package.json declares", () => {
    expect(dockerCmdEntrypoint()).toBe(pkg.main);
  });

  it('the Dockerfile COPYs every tsconfig include root', () => {
    const missing = WORKER_SOURCE_ROOTS.filter((r) => !copySources.includes(r));
    expect(missing).toEqual([]);
  });

  it('.dockerignore does not exclude anything the Dockerfile copies', () => {
    // The build context is the repo root now, so .dockerignore sits between the Dockerfile's
    // COPY list and the files. An over-broad pattern here fails the build confusingly.
    const patterns = readFileSync(abs('.dockerignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('!'));
    const clashes = copySources.filter((src) =>
      patterns.some((p) => src === p || src.startsWith(`${p}/`))
    );
    expect(clashes).toEqual([]);
  });
});
