// scripts/staging-viewer/guard.ts — the refusals that run BEFORE the staging viewer mint script
// touches the network. Pure and dependency-free so tests/admin/staging-viewer-guard.test.ts can
// exercise every one of them.
//
// Context: documents/kids-fun/agent-test-admin-login-SCOPE-2026-09-24.md, Option D (STAGING ONLY,
// approved 2026-09-24). An agent QA-ing the admin console gets a real Supabase session for ONE
// operator-seeded, read-only, PII-redacted admin ('viewer') on the STAGING project. This module is
// what makes "staging only" a property of the tool rather than of the person running it:
//   · the Supabase project must be the staging ref, exactly; the production ref is named and refused;
//   · the app origin the cookies are minted for must be the staging deployment, exactly;
//   · the identity must be on the reserved viewer domain, and must be the expected user id;
//   · the session file must land in a .scratch/ directory, must not already exist, and is 0600.

/** Supabase project ref of kids-fun-staging (docs/infra.md). */
export const STAGING_SUPABASE_REF = 'mdusztrunwnniwnpwsmy';
/** Supabase project ref of PRODUCTION. Named so the refusal can say exactly what was attempted. */
export const PRODUCTION_SUPABASE_REF = 'rnqaofjhiqmqaipqpiua';
/** The staging app origin (Vercel project kids-fun-staging). */
export const STAGING_APP_ORIGIN = 'https://kids-fun-staging-jdci-nc.vercel.app';
/** Production origins, named for the same reason. */
export const PRODUCTION_APP_HOSTS = ['kidsfunapp.ca', 'www.kidsfunapp.ca', 'kids-fun-psi.vercel.app', 'kids-fun-jdci-nc.vercel.app'];
/** The viewer identity must be on this reserved (.test, never deliverable) domain. */
export const VIEWER_EMAIL_DOMAIN = 'viewer.kids-fun.test';

export class StagingViewerGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagingViewerGuardError';
  }
}

function refuse(message: string): never {
  throw new StagingViewerGuardError(`REFUSING: ${message}`);
}

function parseUrl(raw: string | undefined, label: string): URL {
  if (!raw) refuse(`${label} is not set.`);
  try {
    return new URL(raw);
  } catch {
    refuse(`${label} is not a valid URL.`);
  }
}

/** The Supabase URL must be https://<staging ref>.supabase.co and nothing else. */
export function assertStagingSupabaseUrl(raw: string | undefined): URL {
  const url = parseUrl(raw, 'SUPABASE_URL');
  if (url.hostname.includes(PRODUCTION_SUPABASE_REF)) {
    refuse('SUPABASE_URL is the PRODUCTION Supabase project. This tool is staging-only, by design and by ruling.');
  }
  if (url.protocol !== 'https:' || url.hostname !== `${STAGING_SUPABASE_REF}.supabase.co` || url.port !== '') {
    refuse(`SUPABASE_URL must be exactly https://${STAGING_SUPABASE_REF}.supabase.co (the staging project).`);
  }
  return url;
}

/** The app origin the cookies are minted for must be the staging deployment. */
export function assertStagingAppOrigin(raw: string | undefined): URL {
  const url = parseUrl(raw ?? STAGING_APP_ORIGIN, 'KF_STAGING_BASE_URL');
  if (PRODUCTION_APP_HOSTS.includes(url.hostname)) {
    refuse(`KF_STAGING_BASE_URL (${url.hostname}) is a PRODUCTION origin. This tool is staging-only.`);
  }
  if (url.origin !== STAGING_APP_ORIGIN) {
    refuse(`KF_STAGING_BASE_URL must be exactly ${STAGING_APP_ORIGIN}.`);
  }
  return url;
}

/** The viewer's email must be on the reserved domain. */
export function assertViewerEmail(raw: string | undefined): string {
  const email = (raw ?? '').trim().toLowerCase();
  if (!email) refuse('KF_VIEWER_EMAIL is not set.');
  const at = email.lastIndexOf('@');
  if (at < 1 || email.slice(at + 1) !== VIEWER_EMAIL_DOMAIN) {
    refuse(`KF_VIEWER_EMAIL must be an address @${VIEWER_EMAIL_DOMAIN} (the reserved viewer domain).`);
  }
  return email;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The expected user id is REQUIRED, so a session can only ever be minted for the seeded viewer. */
export function assertExpectedUserId(raw: string | undefined): string {
  const id = (raw ?? '').trim();
  if (!UUID_RE.test(id)) refuse('KF_VIEWER_USER_ID must be the seeded viewer\'s user id (a UUID).');
  return id.toLowerCase();
}

/** After sign-in: the identity Supabase returned must be the seeded viewer. */
export function assertSignedInAsExpected(actualUserId: string | undefined, expected: string): void {
  if (!actualUserId || actualUserId.toLowerCase() !== expected) {
    refuse('the signed-in user is not KF_VIEWER_USER_ID. The session has NOT been written.');
  }
}

/**
 * The session file (it holds a refresh token) must live under a .scratch/ directory, must not
 * already exist (no silent overwrite of someone else's session) and is written 0600 by the caller.
 */
export function assertSessionOutPath(raw: string | undefined, exists: (p: string) => boolean): string {
  const path = (raw ?? '').trim();
  if (!path) refuse('KF_VIEWER_STATE_OUT is not set.');
  if (!path.startsWith('/')) refuse('KF_VIEWER_STATE_OUT must be an absolute path.');
  if (!/\/\.scratch\//.test(path) || path.includes('/../')) {
    refuse('KF_VIEWER_STATE_OUT must be inside a .scratch/ directory (disposable, never committed).');
  }
  if (!path.endsWith('.json')) refuse('KF_VIEWER_STATE_OUT must end in .json (a Playwright storageState).');
  if (exists(path)) refuse(`${path} already exists. Delete it (or revoke that session) first.`);
  return path;
}
