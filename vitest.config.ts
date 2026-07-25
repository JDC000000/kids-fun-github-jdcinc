import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirror the tsconfig "@/*" path alias so app/ modules resolve under Vitest.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  // Match Next's automatic JSX runtime so the components/ui primitives (.tsx)
  // render under Vitest without importing React.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    // NB: `include` deliberately lives in vitest.workspace.ts, not here. A workspace project
    // that `extends` a config MERGES array options with the parent instead of replacing them,
    // so an `include` here would union with each project's own and every lane would collect
    // the whole suite. The workspace owns file selection; this file owns everything else.
    environment: 'node',
    // Round 27 safety net: refuse to run any test when DATABASE_URL / USER_DATABASE_URL
    // point at a non-local host, so a DB-backed suite can never write throwaway fixtures
    // into a real/staging database by accident (see lib/testing/local-db-guard.ts and the
    // approval-bypass incident it stems from). No-op when the env vars are unset.
    setupFiles: ['./lib/testing/local-db-guard.ts'],
    // ── WHY THIS IS false, AND WHY THAT IS NO LONGER THE WHOLE STORY (H3) ────────────
    // The DB-backed integration suites all talk to ONE shared Postgres. Many of them read
    // a GLOBAL aggregate and assert an exact delta around their own writes (kpi/trends/
    // benchmark "DAU rose by exactly 3"), or mutate rows another file owns (an unscoped
    // `DELETE FROM job_queue`, a `family = 'vvtest'` cascade delete, an unscoped stale-flip
    // UPDATE). Run two of those files at the same time and the neighbour's writes land
    // inside the measurement — flaky. Serial execution is the correct model for them.
    //
    // `fileParallelism: false` here makes that the DEFAULT for any bare `vitest run`, so an
    // ad-hoc local run is always safe. What it is NOT any more is the shape of a full run:
    // it used to serialise all 166 files to protect the 63 that need it, which cost ~2x
    // wall-clock on every CI run. vitest.workspace.ts now splits the suite into two projects
    // — `unit` (no DB at all; safe to parallelise) and `db` (the shared-Postgres suites) —
    // and scripts/test.sh runs the unit lane with `--fileParallelism` while the db lane
    // keeps this default. `fileParallelism` is a vitest NON-project option (it cannot be set
    // per project in a workspace), which is exactly why the split needs two invocations.
    fileParallelism: false,
  },
});
