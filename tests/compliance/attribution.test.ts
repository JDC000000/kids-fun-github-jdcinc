// tests/compliance/attribution.test.ts — G-T35-3 (Round 18 / Task Z, ‹L3›).
//
// Compliance guardrail: attribute-and-summarise, plus crawl-politeness for every
// LIVE source. Two obligations, verified against real code:
//
//   1. Attribute & summarise — rendered activity cards carry factual snippets +
//      a link back to the official source, NOT wholesale-republished editorial
//      copy. Verified by (a) rendering the real production card
//      (app/preview/_components/ActivityCard — the same component /search reuses)
//      and asserting the source link + honest CTA are present while an injected
//      editorial body is NOT surfaced on the card face; and (b) the ingestion
//      contract itself — every StructuredRecord an adapter emits requires a
//      `sourceUrl` and carries NO editorial-body field, so there is structurally
//      no channel to republish an article. Fact-level provenance (source URL per
//      displayed fact) is DB-wired via recordProvenance().
//
//   2. Crawl-politeness is REAL, not merely asserted — an identified, contactable
//      User-Agent on every live request; a working per-source rate limiter;
//      403/429 backoff; conditional (ETag/If-Modified-Since) requests; and a
//      cadence-gated scheduler that only enqueues terms+robots-approved sources.
//
// NOTE (audit finding, see docs/source-register.md): the RateLimiter / backoff /
// conditional-request PRIMITIVES are correct and tested here, but are not yet
// wired into the two live adapters' fetch() paths — those send the identified UA
// inline and rely on the scheduler's daily/near-date cadence + per-request item
// caps for politeness. This test asserts what is TRUE today; the wiring gap is
// documented for human review rather than silently passed.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ActivityCard } from '../../app/preview/_components/ActivityCard';
import { ACTIVITIES } from '../../app/preview/_data/fixtures';
import {
  RateLimiter,
  recordResponse,
  isDisabled,
  clearBackoffState,
  buildConditionalHeaders,
  USER_AGENT,
} from '../../worker/core/politeness';
import { recordProvenance } from '../../worker/core/provenance';
import { LibraryAdapter, LIBRARY_SYSTEMS } from '../../worker/adapters/library';
import { CityCalendarAdapter, CITY_CALENDARS } from '../../worker/adapters/citycalendar';
import { VenueAdapter, getVenue } from '../../worker/adapters/venue';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
  clearBackoffState();
});

// ── 1a. rendered card: factual facets + source link, no republished body ──────

describe('G-T35-3 rendered activity card attributes to source and summarises', () => {
  const WHOLESALE_BODY =
    'WHOLESALE_EDITORIAL_BODY_MUST_NOT_BE_REPUBLISHED ' + 'lorem ipsum dolor sit amet '.repeat(40);

  it('external card renders a safe source link + honest CTA, not the editorial body', () => {
    const base = ACTIVITIES[0];
    const activity = {
      ...base,
      sourceName: 'vancouver.ca',
      detailUrl: 'https://vancouver.ca/parks-recreation/storytime/instance-987',
      // Simulate an upstream editorial blob riding along on the record; the card
      // must summarise (facts only), never dump this onto the face.
      descriptionSnippet: WHOLESALE_BODY,
    };
    const html = renderToStaticMarkup(createElement(ActivityCard, { activity }));

    // Source link — present, external, and safe (rel=noreferrer noopener, new tab).
    expect(html).toContain('href="https://vancouver.ca/parks-recreation/storytime/instance-987"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('target="_blank"');
    // Honest attribution CTA naming the source.
    expect(html).toContain('View on vancouver.ca');
    // Factual facets appear (the summary a parent scans).
    expect(html).toContain(base.activityName);
    expect(html).toContain(base.venue);
    // The wholesale editorial body is NOT republished on the card face.
    expect(html).not.toContain('WHOLESALE_EDITORIAL_BODY_MUST_NOT_BE_REPUBLISHED');
  });

  it('internal card (no external detailUrl) links to the in-app detail, still naming the source', () => {
    const base = ACTIVITIES[0];
    const activity = { ...base, sourceName: 'vpl.ca', detailUrl: undefined };
    const html = renderToStaticMarkup(createElement(ActivityCard, { activity }));
    expect(html).toContain(`/preview/${base.id}`);
    // FreshnessStamp surfaces the source name on the card either way.
    expect(html).toContain('vpl.ca');
  });
});

// ── 1b. ingestion contract: every fact has a source URL, no republication path ─

describe('G-T35-3 ingestion contract carries source links, not editorial bodies', () => {
  const BODY_FIELDS = ['description', 'descriptionText', 'descriptionSnippet', 'body', 'html', 'content'];

  async function recordsFor(adapter: { fetch(): Promise<unknown[]>; extract(raw: unknown[]): unknown }) {
    return (await adapter.extract(await adapter.fetch())) as Array<Record<string, unknown>>;
  }

  it('library adapter emits a sourceUrl per record and no editorial-body field', async () => {
    const adapter = new LibraryAdapter(LIBRARY_SYSTEMS.find((s) => s.systemKey === 'vpl')!);
    const records = await recordsFor(adapter);
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(typeof r.sourceUrl).toBe('string');
      expect(String(r.sourceUrl)).toMatch(/^https?:\/\//);
      for (const f of BODY_FIELDS) expect(r, `no ${f} republication field`).not.toHaveProperty(f);
      // Free-text facets are short summaries, never article-length copy.
      for (const key of ['title', 'venueName', 'ageText']) {
        const v = r[key];
        if (typeof v === 'string') expect(v.length, `${key} is a short fact`).toBeLessThanOrEqual(300);
      }
    }
  });

  it('city-calendar adapter emits a sourceUrl per record and no editorial-body field', async () => {
    const adapter = new CityCalendarAdapter(CITY_CALENDARS[0]);
    const records = await recordsFor(adapter);
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(typeof r.sourceUrl).toBe('string');
      expect(String(r.sourceUrl)).toMatch(/^https?:\/\//);
      for (const f of BODY_FIELDS) expect(r, `no ${f} republication field`).not.toHaveProperty(f);
    }
  });

  it('venue adapter emits a sourceUrl per record and no editorial-body field', async () => {
    const adapter = new VenueAdapter(getVenue('vancouver-aquarium')!);
    const records = await recordsFor(adapter);
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(typeof r.sourceUrl).toBe('string');
      expect(String(r.sourceUrl)).toMatch(/^https?:\/\//);
      for (const f of BODY_FIELDS) expect(r, `no ${f} republication field`).not.toHaveProperty(f);
      // open_hours_state / title are short facts, never article-length copy.
      for (const key of ['title', 'openHoursState', 'ageText']) {
        const v = r[key];
        if (typeof v === 'string') expect(v.length, `${key} is a short fact`).toBeLessThanOrEqual(300);
      }
    }
  });

  it('recordProvenance persists the source URL for every displayed fact', async () => {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const fakePool = {
      query: async (sql: string, params: unknown[]) => {
        captured.push({ sql, params });
        return { rows: [] };
      },
    };
    await recordProvenance(fakePool as never, [
      { occurrenceId: 'occ-1', field: 'activity_name', sourceUrl: 'https://vancouver.ca/x', sourceFamily: 'city_calendar' },
      { occurrenceId: 'occ-1', field: 'start_datetime_utc', sourceUrl: 'https://vancouver.ca/x', sourceFamily: 'city_calendar' },
    ]);
    expect(captured.length).toBe(2);
    for (const c of captured) {
      expect(c.sql).toMatch(/insert\s+into\s+provenance/i);
      expect(c.params).toContain('https://vancouver.ca/x'); // source_url persisted per fact
    }
  });
});

// ── 2. crawl-politeness primitives are real ───────────────────────────────────

describe('G-T35-3 crawl-politeness controls are real', () => {
  it('the ingestion User-Agent is identified and contactable, not a browser spoof', () => {
    expect(USER_AGENT).toMatch(/KidsFunBot/i);
    expect(USER_AGENT, 'carries a bot info URL').toMatch(/\+https?:\/\//);
    expect(USER_AGENT, 'carries a contact').toMatch(/contact/i);
    expect(USER_AGENT).not.toMatch(/Mozilla/i);
  });

  it('RateLimiter enforces a per-source minimum interval', async () => {
    let clock = 0;
    const now = () => clock;
    const slept: number[] = [];
    const sleepImpl = async (ms: number) => {
      slept.push(ms);
      clock += ms;
    };
    const rl = new RateLimiter({ requestsPerMinute: 60 }); // 1000ms floor between requests
    await rl.wait(now, sleepImpl); // first request — no wait
    await rl.wait(now, sleepImpl); // immediate second — must wait the full interval
    expect(slept).toEqual([1000]);
  });

  it('403 and 429 trip backoff; a 2xx clears it', () => {
    const id = 'compliance-src';
    clearBackoffState();
    expect(isDisabled(id)).toBe(false);
    recordResponse(id, 429);
    expect(isDisabled(id), '429 disables').toBe(true);
    recordResponse(id, 200);
    expect(isDisabled(id), '2xx re-enables').toBe(false);
    recordResponse(id, 403);
    expect(isDisabled(id), '403 disables').toBe(true);
  });

  it('conditional requests carry ETag/If-Modified-Since + the identified UA', () => {
    const headers = buildConditionalHeaders({ etag: 'W/"abc"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' });
    expect(headers['If-None-Match']).toBe('W/"abc"');
    expect(headers['If-Modified-Since']).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(headers['User-Agent']).toMatch(/KidsFunBot/i);
  });

  it('each live adapter sends an identified UA on its real request', async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (_input: unknown, init?: unknown) => {
      const h = ((init as { headers?: Record<string, string> })?.headers ?? {}) as Record<string, string>;
      const ua = h['user-agent'] ?? h['User-Agent'];
      if (ua) seen.push(ua);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);

    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'vpl';
    process.env.KIDS_FUN_LIVE_CITY_CALENDARS = 'vancouver';
    // library RSS path returns text; a JSON body is harmless (parses to 0 items).
    await new LibraryAdapter(LIBRARY_SYSTEMS.find((s) => s.systemKey === 'vpl')!).fetch();
    await new CityCalendarAdapter(CITY_CALENDARS[0]).fetch();

    expect(seen.length, 'both live sources issued an identified request').toBe(2);
    for (const ua of seen) {
      expect(ua).toMatch(/KidsFunBot/i);
      expect(ua).toMatch(/\+https?:\/\/|contact/i);
      expect(ua).not.toMatch(/Mozilla/i);
    }
  });

  it('the scheduler only enqueues terms+robots-approved sources, at cadence', () => {
    const scheduler = readFileSync(resolve(process.cwd(), 'worker/scheduler/tiered.ts'), 'utf8');
    expect(scheduler).toMatch(/terms_status\s+IN\s*\(\s*'allowed',\s*'summarise_only'\s*\)/i);
    expect(scheduler).toMatch(/robots_status\s*=\s*'allowed'/i);
    expect(scheduler).toMatch(/next_check_at/i); // cadence gate — nothing re-fetched before it's due
  });

  it('the three live sources are declared with a crawl cadence in the registry', () => {
    const seed = readFileSync(resolve(process.cwd(), 'supabase/seeds/sources.sql'), 'utf8');
    for (const name of [
      'Vancouver Public Library BiblioEvents',
      'Richmond Public Library BiblioEvents',
      'City of Vancouver events calendar',
    ]) {
      expect(seed).toContain(name);
    }
    // Library + city rows declare a baseline cadence interval (the polite floor).
    expect(seed).toMatch(/library_bibliocommons[\s\S]*?'1 day'/);
    expect(seed).toMatch(/city_calendar[\s\S]*?'1 day'/);
  });
});
