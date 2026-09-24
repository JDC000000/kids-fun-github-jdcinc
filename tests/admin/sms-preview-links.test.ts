// tests/admin/sms-preview-links.test.ts — the two ends of the admin-preview tap that are not the
// /s/ route itself (that is tests/sms/click_through_preview.test.ts):
//   (4) /activity/[id] skips its `listing_viewed` ONLY for a browser carrying the preview-hop cookie;
//   (5) the admin preview body tags every /s/ link `?via=preview`, AFTER masking and AFTER the
//       counts — so the numbers reviewed are still the real message's, and nothing sent is touched.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  recordListingView: vi.fn(async () => undefined),
  body: '',
}));

vi.mock('next/headers', () => ({
  cookies: () => ({ get: (name: string) => (name === 'kf_preview_hop' && h.cookie !== undefined ? { name, value: h.cookie } : undefined) }),
  headers: () => new Headers(),
}));
vi.mock('@/lib/analytics/record', () => ({ recordListingView: h.recordListingView }));
vi.mock('@/app/preview/_data/load-activity', () => ({
  loadActivityById: async (id: string) => ({ id, activityName: 'Swim', category: 'sport', sourceName: 'Rec' }),
}));
vi.mock('@/app/preview/_components/ActivityDetail', () => ({ ActivityDetail: () => null }));

// (5): the real preview function over stubbed readers and a stubbed builder.
const TOKEN_A = 'aB3dE5fG7hJ9k';
const TOKEN_B = 'Zz0Yy1Xx2Ww3v';
const PREFS = 'prefs-token-0123456789';
vi.mock('@/lib/sms/weekly-send-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sms/weekly-send-io')>();
  return {
    ...actual,
    loadWeeklySmsDeps: async () => ({ engine: {}, occurrenceShortRefs: new Map() }),
    loadActiveSubscribers: async () => [
      { subscriber: { id: 'sub-1', preferencesToken: PREFS }, phoneNumber: '+16045550100' },
    ],
  };
});
vi.mock('@/lib/sms/weekly-send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sms/weekly-send')>();
  return {
    ...actual,
    buildWeeklySms: () => ({
      outcome: 'sent',
      areaLabel: 'East Van',
      picks: { picks: [{}, {}] },
      message: { body: h.body, segments: 3, characters: h.body.length },
    }),
  };
});

import CanonicalActivityPage from '@/app/activity/[id]/page';
import { previewWeeklySmsForSubscriber } from '@/lib/admin/sms-preview';

beforeEach(() => {
  h.cookie = undefined;
  h.recordListingView.mockClear();
  vi.stubEnv('SMS_SHORT_LINK_SECRET', 'test-secret');
});

describe('(4) /activity/[id] and the preview-hop cookie', () => {
  it('records listing_viewed normally', async () => {
    await CanonicalActivityPage({ params: { id: 'occ-1' } });
    expect(h.recordListingView).toHaveBeenCalledTimes(1);
  });

  it('🔴 skips it when the browser carries kf_preview_hop=1', async () => {
    h.cookie = '1';
    await CanonicalActivityPage({ params: { id: 'occ-1' } });
    expect(h.recordListingView).not.toHaveBeenCalled();
  });

  it('only the exact value "1" counts — any other value still records', async () => {
    for (const v of ['', '0', 'true', '11']) {
      h.recordListingView.mockClear();
      h.cookie = v;
      await CanonicalActivityPage({ params: { id: 'occ-1' } });
      expect(h.recordListingView, JSON.stringify(v)).toHaveBeenCalledTimes(1);
    }
  });

  it('🔴 no query parameter can switch it off (the page does not read searchParams for this)', async () => {
    const page = CanonicalActivityPage as unknown as (p: unknown) => Promise<unknown>;
    await page({ params: { id: 'occ-1' }, searchParams: { via: 'preview', kf_preview_hop: '1' } });
    expect(h.recordListingView).toHaveBeenCalledTimes(1);
  });
});

describe('(5) the admin preview body', () => {
  it('🔴 tags every /s/ link ?via=preview, masks the preferences token, and reports the REAL counts', async () => {
    h.body = [
      'Picks near East Van:',
      `1. Swim https://kidsfunapp.ca/s/${TOKEN_A}`,
      `2. Art https://kidsfunapp.ca/s/${TOKEN_B}`,
      `Prefs https://kidsfunapp.ca/u/${PREFS}`,
    ].join('\n');
    const r = await previewWeeklySmsForSubscriber('sub-1', new Date('2026-09-24T12:00:00Z'));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.body).toContain(`/s/${TOKEN_A}?via=preview`);
    expect(r.body).toContain(`/s/${TOKEN_B}?via=preview`);
    expect(r.body).not.toMatch(new RegExp(`/s/${TOKEN_A}(?!\\?via=preview)`));
    expect(r.body).not.toContain(PREFS);
    expect(r.body).toContain('#'.repeat(PREFS.length));
    expect(r.tokenRedacted).toBe(true);
    // Counts describe the message that would be SENT, not the tagged display copy.
    expect(r.characters).toBe(h.body.length);
    expect(r.segments).toBe(3);
  });

  it('tokenRedacted stays honest when there is no preferences token in the body (tagging alone is not "redaction")', async () => {
    h.body = `1. Swim https://kidsfunapp.ca/s/${TOKEN_A}`;
    const r = await previewWeeklySmsForSubscriber('sub-1', new Date('2026-09-24T12:00:00Z'));
    expect(r.status === 'ok' && r.tokenRedacted).toBe(false);
    expect(r.status === 'ok' && r.body).toContain('?via=preview');
  });
});
