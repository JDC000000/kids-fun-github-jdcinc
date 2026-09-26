// tests/sms/click_through_preview.test.ts — an admin-preview tap is verified and redirected like
// any other, and counts NOTHING; and `?via=preview` can do nothing else, for anyone.
//
// The defect (2026-09-24): /admin/sms-subscribers/[id]?preview=1 renders a subscriber's real /s/
// tokens, so an admin opening one wrote an `sms_click_event` in the parent's name. The fix: the
// preview's displayed links carry `?via=preview`; the /s/ route counts no click for that marker,
// and leaves a 60s path-scoped cookie so the activity page it lands on skips its `listing_viewed`.
//
// Layers:
//   (1) the marker and the tagger (pure);
//   (2) resolveClickThrough with countClick:false (decision table, readers injected);
//   (3) GET /s/[shortId] END TO END with the real default readers over a scripted fake `query`,
//       so an INSERT INTO sms_click_event is observed or not — including every abuse case;
//   (4) the activity page honours the cookie and nothing else;
//   (5) the admin preview body is tagged, after masking and after the counts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeShortLink } from '@/lib/sms/short-link';

// ── (3)'s fake database: answers the three readers, records every statement ──────────────
const db = vi.hoisted(() => ({
  statements: [] as string[],
  occurrenceId: '11111111-1111-4111-8111-111111111111' as string | null,
}));
vi.mock('@/lib/db/client', () => ({
  query: async (sql: string) => {
    db.statements.push(sql.replace(/\s+/g, ' ').trim());
    if (/FROM activity_occurrence/.test(sql)) return db.occurrenceId ? [{ id: db.occurrenceId }] : [];
    if (/FROM sms_consent/.test(sql)) return [{ id: '22222222-2222-4222-8222-222222222222' }];
    if (/FROM sms_send_log/.test(sql)) return [{ id: '33333333-3333-4333-8333-333333333333' }];
    if (/INSERT INTO sms_click_event/.test(sql)) return [];
    throw new Error(`unexpected SQL in test: ${sql}`);
  },
  getPool: () => {
    throw new Error('no pool in this test');
  },
}));

import {
  FALLBACK_DESTINATION,
  GONE_DESTINATION,
  LINK_ORIGIN_PARAM,
  PREVIEW_HOP_COOKIE,
  PREVIEW_HOP_COOKIE_MAX_AGE_S,
  PREVIEW_VIA_VALUE,
  activityPath,
  hubClickPath,
  isPreviewTap,
  markPreviewLinks,
  resolveClickThrough,
  type ClickThroughDeps,
  type SmsClickEvent,
} from '@/lib/sms/click-through';
import { GET } from '@/app/s/[shortId]/route';

const OCC_SHORT_REF = 5601;
const SUB_SHORT_REF = 42;
const ORIGIN = 'https://kidsfun.example';

function token(): string {
  return encodeShortLink(OCC_SHORT_REF, SUB_SHORT_REF);
}

beforeEach(() => {
  vi.stubEnv('SMS_SHORT_LINK_SECRET', 'test-short-link-secret');
  db.statements = [];
  db.occurrenceId = '11111111-1111-4111-8111-111111111111';
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const inserts = () => db.statements.filter((s) => s.startsWith('INSERT INTO sms_click_event'));
const subscriberReads = () => db.statements.filter((s) => /FROM sms_consent|FROM sms_send_log/.test(s));

async function tap(query: string, t = token()) {
  return GET(new Request(`${ORIGIN}/s/${t}${query}`), { params: { shortId: t } });
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) the marker and the tagger
// ─────────────────────────────────────────────────────────────────────────────
describe('(1) the preview marker', () => {
  it('is recognised ONLY by exact match', () => {
    expect(isPreviewTap('preview')).toBe(true);
    for (const v of [null, undefined, '', 'PREVIEW', 'Preview', ' preview', 'preview ', 'previews', 'hub', 'direct', 'constructor', '__proto__']) {
      expect(isPreviewTap(v as string), String(v)).toBe(false);
    }
  });

  it('tags every /s/ link in a body and nothing else', () => {
    const t1 = 'aB3dE5fG7hJ9k';
    const t2 = 'Zz0Yy1Xx2Ww3v';
    const body = [
      'This week near you:',
      `1. Swim https://kidsfunapp.ca/s/${t1}`,
      `2. Art https://kidsfunapp.ca/s/${t2}.`,
      'Prefs: https://kidsfunapp.ca/u/#############',
      'Join: https://kidsfunapp.ca/sms/start  STOP to end',
    ].join('\n');
    const out = markPreviewLinks(body);
    expect(out).toContain(`/s/${t1}?${LINK_ORIGIN_PARAM}=${PREVIEW_VIA_VALUE}`);
    expect(out).toContain(`/s/${t2}?${LINK_ORIGIN_PARAM}=${PREVIEW_VIA_VALUE}.`);
    expect(out).toContain('/u/#############\n'); // the masked preferences link is untouched
    expect(out).toContain('/sms/start  STOP'); // not an /s/ link
    expect(out.match(/via=preview/g)).toHaveLength(2);
  });

  it('does not double-tag, and leaves a link that already has a query alone', () => {
    const once = markPreviewLinks('x /s/abc123 y');
    expect(markPreviewLinks(once)).toBe(once);
    expect(markPreviewLinks('x /s/abc123?via=hub y')).toBe('x /s/abc123?via=hub y');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) the decision table
// ─────────────────────────────────────────────────────────────────────────────
function spiedDeps() {
  const calls = { subscriber: 0, sendLog: 0 };
  const clicks: SmsClickEvent[] = [];
  const deps: ClickThroughDeps = {
    findOccurrenceIdByShortRef: async (ref) => (ref === OCC_SHORT_REF ? 'occ-1' : null),
    findSubscriberIdByShortRef: async () => {
      calls.subscriber += 1;
      return 'sub-1';
    },
    findSendLogIdForClick: async () => {
      calls.sendLog += 1;
      return 'log-1';
    },
    recordClick: async (e) => {
      clicks.push(e);
    },
  };
  return { calls, clicks, deps };
}

describe('(2) resolveClickThrough with countClick:false', () => {
  it('🔴 same outcome and destination as a real tap, but no reads of the subscriber and no row', async () => {
    const real = spiedDeps();
    const preview = spiedDeps();
    const a = await resolveClickThrough(token(), { ...real.deps });
    const b = await resolveClickThrough(token(), { ...preview.deps, countClick: false });
    expect(b.outcome).toBe(a.outcome);
    expect(b.destination).toBe(a.destination);
    expect(b.destination).toBe(activityPath('occ-1'));
    expect(a.clickLogged).toBe(true);
    expect(real.clicks).toHaveLength(1);
    expect(b.clickLogged).toBe(false);
    expect(preview.clicks).toHaveLength(0);
    expect(preview.calls).toEqual({ subscriber: 0, sendLog: 0 });
  });

  it('defaults to counting (a missing option is a real tap)', async () => {
    const d = spiedDeps();
    expect((await resolveClickThrough(token(), d.deps)).clickLogged).toBe(true);
  });

  it('🔴 does not relax verification: a tampered token is still the fallback', async () => {
    const d = spiedDeps();
    const t = token();
    const tampered = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
    const r = await resolveClickThrough(tampered, { ...d.deps, countClick: false });
    expect(r).toMatchObject({ outcome: 'invalid_token', destination: FALLBACK_DESTINATION, clickLogged: false });
  });

  it('a gone activity is still the gone interstitial', async () => {
    const d = spiedDeps();
    const r = await resolveClickThrough(token(), { ...d.deps, findOccurrenceIdByShortRef: async () => null, countClick: false });
    expect(r).toMatchObject({ outcome: 'occurrence_gone', destination: GONE_DESTINATION });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) GET /s/[shortId] end to end, real readers over the fake DB
// ─────────────────────────────────────────────────────────────────────────────
describe('(3) the route: a preview tap counts nothing', () => {
  it('control: a normal tap reads the subscriber and INSERTs one sms_click_event (direct)', async () => {
    const res = await tap('');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/activity/${db.occurrenceId}`);
    expect(inserts()).toHaveLength(1);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('🔴 ?via=preview: same 307 to the same place, NO insert, NO subscriber/send-log read', async () => {
    const res = await tap(`?${LINK_ORIGIN_PARAM}=${PREVIEW_VIA_VALUE}`);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/activity/${db.occurrenceId}`);
    expect(inserts()).toHaveLength(0);
    expect(subscriberReads()).toHaveLength(0);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('🔴 the preview cookie: this activity path only, 60s, HttpOnly, SameSite=Lax, Secure on https, value "1"', async () => {
    const res = await tap('?via=preview');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`^${PREVIEW_HOP_COOKIE}=1;`));
    expect(cookie).toContain(`Path=/activity/${db.occurrenceId}`);
    expect(cookie).toContain(`Max-Age=${PREVIEW_HOP_COOKIE_MAX_AGE_S}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('the hub origin is unchanged: ?via=hub is still counted, as hub, with no cookie', async () => {
    const t = token();
    const res = await GET(new Request(`${ORIGIN}${hubClickPath(t)}`), { params: { shortId: t } });
    expect(res.headers.get('location')).toBe(`${ORIGIN}/activity/${db.occurrenceId}`);
    expect(inserts()).toHaveLength(1);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('(3b) ABUSE: what appending ?via=preview can and cannot do', () => {
  it('🔴 no signature bypass: a tampered token + via=preview → fallback, no insert, no cookie', async () => {
    const t = token();
    const tampered = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
    const res = await tap('?via=preview', tampered);
    expect(res.headers.get('location')).toBe(`${ORIGIN}${FALLBACK_DESTINATION}`);
    expect(inserts()).toHaveLength(0);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('🔴 no open redirect: extra params are ignored, destination stays on the request origin', async () => {
    for (const q of [
      '?via=preview&next=https://evil.example/',
      '?via=preview&redirect=//evil.example',
      '?next=https://evil.example/&via=preview',
      '?via=preview&url=javascript:alert(1)',
    ]) {
      db.statements = [];
      const res = await tap(q);
      const loc = res.headers.get('location') ?? '';
      expect(loc, q).toBe(`${ORIGIN}/activity/${db.occurrenceId}`);
      expect(loc, q).not.toContain('evil');
    }
  });

  it('🔴 the marker never travels: no query string in Location', async () => {
    const res = await tap('?via=preview');
    expect(res.headers.get('location')).not.toContain('?');
    expect(res.headers.get('location')).not.toContain('via');
  });

  it('only the exact value suppresses: ?via=PREVIEW / ?via=preview%20 / junk are counted as real taps', async () => {
    for (const q of ['?via=PREVIEW', '?via=preview%20', '?via=previewx', '?via=', '?via=constructor']) {
      db.statements = [];
      const res = await tap(q);
      expect(inserts(), q).toHaveLength(1);
      expect(res.headers.get('set-cookie'), q).toBeNull();
    }
  });

  it('repeated ?via: the FIRST value decides (URLSearchParams.get), consistently for count and cookie', async () => {
    db.statements = [];
    const hubFirst = await tap('?via=hub&via=preview');
    expect(inserts()).toHaveLength(1);
    expect(hubFirst.headers.get('set-cookie')).toBeNull();
    db.statements = [];
    const previewFirst = await tap('?via=preview&via=hub');
    expect(inserts()).toHaveLength(0);
    expect(previewFirst.headers.get('set-cookie')).toContain(PREVIEW_HOP_COOKIE);
  });

  it('a gone activity + via=preview: the interstitial, no insert, and no cookie (nothing to suppress)', async () => {
    db.occurrenceId = null;
    const res = await tap('?via=preview');
    expect(res.headers.get('location')).toBe(`${ORIGIN}${GONE_DESTINATION}`);
    expect(inserts()).toHaveLength(0);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('the only SQL a preview tap issues is the occurrence lookup — no write of any kind', async () => {
    await tap('?via=preview');
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]).toMatch(/^SELECT id FROM activity_occurrence/);
  });
});
