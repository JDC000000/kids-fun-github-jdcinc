// tests/admin/viewer-role.test.ts — the read-only, PII-redacted 'viewer' admin role (DB-free).
//
// PR-1 of the agent test admin login (documents/kids-fun/agent-test-admin-login-SCOPE-2026-09-24.md).
// The role and its enforcement ship together, because before this change nothing read
// admin_user.role and any active row was a full-write, full-PII admin. This file pins the
// enforcement at every choke point, for the viewer AND — just as importantly — proves each human
// role (operator / admin / superadmin) behaves exactly as before:
//   (1) capabilities are allow-lists that fail closed on any unrecognised role;
//   (2) all 9 admin server actions refuse a viewer before touching anything, and still pass a human
//       through the gate; the set of actions is enumerated from disk so a new one cannot skip this;
//   (3) POST /api/admin/catalogue-cache/bust refuses a viewer session, accepts a human one;
//   (4) every PII page asks its read model to redact for a viewer and not for a human, and the
//       subscriber detail page refuses the SMS preview for a viewer;
//   (5) the five mutate-capable pages decide canMutate from the role, not from "has a session".
// The SQL-level redaction itself is proven against a real database in viewer-role-db.test.ts.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canSeePersonalData, canWrite, type AdminRole } from '@/lib/db/admin-guard';

const HUMAN_ROLES: AdminRole[] = ['operator', 'admin', 'superadmin'];
const REFUSAL = /Read-only access cannot make changes/;

const state = vi.hoisted(() => ({ role: 'viewer' as string, dbTouched: 0 }));

vi.mock('@/lib/db/session-user', () => ({
  getRequestUser: async () => ({ userId: '11111111-1111-4111-8111-111111111111', email: null }),
}));
vi.mock('@/lib/db/admin-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/admin-guard')>();
  return {
    ...actual,
    requireAdmin: async (userId: string) => ({ userId, role: state.role }),
  };
});
// Any database access is recorded and refused: a viewer's write attempt must not get that far.
vi.mock('@/lib/db/client', () => {
  const touch = () => {
    state.dbTouched += 1;
    throw new Error('database reached');
  };
  return { query: touch, queryWithTimeout: touch, getPool: touch, closePool: async () => undefined };
});
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock('@/lib/search/postgres-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/search/postgres-repository')>();
  return { ...actual, bustSharedCatalogueCache: vi.fn(async () => undefined) };
});

// Read-model spies for (4). Each returns an empty-but-valid result; the assertions are about the
// ARGUMENT the page passes (redact or not), which is the page's whole responsibility here.
const spies = vi.hoisted(() => ({
  getSmsSubscribers: vi.fn(async () => []),
  getSmsSubscriberDetail: vi.fn(),
  getSmsEngagement: vi.fn(async () => ({
    rows: [],
    summary: { subscribers: 0, sends: 0, delivered: 0, failed: 0, picksOffered: 0, taps: 0, directTaps: 0, hubTaps: 0, tapRatePct: null },
  })),
  listOpenCorrections: vi.fn(async () => []),
  previewWeeklySmsForSubscriber: vi.fn(async () => ({ status: 'no_message', outcome: 'geocode_failed' })),
}));
vi.mock('@/lib/admin/sms-subscribers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/sms-subscribers')>();
  return { ...actual, getSmsSubscribers: spies.getSmsSubscribers, getSmsSubscriberDetail: spies.getSmsSubscriberDetail };
});
vi.mock('@/lib/admin/sms-engagement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/sms-engagement')>();
  return { ...actual, getSmsEngagement: spies.getSmsEngagement };
});
vi.mock('@/lib/admin/sms-preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/sms-preview')>();
  return { ...actual, previewWeeklySmsForSubscriber: spies.previewWeeklySmsForSubscriber };
});
vi.mock('@/app/admin/corrections/_lib/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/admin/corrections/_lib/data')>();
  return { ...actual, listOpenCorrections: spies.listOpenCorrections, getStatusStateOptions: async () => [] };
});

beforeEach(() => {
  state.dbTouched = 0;
  for (const s of Object.values(spies)) s.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// (1) capabilities
// ─────────────────────────────────────────────────────────────────────────────
describe('(1) capabilities are fail-closed allow-lists', () => {
  it('every human role keeps full write and full personal-data access (unchanged)', () => {
    for (const role of HUMAN_ROLES) {
      expect(canWrite(role), role).toBe(true);
      expect(canSeePersonalData(role), role).toBe(true);
    }
  });

  it('🔴 viewer gets neither', () => {
    expect(canWrite('viewer')).toBe(false);
    expect(canSeePersonalData('viewer')).toBe(false);
  });

  it('🔴 an unrecognised role gets neither (typo, future value, wrong case, empty, missing)', () => {
    for (const role of ['Admin', 'SUPERADMIN', 'root', 'owner', '', ' admin', 'admin ', null, undefined]) {
      expect(canWrite(role as string), String(role)).toBe(false);
      expect(canSeePersonalData(role as string), String(role)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) the 9 server actions
// ─────────────────────────────────────────────────────────────────────────────
type Action = (fd: FormData) => Promise<{ ok: boolean; message?: string }>;

function actionFiles(): string[] {
  const root = join(process.cwd(), 'app/admin');
  return readdirSync(root)
    .map((d) => join('app/admin', d, 'actions.ts'))
    .filter((f) => existsSync(join(process.cwd(), f)));
}

function exportedActionNames(file: string): string[] {
  const src = readFileSync(join(process.cwd(), file), 'utf8');
  return [...src.matchAll(/^export async function (\w+)\s*\(/gm)].map((m) => m[1]);
}

describe('(2) every admin server action refuses a viewer before touching anything', () => {
  const all = actionFiles().flatMap((f) => exportedActionNames(f).map((name) => ({ file: f, name })));

  it('finds exactly the 9 known actions (a new action must be added to this review)', () => {
    expect(all.map((a) => `${a.file}#${a.name}`).sort()).toEqual(
      [
        'app/admin/corrections/actions.ts#resolveCorrectionAction',
        'app/admin/listings/actions.ts#createManualListingAction',
        'app/admin/qa-queue/actions.ts#dedupReviewAction',
        'app/admin/qa-queue/actions.ts#reviewAction',
        'app/admin/sources/actions.ts#saveSourceAction',
        'app/admin/taxonomy/actions.ts#deleteAliasAction',
        'app/admin/taxonomy/actions.ts#saveAliasAction',
        'app/admin/taxonomy/actions.ts#saveCategoryAction',
        'app/admin/taxonomy/actions.ts#saveRegionAction',
      ].sort()
    );
  });

  it('🔴 each action gates on resolveSessionAdmin() as its first statement', () => {
    for (const { file, name } of all) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      const body = src.slice(src.indexOf(`export async function ${name}`));
      const firstStatement = body.slice(body.indexOf('{') + 1).trim().split('\n')[0];
      expect(firstStatement, `${file}#${name}`).toMatch(/await resolveSessionAdmin\(\)/);
    }
  });

  for (const { file, name } of actionFiles().flatMap((f) => exportedActionNames(f).map((n) => ({ file: f, name: n })))) {
    it(`🔴 viewer → refused, nothing touched: ${file}#${name}`, async () => {
      state.role = 'viewer';
      const mod = (await import(/* @vite-ignore */ join(process.cwd(), file))) as Record<string, Action>;
      const result = await mod[name](new FormData());
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(REFUSAL);
      expect(state.dbTouched).toBe(0);
    });

    it(`human roles still pass the gate: ${file}#${name}`, async () => {
      const mod = (await import(/* @vite-ignore */ join(process.cwd(), file))) as Record<string, Action>;
      for (const role of HUMAN_ROLES) {
        state.role = role;
        // Past the gate a human hits form validation (empty FormData) or the (mocked-out) database.
        // Either is fine; what must NOT happen is the read-only refusal.
        const result = await mod[name](new FormData()).catch((e: Error) => ({ ok: false, message: `threw: ${e.message}` }));
        expect(result.message ?? '', `${name} as ${role}`).not.toMatch(REFUSAL);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) the session-authorised admin API
// ─────────────────────────────────────────────────────────────────────────────
describe('(3) POST /api/admin/catalogue-cache/bust', () => {
  const post = async () => {
    const { POST } = await import('@/app/api/admin/catalogue-cache/bust/route');
    return POST(new Request('http://localhost/api/admin/catalogue-cache/bust', { method: 'POST' }));
  };

  it('🔴 refuses a viewer session (401) and busts nothing', async () => {
    state.role = 'viewer';
    const repo = await import('@/lib/search/postgres-repository');
    const res = await post();
    expect(res.status).toBe(401);
    expect(repo.bustSharedCatalogueCache).not.toHaveBeenCalled();
  });

  it('still accepts a human admin session', async () => {
    const repo = await import('@/lib/search/postgres-repository');
    for (const role of HUMAN_ROLES) {
      state.role = role;
      vi.mocked(repo.bustSharedCatalogueCache).mockClear();
      const res = await post();
      expect(res.status, role).toBe(200);
      expect(repo.bustSharedCatalogueCache).toHaveBeenCalledTimes(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) PII pages ask for redaction by role
// ─────────────────────────────────────────────────────────────────────────────
const SUBSCRIBER_ID = '22222222-2222-4222-8222-222222222222';

function detailFixture(redacted: boolean) {
  return {
    subscriber: {
      id: SUBSCRIBER_ID,
      shortRef: '42',
      phoneNumber: redacted ? null : '+16045550166',
      purged: false,
      redacted,
      childCount: 1,
      postalCode: redacted ? null : 'V6B 4Y8',
      birthYears: redacted ? null : [2019],
      isTest: false,
      status: 'active',
      consentMethod: 'web_form',
      consentTimestamp: '2026-09-01T00:00:00.000Z',
      confirmedTimestamp: '2026-09-01T00:05:00.000Z',
      consecutiveEmptyWeeks: 0,
      stoppedAt: null,
    },
    sends: [],
    purged: false,
  };
}

async function render(page: Promise<unknown>): Promise<string> {
  return renderToStaticMarkup((await page) as ReactElement);
}

describe('(4) PII pages redact for a viewer and not for a human', () => {
  it('🔴 /admin/sms-subscribers', async () => {
    const { default: Page } = await import('@/app/admin/sms-subscribers/page');
    state.role = 'viewer';
    await render(Page());
    expect(spies.getSmsSubscribers).toHaveBeenLastCalledWith({ redactPersonalData: true });
    for (const role of HUMAN_ROLES) {
      state.role = role;
      await render(Page());
      expect(spies.getSmsSubscribers, role).toHaveBeenLastCalledWith({ redactPersonalData: false });
    }
  });

  it('🔴 /admin/sms-subscribers/[id]: redacted read AND the preview refused for a viewer (?preview=1)', async () => {
    const { default: Page } = await import('@/app/admin/sms-subscribers/[id]/page');
    state.role = 'viewer';
    spies.getSmsSubscriberDetail.mockResolvedValue(detailFixture(true));
    const html = await render(Page({ params: { id: SUBSCRIBER_ID }, searchParams: { preview: '1' } }));
    expect(spies.getSmsSubscriberDetail).toHaveBeenLastCalledWith(SUBSCRIBER_ID, { redactPersonalData: true });
    expect(spies.previewWeeklySmsForSubscriber).not.toHaveBeenCalled();
    expect(html).toContain('not available to a read-only role');
    expect(html).not.toContain('?preview=1'); // no link offering it either
    expect(html).toContain('redacted (read-only role)');
  });

  it('/admin/sms-subscribers/[id] for a human: unredacted read, preview runs (unchanged)', async () => {
    const { default: Page } = await import('@/app/admin/sms-subscribers/[id]/page');
    for (const role of HUMAN_ROLES) {
      state.role = role;
      spies.previewWeeklySmsForSubscriber.mockClear();
      spies.getSmsSubscriberDetail.mockResolvedValue(detailFixture(false));
      const html = await render(Page({ params: { id: SUBSCRIBER_ID }, searchParams: { preview: '1' } }));
      expect(spies.getSmsSubscriberDetail, role).toHaveBeenLastCalledWith(SUBSCRIBER_ID, { redactPersonalData: false });
      expect(spies.previewWeeklySmsForSubscriber, role).toHaveBeenCalledTimes(1);
      expect(html).toContain('+16045550166');
      expect(html).not.toContain('not available to a read-only role');
    }
  });

  it('🔴 /admin/sms-engagement', async () => {
    const { default: Page } = await import('@/app/admin/sms-engagement/page');
    state.role = 'viewer';
    await render(Page({ searchParams: {} }));
    expect(spies.getSmsEngagement).toHaveBeenLastCalledWith({ includeTest: false, redactPersonalData: true });
    for (const role of HUMAN_ROLES) {
      state.role = role;
      await render(Page({ searchParams: {} }));
      expect(spies.getSmsEngagement, role).toHaveBeenLastCalledWith({ includeTest: false, redactPersonalData: false });
    }
  });

  it('🔴 /admin/corrections', async () => {
    const { default: Page } = await import('@/app/admin/corrections/page');
    state.role = 'viewer';
    await render(Page({ searchParams: {} }));
    expect(spies.listOpenCorrections).toHaveBeenLastCalledWith({ redactPersonalData: true });
    for (const role of HUMAN_ROLES) {
      state.role = role;
      await render(Page({ searchParams: {} }));
      expect(spies.listOpenCorrections, role).toHaveBeenLastCalledWith({ redactPersonalData: false });
    }
  });

  it('🔴 /admin/dashboard and /admin/data-health pass their correction list through correctionsForDisplay by role', () => {
    // Source-level: these two pages render large role-independent payloads (the dashboard's is a
    // precomputed snapshot), so the check is that the ONLY list they render is the role-filtered
    // one. correctionsForDisplay itself is proven against real rows in viewer-role-db.test.ts.
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const dash = strip(readFileSync('app/admin/dashboard/page.tsx', 'utf8'));
    expect(dash).toMatch(/const corrections = correctionsForDisplay\(data\.corrections, \{\s*redactPersonalData: !canSeePersonalData\(grant\.admin\.role\),?\s*\}\)/);
    expect(dash).not.toMatch(/\{[^}]*\bcorrections\b[^}]*\}\s*=\s*data\b/); // not destructured raw from the payload
    const dh = strip(readFileSync('app/admin/data-health/page.tsx', 'utf8'));
    expect(dh).toMatch(/corrections=\{correctionsForDisplay\(data\.corrections, \{\s*redactPersonalData: !canSeePersonalData\(grant\.admin\.role\),?\s*\}\)\}/);
    expect(dh).not.toMatch(/corrections=\{data\.corrections\}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) canMutate is role-based
// ─────────────────────────────────────────────────────────────────────────────
describe('(5) the five mutate-capable pages decide canMutate from the role', () => {
  for (const page of [
    'app/admin/corrections/page.tsx',
    'app/admin/listings/new/page.tsx',
    'app/admin/qa-queue/page.tsx',
    'app/admin/sources/page.tsx',
    'app/admin/taxonomy/page.tsx',
  ]) {
    it(page, () => {
      const src = readFileSync(page, 'utf8');
      expect(src).toContain('const canMutate = canWrite(grant.admin.role);');
      expect(src).not.toMatch(/canMutate\s*=\s*grant\.via/);
    });
  }
});
