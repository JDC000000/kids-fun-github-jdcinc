// scripts/staging-viewer/mint.ts — mint (or revoke) a browser session for the STAGING read-only
// admin viewer. OPERATOR-REVIEWED TOOL. Run it only via scripts/staging-viewer/mint.sh, under
// credentials-cli so no secret is ever typed, echoed or written anywhere but the session file.
//
// ═══ WHAT IT IS FOR ═══
// Option D of documents/kids-fun/agent-test-admin-login-SCOPE-2026-09-24.md (approved 2026-09-24,
// STAGING ONLY). An agent QA-ing /admin/* on staging needs a session; the admin console accepts
// only a real Supabase session for an active admin_user row. This signs the pre-seeded 'viewer'
// (read-only: no writes; phone numbers, postal codes, children's ages, FSA and correction notes
// redacted in SQL) in with its password — a normal GoTrue password grant — and writes the cookies
// as a Playwright storageState file that agent-browser can load. The app validates that session for
// real on every request; nothing here bypasses or weakens any app auth.
//
// ═══ WHAT IT DOES NOT DO ═══
//   · create users, seed admin_user, or touch any database — provisioning is a separate, written,
//     operator step (see the PR-1 IMPL doc), and must not happen until independent QA passes;
//   · print a token, a password, or the session file's contents;
//   · work against production — see ./guard.ts, which refuses before any network call.
//
// ═══ MODES ═══
//   mint    (default) sign in, verify the user id, write the storageState (0600) to
//           KF_VIEWER_STATE_OUT. The access token lives ~1h; the refresh token until revoked.
//   revoke  sign in, then sign out with scope 'global': every refresh token this user holds is
//           revoked server-side, so every minted session file stops renewing. Run after each QA
//           session, and delete the file. (The immediate kill for the ADMIN side is
//           `UPDATE admin_user SET active = false`, checked on every admin request.)
//
// ═══ INPUTS (environment, injected by credentials-cli — never on the command line) ═══
//   SUPABASE_URL, SUPABASE_ANON_KEY   staging project only (guard.ts)
//   KF_VIEWER_EMAIL, KF_VIEWER_PASSWORD, KF_VIEWER_USER_ID
//   KF_STAGING_BASE_URL               optional; defaults to, and must equal, the staging origin
//   KF_VIEWER_STATE_OUT               mint only: absolute path under a .scratch/ directory
import { existsSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { sessionToStorageState } from '../../lib/testing/test-session';
import {
  assertExpectedUserId,
  assertSessionOutPath,
  assertSignedInAsExpected,
  assertStagingAppOrigin,
  assertStagingSupabaseUrl,
  assertViewerEmail,
  StagingViewerGuardError,
} from './guard';

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'mint';
  if (mode !== 'mint' && mode !== 'revoke') {
    throw new StagingViewerGuardError(`REFUSING: unknown mode "${mode}" (expected mint | revoke).`);
  }

  // ── every refusal runs before any network call ──
  const supabaseUrl = assertStagingSupabaseUrl(process.env.SUPABASE_URL);
  const appOrigin = assertStagingAppOrigin(process.env.KF_STAGING_BASE_URL);
  const email = assertViewerEmail(process.env.KF_VIEWER_EMAIL);
  const expectedUserId = assertExpectedUserId(process.env.KF_VIEWER_USER_ID);
  const outPath = mode === 'mint' ? assertSessionOutPath(process.env.KF_VIEWER_STATE_OUT, existsSync) : null;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const password = process.env.KF_VIEWER_PASSWORD;
  if (!anonKey) throw new StagingViewerGuardError('REFUSING: SUPABASE_ANON_KEY is not set.');
  if (!password) throw new StagingViewerGuardError('REFUSING: KF_VIEWER_PASSWORD is not set.');

  const supabase = createClient(supabaseUrl.origin, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) {
    // The provider's message describes auth state, never a secret.
    throw new Error(`sign-in failed: ${error?.message ?? 'no session returned'}`);
  }
  assertSignedInAsExpected(data.user.id, expectedUserId);

  if (mode === 'revoke') {
    const { error: outErr } = await supabase.auth.signOut({ scope: 'global' });
    if (outErr) throw new Error(`global sign-out failed: ${outErr.message}`);
    console.log(`revoked: every session for user ${expectedUserId} (scope=global).`);
    return;
  }

  const state = await sessionToStorageState(data.session, appOrigin.origin);
  // The app hardens its own auth cookies (lib/db/auth.ts); match that in the file we hand over.
  for (const cookie of state.cookies) {
    cookie.httpOnly = true;
    cookie.secure = true;
  }
  writeFileSync(outPath!, JSON.stringify(state), { mode: 0o600, flag: 'wx' });

  const expiresAt = data.session.expires_at ? new Date(data.session.expires_at * 1000).toISOString() : 'unknown';
  console.log(`minted: user ${expectedUserId} for ${appOrigin.origin}`);
  console.log(`  access token expires ${expiresAt} (refresh token valid until revoked)`);
  console.log(`  storageState written (0600): ${outPath}`);
  console.log('  After the QA session: run this script with "revoke", then delete the file.');
}

main().catch((err: Error) => {
  console.error(err instanceof StagingViewerGuardError ? err.message : `failed: ${err.message}`);
  process.exit(1);
});
