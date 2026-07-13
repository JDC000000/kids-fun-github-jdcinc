import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirror the tsconfig "@/*" path alias so app/ modules resolve under Vitest.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'app/**/*.test.ts', 'evals/**/*.test.ts'],
    environment: 'node',
  },
});
