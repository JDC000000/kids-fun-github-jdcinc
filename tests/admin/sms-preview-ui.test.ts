// tests/admin/sms-preview-ui.test.ts — the admin-side half of PR-2: the "Preview this Friday's
// text" links, and that the only clickable links in a rendered preview are the preview-tagged ones.
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { splitPreviewLinks } from '@/lib/admin/sms-preview';

const state = vi.hoisted(() => ({ role: 'admin' as string }));
const spies = vi.hoisted(() => ({
  getSmsSubscribers: vi.fn(),
  getSmsSubscriberDetail: vi.fn(),
  previewWeeklySmsForSubscriber: vi.fn(),
}));

vi.mock('@/lib/db/session-user', () => ({
  getRequestUser: async () => ({ userId: '11111111-1111-4111-8111-111111111111', email: null }),
}));
vi.mock('@/lib/db/admin-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/admin-guard')>();
  return { ...actual, requireAdmin: async (userId: string) => ({ userId, role: state.role }) };
});
vi.mock('@/lib/admin/audit', () => ({ recordAdminAccess: async () => true }));
vi.mock('@/lib/admin/sms-subscribers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/sms-subscribers')>();
  return { ...actual, getSmsSubscribers: spies.getSmsSubscribers, getSmsSubscriberDetail: spies.getSmsSubscriberDetail };
});
vi.mock('@/lib/admin/sms-preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/sms-preview')>();
  return { ...actual, previewWeeklySmsForSubscriber: spies.previewWeeklySmsForSubscriber };
});

const ID = '22222222-2222-4222-8222-222222222222';
const PURGED_ID = '44444444-4444-4444-8444-444444444444';

function row(id: string, purged: boolean, redacted: boolean) {
  return {
    id,
    shortRef: id === ID ? '42' : '43',
    phoneNumber: purged || redacted ? null : '+16045550166',
    purged,
    redacted,
    childCount: purged ? null : 1,
    postalCode: purged || redacted ? null : 'V6B 4Y8',
    birthYears: purged || redacted ? null : [2019],
    isTest: false,
    status: purged ? 'stopped' : 'active',
    consentMethod: 'web_form',
    consentTimestamp: '2026-09-01T00:00:00.000Z',
    confirmedTimestamp: '2026-09-01T00:05:00.000Z',
    consecutiveEmptyWeeks: 0,
    stoppedAt: null,
  };
}

const TAGGED = 'https://kidsfunapp.ca/s/aB3dE5fG7hJ9k?via=preview';
const UNTAGGED = 'https://kidsfunapp.ca/s/Zz0Yy1Xx2Ww3v';

async function render(p: Promise<unknown>): Promise<string> {
  return renderToStaticMarkup((await p) as ReactElement);
}

beforeEach(() => {
  state.role = 'admin';
  for (const s of Object.values(spies)) s.mockReset();
  spies.getSmsSubscriberDetail.mockImplementation(async (_id: string, o: { redactPersonalData: boolean }) => ({
    subscriber: row(ID, false, o.redactPersonalData),
    sends: [],
    purged: false,
  }));
  spies.getSmsSubscribers.mockImplementation(async (o: { redactPersonalData: boolean }) => [
    row(ID, false, o.redactPersonalData),
    row(PURGED_ID, true, o.redactPersonalData),
  ]);
  spies.previewWeeklySmsForSubscriber.mockResolvedValue({
    status: 'ok',
    body: `Picks:\n1. Swim ${TAGGED}\n2. Art ${UNTAGGED}\nPrefs https://kidsfunapp.ca/u/#####`,
    segments: 2,
    characters: 120,
    outcome: 'sent',
    areaLabel: 'East Van',
    pickCount: 2,
    tokenRedacted: true,
  });
});

describe('splitPreviewLinks — only tagged short links become clickable', () => {
  it('links exactly the tagged http(s) /s/ URLs; everything else is text', () => {
    const body = `a ${TAGGED} b ${UNTAGGED} c javascript:alert(1)/s/x?via=preview d /u/### e`;
    const parts = splitPreviewLinks(body);
    expect(parts.filter((p) => p.href).map((p) => p.href)).toEqual([TAGGED]);
    expect(parts.map((p) => p.text).join('')).toBe(body); // lossless
  });

  it('handles several tagged links and a body with none', () => {
    const two = `${TAGGED}\n${TAGGED.replace('aB3', 'xY9')}`;
    expect(splitPreviewLinks(two).filter((p) => p.href)).toHaveLength(2);
    expect(splitPreviewLinks('no links here')).toEqual([{ text: 'no links here' }]);
  });
});

describe('/admin/sms-subscribers/[id]', () => {
  it('🔴 a human admin sees "Preview this Friday’s text" at the top, pointing at ?preview=1', async () => {
    const { default: Page } = await import('@/app/admin/sms-subscribers/[id]/page');
    const html = await render(Page({ params: { id: ID }, searchParams: {} }));
    expect(html).toContain(`href="/admin/sms-subscribers/${ID}?preview=1#this-weeks-sms"`);
    expect(html).toContain('Preview this Friday’s text');
    expect(html).toContain('id="this-weeks-sms"');
  });

  it('🔴 in the rendered preview, ONLY the tagged link is an anchor (new tab, no referrer)', async () => {
    const { default: Page } = await import('@/app/admin/sms-subscribers/[id]/page');
    const html = await render(Page({ params: { id: ID }, searchParams: { preview: '1' } }));
    const hrefs = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    const shortLinks = hrefs.filter((h) => h.includes('/s/'));
    expect(shortLinks).toEqual([TAGGED]);
    expect(html).toMatch(/<a href="https:\/\/kidsfunapp\.ca\/s\/aB3dE5fG7hJ9k\?via=preview" target="_blank" rel="noreferrer noopener">/);
    expect(html).toContain(UNTAGGED); // still visible as text, just not a link
    expect(html).toContain('is not counted as this parent’s click');
  });

  it('a read-only viewer gets no preview link at all (PR-1 refuses the preview)', async () => {
    state.role = 'viewer';
    const { default: Page } = await import('@/app/admin/sms-subscribers/[id]/page');
    const html = await render(Page({ params: { id: ID }, searchParams: {} }));
    expect(html).not.toContain('?preview=1');
    expect(html).not.toContain('Preview this Friday');
  });
});

describe('/admin/sms-subscribers (list)', () => {
  it('🔴 a human admin gets a "Friday text" column: a Preview link per live row, a dash for purged', async () => {
    const { default: Page } = await import('@/app/admin/sms-subscribers/page');
    const html = await render(Page());
    expect(html).toContain('<th>Friday text</th>');
    expect(html).toContain(`href="/admin/sms-subscribers/${ID}?preview=1#this-weeks-sms"`);
    expect(html).not.toContain(`href="/admin/sms-subscribers/${PURGED_ID}?preview=1`);
  });

  it('a read-only viewer gets no such column', async () => {
    state.role = 'viewer';
    const { default: Page } = await import('@/app/admin/sms-subscribers/page');
    const html = await render(Page());
    expect(html).not.toContain('Friday text');
    expect(html).not.toContain('?preview=1');
  });
});
