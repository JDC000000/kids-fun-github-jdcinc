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
  },
});
