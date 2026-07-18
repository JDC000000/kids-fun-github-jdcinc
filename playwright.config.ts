import { defineConfig, devices } from '@playwright/test';

// playwright.config.ts — KIDS FUN E2E harness (Round 14 / Task N, G6).
//
// Drives the REAL Next.js app: unauthenticated flows (/search, /preview, the
// sign-in redirect) and authenticated flows (/account and its saved-search
// section) in both light and dark colour schemes — the gap every prior auth-gated
// QA pass flagged as "unverifiable, no headless browser / auth-mock harness".
//
// Authenticated projects depend on a `setup` project (tests/e2e/auth.setup.ts)
// that mints a REAL session for a dedicated, clearly-flagged test user via the
// service-role admin capability (default-deny env-gated — see lib/testing/*) and
// writes it to storageState. Public projects have no such dependency, so the
// unauthenticated suite runs without any Supabase admin access.
//
// Runtime config is env-driven:
//   E2E_BASE_URL            — app origin (default http://127.0.0.1:3000)
//   E2E_WEBSERVER_COMMAND   — if set, Playwright boots the app with it; otherwise
//                             it expects an already-running server at E2E_BASE_URL.

const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const STORAGE_STATE = 'tests/e2e/.auth/state.json';

export default defineConfig({
  testDir: './tests/e2e',
  // Only *.spec.ts / *.setup.ts here are Playwright tests. Vitest owns *.test.ts;
  // keeping the extensions disjoint is what stops the two runners colliding.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },

  projects: [
    // Provisions the authenticated storageState. Authed projects depend on it.
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },

    // Unauthenticated flows — no Supabase admin access required.
    {
      name: 'public',
      testMatch: /.*\.public\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },

    // Authenticated flows — light scheme.
    {
      name: 'authed',
      testMatch: /.*\.authed\.spec\.ts$/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], colorScheme: 'light', storageState: STORAGE_STATE },
    },

    // Authenticated flows — dark scheme. Same specs, proves dark-mode rendering
    // of auth-gated pages (the specific thing prior QA could not verify).
    {
      name: 'authed-dark',
      testMatch: /.*\.authed\.spec\.ts$/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark', storageState: STORAGE_STATE },
    },
  ],

  webServer: process.env.E2E_WEBSERVER_COMMAND
    ? {
        command: process.env.E2E_WEBSERVER_COMMAND,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      }
    : undefined,
});
