import { test as setup, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createTestUserSession, sessionToStorageState } from '../../lib/testing/test-session';

// tests/e2e/auth.setup.ts — the `setup` project. Runs ONCE before the authed
// projects and provisions their storageState by minting a REAL session for the
// dedicated, flagged test user (via the service-role admin capability, behind the
// default-deny supabase-guard). No app auth code is bypassed: the app validates
// the injected session for real on every request.
//
// Written as a Playwright "test" (not globalSetup) so it only runs when an authed
// project actually needs it — the public/unauthenticated suite never triggers it.

const STORAGE_STATE = resolve('tests/e2e/.auth/state.json');
const USER_INFO = resolve('tests/e2e/.auth/user.json');

setup('provision authenticated test session', async () => {
  const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';

  // createTestUserSession() runs the safety gate before any privileged call and
  // throws loudly if the Supabase target is not a sanctioned test target.
  const { session, email, user, guard } = await createTestUserSession();
  expect(session.access_token, 'a real access token was issued').toBeTruthy();

  const state = await sessionToStorageState(session, baseURL);
  expect(state.cookies.length, 'session serialized to at least one cookie').toBeGreaterThan(0);

  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  writeFileSync(STORAGE_STATE, JSON.stringify(state, null, 2));
  writeFileSync(USER_INFO, JSON.stringify({ id: user.id, email }, null, 2));

  // Audit line: which sanctioned target we minted against, and for whom.
  // eslint-disable-next-line no-console
  console.log(
    `[e2e] authenticated as ${email} (id ${user.id}); supabase target ${guard.host}` +
      `${guard.port ? ':' + guard.port : ''} accepted as "${guard.reason}"`,
  );
});
