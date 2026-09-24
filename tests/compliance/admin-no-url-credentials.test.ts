// tests/compliance/admin-no-url-credentials.test.ts — the admin console must never again accept a
// credential from a URL or from an ad-hoc request header.
//
// ═══ WHAT HAPPENED ═══
// The admin console used to accept ADMIN_DASHBOARD_TOKEN — a single shared secret — as an
// `x-admin-token` header OR a `?token=` query param. The query form was what people used, so the
// secret sat in browser history, request logs, Referer headers and screenshots for weeks, and it
// unlocked /admin/sms-subscribers: full subscriber phone numbers, postal codes and children's ages.
// The env var was unset on 2026-09-24 as a PII-exposure fix. That made the gate fail closed, but the
// CODE still honoured the token: one re-set env var in a dashboard would have re-opened it, with no
// diff and no review. The code is now gone (app/admin/_lib/gate.ts). This file is what keeps it gone.
//
// ═══ HOW ═══
//   (A) Structural — every shipped source file under app/, lib/, components/ and the root config
//       files is read from disk, comments are stripped (so the history written in comments cannot
//       trip it, and — more importantly — cannot MASK real code), and the code is scanned for the
//       token plumbing: the env var name, the header name, reads of a `token` query param on any
//       admin route, `token=` baked into an admin URL, and the deleted lib/admin/access module. The
//       admin sign-in routes may read exactly two query params, `code` and `next`.
//   (B) Behavioural — with ADMIN_DASHBOARD_TOKEN SET in the environment (the dangerous state), every
//       admin page is invoked with `?token=<the value>` and an `x-admin-token: <the value>` header
//       and no session, and must 404. The session-admin cache-bust API must 401 the same request.
//   (C) Tripwire self-check — the scanner is fed synthetic snippets of each banned shape and must
//       flag every one, so a scanner that silently stopped matching cannot pass as "clean".
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ROOT = process.cwd();
const LEGACY_ENV = 'ADMIN_DASHBOARD_TOKEN';
const LEGACY_HEADER = 'x-admin-token';
const SECRET = 'legacy-token-value-that-must-open-nothing';

// ─────────────────────────────────────────────────────────────────────────────
// (A) Structural scan
// ─────────────────────────────────────────────────────────────────────────────

const SCANNED_DIRS = ['app', 'lib', 'components'];
const SCANNED_ROOT_FILES = [
  'middleware.ts',
  'next.config.mjs',
  'instrumentation.ts',
  'instrumentation-client.ts',
  'sentry.server.config.ts',
  'sentry.edge.config.ts',
  'sentry.scrub.ts',
];
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
/** The Sentry scrubber is the one place the header name must appear: in its strip-list. */
const HEADER_NAME_ALLOWED_IN = new Set(['sentry.scrub.ts']);

function walk(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const rel = join(dir, entry);
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) out.push(...walk(rel));
    else if (SOURCE_EXT.test(entry) && !/\.(test|spec)\.[jt]sx?$/.test(entry)) out.push(rel);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Posix-style relative path, so the route checks below read the same on every OS. */
function posix(rel: string): string {
  return rel.split(sep).join('/');
}

function isAdminRoute(rel: string): boolean {
  return rel.startsWith('app/admin/') || rel.startsWith('app/api/admin/');
}

interface Violation {
  file: string;
  rule: string;
}

/** The scanner. Exported shape is local to this file; (C) drives it with synthetic input. */
function scanSource(file: string, rawSource: string): Violation[] {
  const code = stripComments(rawSource);
  const found: Violation[] = [];
  const flag = (rule: string) => found.push({ file, rule });

  if (code.includes(LEGACY_ENV)) flag('references the ADMIN_DASHBOARD_TOKEN env var');
  if (code.toLowerCase().includes(LEGACY_HEADER) && !HEADER_NAME_ALLOWED_IN.has(file)) {
    flag('references the x-admin-token header');
  }
  if (/ADMIN_TOKEN_(QUERY_PARAM|HEADER)\b/.test(code)) flag('uses the legacy ADMIN_TOKEN_* constants');
  if (/['"`]@\/lib\/admin\/access['"`]|lib\/admin\/access['"`]/.test(code)) {
    flag('imports the deleted lib/admin/access module');
  }

  if (isAdminRoute(file)) {
    if (
      /searchParams\s*\??\.\s*token\b/.test(code) ||
      /searchParams\s*\??\.?\s*\[\s*['"`]token['"`]\s*\]/.test(code) ||
      /\.get\(\s*['"`]token['"`]\s*\)/.test(code)
    ) {
      flag('reads a `token` query param on an admin route');
    }
    if (/[?&]token=/.test(code)) flag('builds an admin URL carrying token=');
    if (/queryToken|headerToken/.test(code)) flag('passes token plumbing to the gate');
  }

  if (file.startsWith('app/admin/auth/')) {
    for (const m of code.matchAll(/searchParams\.get\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) {
      if (m[1] !== 'code' && m[1] !== 'next') flag(`admin sign-in reads query param "${m[1]}"`);
    }
  }

  if (file === 'app/admin/_lib/gate.ts') {
    const iface = code.match(/interface\s+AdminGateRequest\s*\{([\s\S]*?)\}/);
    if (!iface) flag('AdminGateRequest interface not found (the gate contract moved — update this test)');
    else if (/token|header|query|search|secret/i.test(iface[1])) {
      flag('AdminGateRequest carries a request-derived credential field');
    }
  }
  return found;
}

describe('(A) structural: no credential plumbing into the admin console', () => {
  const files = [
    ...SCANNED_DIRS.flatMap(walk),
    ...SCANNED_ROOT_FILES.filter((f) => existsSync(join(ROOT, f))),
  ].map(posix);

  it('actually scans the admin surfaces (a scanner that reads nothing proves nothing)', () => {
    expect(files).toContain('app/admin/_lib/gate.ts');
    expect(files).toContain('app/admin/sms-subscribers/page.tsx');
    expect(files).toContain('app/api/admin/catalogue-cache/bust/route.ts');
    expect(files).toContain('sentry.scrub.ts');
    expect(files.length).toBeGreaterThan(100);
  });

  it('🔴 the legacy token module is deleted', () => {
    expect(existsSync(join(ROOT, 'lib/admin/access.ts'))).toBe(false);
  });

  it('🔴 no shipped file carries the token plumbing', () => {
    const violations = files.flatMap((f) => scanSource(f, readFileSync(join(ROOT, f), 'utf8')));
    expect(violations).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) Behavioural: the token opens nothing even when it is configured
// ─────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  getRequestUser: vi.fn(async () => null),
  dbTouched: vi.fn(),
}));

// No session: the only identity the gate accepts is absent.
vi.mock('@/lib/db/session-user', () => ({ getRequestUser: mocks.getRequestUser }));
// A request that carries the legacy header, on every surface that reads headers.
vi.mock('next/headers', () => ({
  headers: () => new Headers({ [LEGACY_HEADER]: SECRET, referer: `https://example.test/?token=${SECRET}` }),
  cookies: () => ({ get: () => undefined, getAll: () => [], set: () => undefined }),
}));
// Nothing may reach the database before the gate refuses. (The gate itself does not need it for
// an anonymous request — getRequestUser resolves null first.)
vi.mock('@/lib/db/client', () => {
  const touch = () => {
    mocks.dbTouched();
    throw new Error('the database was reached before the admin gate refused the request');
  };
  return { query: touch, getPool: touch, closePool: async () => undefined };
});

function adminPages(): string[] {
  return walk('app/admin')
    .map(posix)
    .filter((f) => f.endsWith('/page.tsx'));
}

describe('(B) behavioural: ADMIN_DASHBOARD_TOKEN set, ?token= and x-admin-token presented → 404', () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env[LEGACY_ENV];
    process.env[LEGACY_ENV] = SECRET;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env[LEGACY_ENV];
    else process.env[LEGACY_ENV] = saved;
  });

  it('finds all 12 admin pages', () => {
    expect(adminPages()).toHaveLength(12);
  });

  for (const file of adminPages()) {
    it(`🔴 ${file} 404s`, async () => {
      const mod = (await import(/* @vite-ignore */ join(ROOT, file))) as {
        default: (props: unknown) => Promise<unknown>;
      };
      const props = {
        params: { id: '00000000-0000-4000-8000-000000000000' },
        searchParams: { token: SECRET, view: 'day', preview: '1' },
      };
      await expect(mod.default(props)).rejects.toThrow(/NEXT_NOT_FOUND/);
      expect(mocks.dbTouched).not.toHaveBeenCalled();
    });
  }

  it('🔴 POST /api/admin/catalogue-cache/bust with the legacy header and no session → 401', async () => {
    const { POST } = await import('@/app/api/admin/catalogue-cache/bust/route');
    const res = await POST(
      new Request(`http://localhost/api/admin/catalogue-cache/bust?token=${SECRET}`, {
        method: 'POST',
        headers: { [LEGACY_HEADER]: SECRET },
      })
    );
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (C) Tripwire self-check: every banned shape is caught
// ─────────────────────────────────────────────────────────────────────────────

describe('(C) tripwire self-check', () => {
  const cases: Array<[string, string, string]> = [
    ['lib/x.ts', `const t = process.env.ADMIN_DASHBOARD_TOKEN;`, 'env var'],
    ['lib/x.ts', `const t = process.env['ADMIN_DASHBOARD' + '_TOKEN'] ?? env.ADMIN_DASHBOARD_TOKEN;`, 'env var'],
    ['app/admin/x/page.tsx', `headers().get('x-admin-token')`, 'header'],
    ['app/admin/x/page.tsx', `headers().get('X-Admin-Token')`, 'header (case-insensitive)'],
    ['app/admin/x/page.tsx', `const q = searchParams.token;`, 'query read (dot)'],
    ['app/admin/x/page.tsx', `const q = searchParams?.token;`, 'query read (optional chain)'],
    ['app/admin/x/page.tsx', `const q = searchParams['token'];`, 'query read (index)'],
    ['app/api/admin/x/route.ts', `new URL(r.url).searchParams.get("token")`, 'query read (get)'],
    ['app/admin/x/_lib/href.ts', 'return `${path}?token=${t}`;', 'token baked into a URL'],
    ['app/admin/x/page.tsx', `resolveAdminAccess({ surface, queryToken })`, 'gate plumbing'],
    ['app/admin/x/page.tsx', `import { f } from '@/lib/admin/access';`, 'deleted module'],
    ['app/admin/auth/signin/route.ts', `searchParams.get('token')`, 'sign-in extra param'],
    ['app/admin/auth/callback/route.ts', `searchParams.get('secret')`, 'sign-in extra param'],
    ['app/admin/_lib/gate.ts', `export interface AdminGateRequest { surface: string; queryToken: string }`, 'gate contract'],
  ];

  for (const [file, snippet, label] of cases) {
    it(`flags: ${label}`, () => {
      expect(scanSource(file, snippet).length, snippet).toBeGreaterThan(0);
    });
  }

  it('does NOT flag the legitimate shapes', () => {
    expect(scanSource('app/admin/auth/callback/route.ts', `searchParams.get('code'); searchParams.get('next')`)).toEqual([]);
    expect(scanSource('app/admin/_lib/gate.ts', `export interface AdminGateRequest { surface: string }`)).toEqual([]);
    expect(scanSource('sentry.scrub.ts', `const DENY = new Set(['x-admin-token']);`)).toEqual([]);
    // Comments are history, not code.
    expect(scanSource('app/admin/x/page.tsx', `// the old ?token= / x-admin-token / ADMIN_DASHBOARD_TOKEN path`)).toEqual([]);
    // A non-admin route may use a param called token for something unrelated (e.g. /u/[preferencesToken]).
    expect(scanSource('app/u/x/page.tsx', `const t = searchParams.token;`)).toEqual([]);
  });
});
