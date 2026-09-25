// tests/admin/viewer-render-db.test.ts — the read-only 'viewer' over a REAL database, FULL PAGE RENDERS.
//
// Adopted (2026-09-25) from the independent QA probe by session a210642e
// (documents/kids-fun/qa-admin-pr0-pr1-pr2-2026-09-25.md, finding M1). QA showed that a one-line
// regression — /admin/dashboard rendering the raw `data.corrections` instead of the role-filtered
// list — left the author's unit suite GREEN (its check was a source regex on the assignment line)
// and was caught only by rendering the page over real data. This is that render, made permanent.
//
// Only the Supabase session lookup is mocked (and the dashboard snapshot is forced to compute LIVE, so
// a stale stored snapshot can never stand in for the CANARY). requireAdmin, the gate, the audit,
// every read model and every server action are real. CANARY personal data is planted; the viewer's
// HTML must contain none of it, and the superadmin's HTML MUST contain some (positive control: proves
// the test can see what it is looking for on each surface).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { closePool, query } from '../../lib/db/client';
import { phoneHash } from '../../lib/sms/phone-hash';

const hasDb = Boolean(process.env.DATABASE_URL);

const session = vi.hoisted(() => ({ user: null as null | { userId: string; email: string | null } }));
vi.mock('../../lib/db/session-user', () => ({ getRequestUser: () => Promise.resolve(session.user) }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock('../../lib/admin/snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/admin/snapshot')>();
  return {
    ...actual,
    snapshotOrCompute: async <T,>(_key: string, compute: () => Promise<T>) => ({
      payload: await compute(),
      computedAt: null,
      age: null,
    }),
  };
});

const M = `test-viewer-render-${Date.now()}`;
const PHONE = '+16045550188';
const PHONE_FORMS = ['+16045550188', '6045550188', '604-555-0188', '(604) 555-0188', '604 555 0188', '555-0188'];
const POSTAL = 'X0E 1Q7';
const YEARS = [2012, 2020];
const NOTE = 'RENDERCANARY-note Quillon-Vexbridge takes the 4pm class';
const REPORTER = 'rendercanary-reporter-zz9';

const ids = { viewer: '', superadmin: '', consent: '', source: '', series: '', occ: '' };
const as = (uid: string) => {
  session.user = { userId: uid, email: null };
};
async function html(p: Promise<unknown>) {
  return renderToStaticMarkup((await p) as ReactElement);
}
function piiHits(h: string): string[] {
  const noIds = h.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
  const hits = [...PHONE_FORMS, POSTAL, POSTAL.replace(' ', ''), NOTE, 'Quillon', REPORTER].filter((n) => noIds.includes(n));
  if (/\bX0E\b/.test(noIds)) hits.push('FSA X0E');
  for (const y of YEARS) if (noIds.includes(String(y))) hits.push(`year ${y}`);
  return hits;
}

// One pool for the whole file: closed once, after BOTH describe blocks.
afterAll(async () => {
  if (hasDb) await closePool();
});

const PAGES: Array<[string, () => Promise<{ default: (p: never) => Promise<unknown> }>, unknown]> = [
  ['/admin/sms-subscribers', () => import('../../app/admin/sms-subscribers/page') as never, {}],
  ['/admin/sms-subscribers/[id]', () => import('../../app/admin/sms-subscribers/[id]/page') as never, 'DETAIL'],
  ['/admin/sms-engagement', () => import('../../app/admin/sms-engagement/page') as never, { searchParams: {} }],
  ['/admin/corrections', () => import('../../app/admin/corrections/page') as never, { searchParams: {} }],
  ['/admin/dashboard', () => import('../../app/admin/dashboard/page') as never, {}],
  ['/admin/data-health', () => import('../../app/admin/data-health/page') as never, {}],
];
const props = (p: unknown, preview = false) =>
  p === 'DETAIL' ? { params: { id: ids.consent }, searchParams: preview ? { preview: '1' } : {} } : p;

describe.skipIf(!hasDb)('viewer: full renders of the 6 PII surfaces over a real database', () => {
  beforeAll(async () => {
    vi.stubEnv('SMS_PHONE_HASH_SALT', 'test-salt-viewer-render');
    const mk = async () =>
      (await query<{ id: string }>(`INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`))[0].id;
    ids.viewer = await mk();
    ids.superadmin = await mk();
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1,'viewer',true),($2,'superadmin',true)`, [
      ids.viewer,
      ids.superadmin,
    ]);
    const [c] = await query<{ id: string }>(
      `INSERT INTO sms_consent (phone_number, status, consent_method, consent_text_version, consent_timestamp, postal_code, birth_years)
       VALUES ($1,'active','web_form',$2, now() - interval '2 hours', $3, $4::int[]) RETURNING id`,
      [PHONE, M, POSTAL, YEARS]
    );
    ids.consent = c.id;
    await query(
      `INSERT INTO sms_send_log (subscriber_id, phone_hash, send_type, outcome, consent_text_version, created_at)
       VALUES ($1::uuid,$2,'weekly','sent',$3, now() - interval '1 hour')`,
      [ids.consent, phoneHash(PHONE), M]
    );
    const [s] = await query<{ id: string }>(
      `INSERT INTO source (family,name,authority_tier,ingestion_method,terms_status)
       VALUES ('test_viewer_render','Viewer Render Source','official','auto','allowed') RETURNING id`
    );
    ids.source = s.id;
    const [se] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ('Viewer Render Series',$1) RETURNING id`,
      [ids.source]
    );
    ids.series = se.id;
    const [o] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state, confidence_label)
       VALUES ($1,'Viewer Render Listing', now() + interval '10 days','needs_review','unscored') RETURNING id`,
      [ids.series]
    );
    ids.occ = o.id;
    await query(`INSERT INTO correction_report (occurrence_id, reporter, issue_type, note) VALUES ($1,$2,'wrong_time',$3)`, [
      ids.occ,
      REPORTER,
      NOTE,
    ]);
  });

  afterAll(async () => {
    const a = [ids.viewer, ids.superadmin].filter(Boolean);
    await query(`DELETE FROM admin_audit_log WHERE admin_user_id = ANY($1::uuid[])`, [a]);
    await query(`DELETE FROM admin_user WHERE user_id = ANY($1::uuid[])`, [a]);
    await query(`DELETE FROM user_profile WHERE id = ANY($1::uuid[])`, [a]);
    await query(`DELETE FROM sms_send_log WHERE consent_text_version = $1`, [M]);
    await query(`DELETE FROM sms_consent WHERE consent_text_version = $1`, [M]);
    if (ids.occ) await query(`DELETE FROM correction_report WHERE occurrence_id = $1`, [ids.occ]);
    if (ids.occ) await query(`DELETE FROM activity_occurrence WHERE id = $1`, [ids.occ]);
    if (ids.series) await query(`DELETE FROM activity_series WHERE id = $1`, [ids.series]);
    if (ids.source) await query(`DELETE FROM source WHERE id = $1`, [ids.source]);
    vi.unstubAllEnvs();
  });

  for (const [name, load, p] of PAGES) {
    it(`superadmin sees the CANARY on ${name} (positive control)`, async () => {
      as(ids.superadmin);
      const h = await html((await load()).default(props(p) as never));
      expect(piiHits(h).length, `${name} superadmin hits`).toBeGreaterThan(0);
    });

    it(`🔴 viewer sees NO CANARY on ${name}`, async () => {
      as(ids.viewer);
      const h = await html((await load()).default(props(p, true) as never));
      expect(piiHits(h), name).toEqual([]);
    });
  }

  it('🔴 dashboard + data-health: the viewer is told a note exists without seeing it', async () => {
    as(ids.viewer);
    for (const [, load] of PAGES.filter(([n]) => n === '/admin/dashboard' || n === '/admin/data-health')) {
      const h = await html((await load()).default({} as never));
      expect(h).toContain('(note hidden — read-only role)');
    }
  });

  it('🔴 viewer: detail ?preview=1 is refused, with no preview link', async () => {
    as(ids.viewer);
    const d = await html(
      (await import('../../app/admin/sms-subscribers/[id]/page')).default({
        params: { id: ids.consent },
        searchParams: { preview: '1' },
      } as never)
    );
    expect(d).toContain('not available to a read-only role');
    expect(d).not.toContain('?preview=1');
  });
});

describe.skipIf(!hasDb)('viewer: the 9 real server actions change nothing (row counts + content hashes)', () => {
  const TABLES = ['correction_report', 'activity_occurrence', 'source', 'region', 'category', 'synonym_alias', 'admin_audit_log'];
  const local = { viewer: '', source: '', series: '', occ: '', report: '' };

  beforeAll(async () => {
    const [u] = await query<{ id: string }>(`INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`);
    local.viewer = u.id;
    await query(`INSERT INTO admin_user (user_id, role, active) VALUES ($1,'viewer',true)`, [local.viewer]);
    const [s] = await query<{ id: string }>(
      `INSERT INTO source (family,name,authority_tier,ingestion_method,terms_status)
       VALUES ('test_viewer_actions','Viewer Actions Source','official','auto','allowed') RETURNING id`
    );
    local.source = s.id;
    const [se] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ('Viewer Actions Series',$1) RETURNING id`,
      [local.source]
    );
    local.series = se.id;
    const [o] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (series_id, activity_name, start_datetime_utc, status_state, confidence_label)
       VALUES ($1,'Viewer Actions Listing', now() + interval '10 days','needs_review','unscored') RETURNING id`,
      [local.series]
    );
    local.occ = o.id;
    const [r] = await query<{ id: string }>(
      `INSERT INTO correction_report (occurrence_id, reporter, issue_type, note) VALUES ($1,'anon','wrong_time','x') RETURNING id`,
      [local.occ]
    );
    local.report = r.id;
  });

  afterAll(async () => {
    await query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [local.viewer]);
    await query(`DELETE FROM admin_user WHERE user_id = $1`, [local.viewer]);
    await query(`DELETE FROM user_profile WHERE id = $1`, [local.viewer]);
    await query(`DELETE FROM correction_report WHERE occurrence_id = $1`, [local.occ]);
    await query(`DELETE FROM activity_occurrence WHERE id = $1`, [local.occ]);
    await query(`DELETE FROM activity_series WHERE id = $1`, [local.series]);
    await query(`DELETE FROM source WHERE id = $1`, [local.source]);
  });

  async function state() {
    const out: Record<string, string> = {};
    for (const t of TABLES) {
      const [r] = await query<{ n: string; h: string }>(
        `SELECT count(*)::text AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)),'') AS h FROM ${t} t`
      );
      out[t] = `${r.n}:${r.h}`;
    }
    return out;
  }
  function fd(o: Record<string, string>) {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  }

  it('🔴 every action refuses the viewer with a realistic payload, and no table changes', async () => {
    const calls: Array<[string, string, FormData]> = [
      ['corrections/actions', 'resolveCorrectionAction', fd({ reportId: local.report, statusState: 'cancelled', note: 'x' })],
      ['listings/actions', 'createManualListingAction', fd({ sourceId: local.source, activityName: 'Viewer listing', startDate: '2026-12-01', startTime: '10:00' })],
      ['qa-queue/actions', 'reviewAction', fd({ occurrenceId: local.occ, intent: 'confirm', note: 'x' })],
      ['qa-queue/actions', 'dedupReviewAction', fd({ duplicateId: local.occ, canonicalId: local.occ, intent: 'reject', note: 'x' })],
      ['sources/actions', 'saveSourceAction', fd({ id: local.source, name: 'Renamed by viewer', family: 'test_viewer_actions' })],
      ['taxonomy/actions', 'saveRegionAction', fd({ slug: 'viewer-region', name: 'Viewer Region' })],
      ['taxonomy/actions', 'saveCategoryAction', fd({ slug: 'viewer-cat', name: 'Viewer Cat' })],
      ['taxonomy/actions', 'saveAliasAction', fd({ alias: 'viewer-alias', categorySlug: 'viewer-cat' })],
      ['taxonomy/actions', 'deleteAliasAction', fd({ alias: 'viewer-alias', id: '1' })],
    ];
    as(local.viewer);
    const before = await state();
    for (const [file, name, form] of calls) {
      const mod = (await import(/* @vite-ignore */ `../../app/admin/${file}`)) as Record<
        string,
        (f: FormData) => Promise<{ ok: boolean; message?: string }>
      >;
      const r = await mod[name](form);
      expect(r.ok, name).toBe(false);
      expect(r.message, name).toMatch(/Read-only access cannot make changes/);
    }
    expect(await state()).toEqual(before);
  });
});
