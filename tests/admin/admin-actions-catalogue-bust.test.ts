// tests/admin/admin-actions-catalogue-bust.test.ts — every admin write that changes what the
// catalogue shows busts the shared catalogue cache; nothing else does.
//
// WHY. The shared catalogue cache re-derives the catalogue only every 6 hours, and admin sign-in is
// live (/admin/auth/signin). Without these busts, an admin taking a listing down would see it stay
// up on every public surface for hours. See lib/search/catalogue-write-bust.ts for which writes bust
// and the SQL-level reason for each.
//
// Pinned per action:
//   · a successful write busts exactly once, BEFORE the redirect (redirect() throws, so a bust
//     placed after it would never run);
//   · a refused write (no admin session), invalid input, a data-layer throw, or a data-layer
//     "not ok" result does NOT bust — nothing changed, so nothing to publish;
//   · the writes that deliberately do not bust (source/category create, regions, aliases) are
//     pinned too, so changing that is a decision rather than an accident.
// The helper itself (a failed bust never fails the committed write) is tests/search/catalogue-write-bust.test.ts.
//
// UNIT lane: the admin gate, the data layers and Next's navigation are mocked; the server actions
// are real, and so is qa-queue's intent vocabulary.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  events: [] as string[],
  admin: { userId: 'admin-1' } as null | { userId: string },
  parseOk: true,
}));

vi.mock('@/lib/search/catalogue-write-bust', () => ({
  bustCatalogueAfterAdminWrite: vi.fn(async (action: string) => {
    h.events.push(`bust:${action}`);
  }),
}));
vi.mock('@/app/admin/_lib/gate', () => ({ resolveSessionAdmin: vi.fn(async () => h.admin) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), unstable_cache: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    h.events.push(`redirect:${to}`);
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to}` });
  }),
}));

const parsed = <T,>(value: T) => (h.parseOk ? { ok: true as const, value } : { ok: false as const, errors: { x: 'bad' } });
vi.mock('@/app/admin/corrections/_lib/vocab', () => ({ parseResolveInput: () => parsed({}) }));
vi.mock('@/app/admin/listings/_lib/vocab', () => ({ parseManualListingInput: () => parsed({}) }));
vi.mock('@/app/admin/sources/_lib/vocab', () => ({ parseSourceInput: () => parsed({}) }));
vi.mock('@/app/admin/taxonomy/_lib/vocab', () => ({
  parseRegionInput: () => parsed({}),
  parseCategoryInput: () => parsed({}),
  parseAliasInput: () => parsed({}),
}));

vi.mock('@/app/admin/corrections/_lib/data', () => ({ resolveCorrection: vi.fn() }));
vi.mock('@/app/admin/listings/_lib/data', () => ({
  createManualListing: vi.fn(),
  ManualListingError: class ManualListingError extends Error {},
}));
vi.mock('@/app/admin/qa-queue/_lib/data', () => ({
  reviewOccurrence: vi.fn(),
  confirmDedupMerge: vi.fn(),
  rejectDedupPair: vi.fn(),
}));
vi.mock('@/app/admin/sources/_lib/data', () => ({
  createSource: vi.fn(),
  updateSource: vi.fn(),
  getSourceById: vi.fn(),
  SourceConflictError: class SourceConflictError extends Error {},
}));
vi.mock('@/app/admin/taxonomy/_lib/data', () => ({
  createRegion: vi.fn(),
  updateRegion: vi.fn(),
  getRegionById: vi.fn(),
  RegionCycleError: class RegionCycleError extends Error {},
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  getCategoryById: vi.fn(),
  createAlias: vi.fn(),
  updateAlias: vi.fn(),
  getAliasById: vi.fn(),
  deleteAlias: vi.fn(),
  TaxonomyConflictError: class TaxonomyConflictError extends Error {},
}));

import { resolveCorrectionAction } from '@/app/admin/corrections/actions';
import { createManualListingAction } from '@/app/admin/listings/actions';
import { reviewAction, dedupReviewAction } from '@/app/admin/qa-queue/actions';
import { saveSourceAction } from '@/app/admin/sources/actions';
import {
  saveRegionAction,
  saveCategoryAction,
  saveAliasAction,
  deleteAliasAction,
} from '@/app/admin/taxonomy/actions';
import * as corrections from '@/app/admin/corrections/_lib/data';
import * as listings from '@/app/admin/listings/_lib/data';
import * as qa from '@/app/admin/qa-queue/_lib/data';
import * as sources from '@/app/admin/sources/_lib/data';
import * as taxonomy from '@/app/admin/taxonomy/_lib/data';

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Run an action; a Next redirect is the success signal and is swallowed. */
async function run(action: (fd: FormData) => Promise<unknown>, fields: Record<string, string>): Promise<unknown> {
  try {
    return await action(form(fields));
  } catch (err) {
    if (String((err as { digest?: string }).digest).startsWith('NEXT_REDIRECT')) return 'redirected';
    throw err;
  }
}

const busts = () => h.events.filter((e) => e.startsWith('bust:'));

beforeEach(() => {
  h.events.length = 0;
  h.admin = { userId: 'admin-1' };
  h.parseOk = true;
  vi.mocked(corrections.resolveCorrection).mockResolvedValue({ ok: true } as never);
  vi.mocked(listings.createManualListing).mockResolvedValue({ occurrenceId: 'occ-1' } as never);
  vi.mocked(qa.reviewOccurrence).mockResolvedValue({ ok: true } as never);
  vi.mocked(qa.confirmDedupMerge).mockResolvedValue({ ok: true } as never);
  vi.mocked(qa.rejectDedupPair).mockResolvedValue({ ok: true } as never);
  vi.mocked(sources.getSourceById).mockResolvedValue({ id: 'src-1' } as never);
  vi.mocked(sources.updateSource).mockResolvedValue(undefined as never);
  vi.mocked(sources.createSource).mockResolvedValue(undefined as never);
  vi.mocked(taxonomy.getCategoryById).mockResolvedValue({ id: 'cat-1' } as never);
  vi.mocked(taxonomy.getRegionById).mockResolvedValue({ id: 'reg-1' } as never);
  vi.mocked(taxonomy.getAliasById).mockResolvedValue({ id: 'al-1' } as never);
  for (const fn of [
    taxonomy.updateCategory, taxonomy.createCategory, taxonomy.updateRegion, taxonomy.createRegion,
    taxonomy.updateAlias, taxonomy.createAlias, taxonomy.deleteAlias,
  ]) vi.mocked(fn).mockResolvedValue(undefined as never);
});
afterEach(() => {
  vi.clearAllMocks();
});

interface BustingCase {
  name: string;
  action: (fd: FormData) => Promise<unknown>;
  fields: Record<string, string>;
  label: string;
  /** Make the data layer throw. */
  throwData: () => void;
  /** Make the data layer report "not ok" (already handled / gone), where it can. */
  notOk?: () => void;
}

const BUSTING: BustingCase[] = [
  {
    name: 'corrections: resolve',
    action: resolveCorrectionAction,
    fields: { reportId: 'rep-1' },
    label: 'correction.resolve',
    throwData: () => vi.mocked(corrections.resolveCorrection).mockRejectedValue(new Error('db')),
    notOk: () => vi.mocked(corrections.resolveCorrection).mockResolvedValue({ ok: false, reason: 'already_resolved' } as never),
  },
  {
    name: 'listings: create manual listing',
    action: createManualListingAction,
    fields: {},
    label: 'listing.create',
    throwData: () => vi.mocked(listings.createManualListing).mockRejectedValue(new Error('db')),
  },
  {
    name: 'qa-queue: confirm',
    action: reviewAction,
    fields: { occurrenceId: 'occ-1', intent: 'confirm' },
    label: 'qa.confirm',
    throwData: () => vi.mocked(qa.reviewOccurrence).mockRejectedValue(new Error('db')),
    notOk: () => vi.mocked(qa.reviewOccurrence).mockResolvedValue({ ok: false, reason: 'already_handled' } as never),
  },
  {
    name: 'qa-queue: reject',
    action: reviewAction,
    fields: { occurrenceId: 'occ-1', intent: 'reject' },
    label: 'qa.reject',
    throwData: () => vi.mocked(qa.reviewOccurrence).mockRejectedValue(new Error('db')),
    notOk: () => vi.mocked(qa.reviewOccurrence).mockResolvedValue({ ok: false, reason: 'not_found' } as never),
  },
  {
    name: 'qa-queue: dedup merge',
    action: dedupReviewAction,
    fields: { duplicateId: 'occ-2', canonicalId: 'occ-1', intent: 'merge' },
    label: 'qa.dedup_merge',
    throwData: () => vi.mocked(qa.confirmDedupMerge).mockRejectedValue(new Error('db')),
    notOk: () => vi.mocked(qa.confirmDedupMerge).mockResolvedValue({ ok: false, reason: 'not_a_pair' } as never),
  },
  {
    name: 'qa-queue: dedup keep separate',
    action: dedupReviewAction,
    fields: { duplicateId: 'occ-2', canonicalId: 'occ-1', intent: 'reject_merge' },
    label: 'qa.dedup_keep_separate',
    throwData: () => vi.mocked(qa.rejectDedupPair).mockRejectedValue(new Error('db')),
    notOk: () => vi.mocked(qa.rejectDedupPair).mockResolvedValue({ ok: false, reason: 'already_handled' } as never),
  },
  {
    name: 'sources: update',
    action: saveSourceAction,
    fields: { id: 'src-1' },
    label: 'source.update',
    throwData: () => vi.mocked(sources.updateSource).mockRejectedValue(new Error('db')),
    notOk: () => vi.mocked(sources.getSourceById).mockResolvedValue(null as never),
  },
  {
    name: 'taxonomy: category update',
    action: saveCategoryAction,
    fields: { id: 'cat-1' },
    label: 'category.update',
    throwData: () => vi.mocked(taxonomy.updateCategory).mockRejectedValue(new Error('db')),
    notOk: () => vi.mocked(taxonomy.getCategoryById).mockResolvedValue(null as never),
  },
];

describe.each(BUSTING)('$name', (c) => {
  it('a successful write busts the catalogue exactly once, before the redirect', async () => {
    expect(await run(c.action, c.fields)).toBe('redirected');
    expect(busts()).toEqual([`bust:${c.label}`]);
    const bustAt = h.events.indexOf(`bust:${c.label}`);
    const redirectAt = h.events.findIndex((e) => e.startsWith('redirect:'));
    expect(bustAt).toBeLessThan(redirectAt);
  });

  it('a refused write (no admin session) does not bust', async () => {
    h.admin = null;
    await run(c.action, c.fields);
    expect(busts()).toEqual([]);
  });

  it('a data-layer failure does not bust', async () => {
    c.throwData();
    await run(c.action, c.fields);
    expect(busts()).toEqual([]);
  });

  if (c.notOk) {
    it('a write the data layer reports as not applied does not bust', async () => {
      c.notOk!();
      await run(c.action, c.fields);
      expect(busts()).toEqual([]);
    });
  }

  if (c.action !== reviewAction && c.action !== dedupReviewAction) {
    it('invalid input does not bust', async () => {
      h.parseOk = false;
      await run(c.action, c.fields);
      expect(busts()).toEqual([]);
    });
  }
});

describe('qa-queue: invalid intents never bust', () => {
  it.each([
    [reviewAction, { occurrenceId: 'occ-1', intent: 'delete' }],
    [dedupReviewAction, { duplicateId: 'occ-2', canonicalId: 'occ-1', intent: 'nope' }],
    [dedupReviewAction, { duplicateId: 'occ-2', intent: 'merge' }],
  ] as const)('%#', async (action, fields) => {
    await run(action, fields);
    expect(busts()).toEqual([]);
  });
});

describe('writes that deliberately do NOT bust (they cannot change the catalogue snapshot)', () => {
  it.each([
    ['source create (no listing references it yet)', saveSourceAction, {}],
    ['category create (no listing references it yet)', saveCategoryAction, {}],
    ['region create (own 60s region cache)', saveRegionAction, {}],
    ['region update (own 60s region cache)', saveRegionAction, { id: 'reg-1' }],
    ['alias create (own 60s alias cache)', saveAliasAction, {}],
    ['alias update (own 60s alias cache)', saveAliasAction, { id: 'al-1' }],
    ['alias delete (own 60s alias cache)', deleteAliasAction, { id: 'al-1' }],
  ] as const)('%s', async (_label, action, fields) => {
    expect(await run(action, fields)).toBe('redirected');
    expect(busts()).toEqual([]);
  });
});
