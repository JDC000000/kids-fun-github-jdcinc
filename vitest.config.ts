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
    include: [
      'tests/**/*.test.{ts,tsx}',
      'app/**/*.test.{ts,tsx}',
      'evals/**/*.test.ts',
      'components/**/*.test.{ts,tsx}',
    ],
    environment: 'node',
    // The DB-gated integration suites (kpi / trends / benchmark / retention / rls…)
    // all read and write the SAME shared analytics_event table and assert on GLOBAL
    // deltas (e.g. "DAU rose by exactly 3"). Under vitest's default file-level
    // parallelism, two such files inserting recent rows race each other and a delta
    // sees the neighbour's writes — flaky. Running test files serially makes these
    // shared-DB assertions deterministic (the correct execution model for
    // integration tests against one database). The suite is small, so the wall-clock
    // cost is negligible. (Added with T32 trends/benchmark, which added the 2nd/3rd
    // concurrent writer of recent analytics_event rows and surfaced the latent race.)
    fileParallelism: false,
  },
});
