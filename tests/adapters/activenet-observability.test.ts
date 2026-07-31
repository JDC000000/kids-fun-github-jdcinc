// tests/adapters/activenet-observability.test.ts — H6 FIX A: the ActiveNet client's
// per-request/retry logging.
//
// WHY THIS FILE EXISTS. The first real live Vancouver run took NINE MINUTES and emitted
// nothing at all between "job claimed" and "operator killed it". From `flyctl logs` there
// was no way to distinguish a healthy-but-slow run (23 calendars ≈ 47 requests against a
// 3-second politeness floor is minutes of deliberate sleeping before the portal has
// answered anything) from a wedged one — so the run was killed on suspicion, which then
// tripped the shutdown bug covered by tests/scheduler/shutdown.test.ts.
//
// Logging is easy to add and easier to silently delete, and nothing else in the suite
// would notice. So each assertion below names the specific question an operator was
// unable to answer during the incident, and fails if the line that answers it goes away.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RequestBudget,
  fetchTenant,
  ENDPOINTS,
  PortalBlockedError,
  PortalRateLimitedError,
  RequestCapExceededError,
} from '../../worker/adapters/activenet/client';
import { getTenantConfig } from '../../worker/adapters/activenet/config';
import { clearPolicyState } from '../../worker/health/policy';

const FIXTURES = join(process.cwd(), 'worker/adapters/activenet/__fixtures__');
const VANCOUVER = getTenantConfig('vancouver')!;
/** One calendar keeps each run's request count exact and its log short. */
const ONE_CALENDAR_TENANT = { ...VANCOUVER, dropInCalendarIds: [5] };
const WINDOW = { startDate: '2026-08-03', endDate: '2026-08-09' };
const NO_SLEEP = { sleepImpl: async () => {} };

function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

/** Answers the four endpoints from the captured payloads; `status` forces a failure mode. */
function stubPortal(status?: number, headers?: Record<string, string>) {
  return (async (input: unknown) => {
    const url = String(input);
    if (status && status !== 200) return new Response('{}', { status, headers });
    let body: unknown = {};
    if (url.includes(ENDPOINTS.calendars)) body = fixture('vancouver.calendars.json');
    else if (url.includes(ENDPOINTS.filters)) body = fixture('vancouver.filters.calendar-5.json');
    else if (url.includes(ENDPOINTS.events)) body = fixture('vancouver.events.calendar-5.json');
    else if (url.includes(ENDPOINTS.centerDetails)) body = fixture('vancouver.centerdetails.json');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

let lines: string[];

beforeEach(() => {
  lines = [];
  const capture = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  clearPolicyState();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearPolicyState();
});

const matching = (re: RegExp): string[] => lines.filter((l) => re.test(l));

// ── per-request visibility ───────────────────────────────────────────────────────────

describe('H6 FIX A — every request says what it is doing', () => {
  it('logs a start line per request carrying endpoint, attempt and budget spend', async () => {
    await fetchTenant(ONE_CALENDAR_TENANT, WINDOW, {
      budget: new RequestBudget('vancouver', 20),
      fetchImpl: stubPortal(),
      ...NO_SLEEP,
    });

    const starts = matching(/\[activenet:client\].*start /);
    // calendars + filters + events + centerdetails.
    expect(starts).toHaveLength(4);
    for (const endpoint of ['calendars', 'filters', 'events', 'centerDetails']) {
      expect(starts.some((l) => l.includes(` ${endpoint} `)), `no start line for ${endpoint}`).toBe(true);
    }
    // "How much of the tenant's hard cap has this run already spent?" was unanswerable.
    expect(starts[0]).toMatch(/vancouver calendars attempt 1\/3 req 1\/20 start/);
    expect(starts[3]).toMatch(/req 4\/20/);
  });

  it('logs a completion line with status and duration — the slow/stuck discriminator', async () => {
    await fetchTenant(ONE_CALENDAR_TENANT, WINDOW, {
      budget: new RequestBudget('vancouver', 20),
      fetchImpl: stubPortal(),
      ...NO_SLEEP,
    });

    const done = matching(/status=200 in \d+ms/);
    expect(done).toHaveLength(4);
    // Duration is the whole point: a request that returns in 300ms and one that burns its
    // 15s deadline look identical without it.
    expect(done[0]).toMatch(/\[activenet:client\] vancouver calendars .* status=200 in \d+ms/);
  });

  it('logs each retry with the status that caused it and the backoff being taken', async () => {
    const slept: number[] = [];
    await expect(
      fetchTenant(ONE_CALENDAR_TENANT, WINDOW, {
        budget: new RequestBudget('vancouver', 20),
        fetchImpl: stubPortal(503),
        sleepImpl: async (ms) => {
          slept.push(ms);
        },
      })
    ).rejects.toThrow(/503/);

    const retries = matching(/HTTP 503 transient — retrying in/);
    // Two bounded retries, and the log must say how long each one parked the run for —
    // "many individual bounded retries stacking up" is a leading explanation for a
    // multi-minute run and it has to be visible, not inferred.
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatch(/retrying in 2000ms/);
    expect(retries[1]).toMatch(/retrying in 4000ms/);
    expect(matching(/attempts exhausted, giving up/)).toHaveLength(1);
  });

  it('logs a thrown request (blown deadline / armed backoff) instead of failing silently', async () => {
    const boom = (async () => {
      throw new Error('socket hang up');
    }) as typeof fetch;
    await expect(
      fetchTenant(ONE_CALENDAR_TENANT, WINDOW, {
        budget: new RequestBudget('vancouver', 20),
        fetchImpl: boom,
        ...NO_SLEEP,
      })
    ).rejects.toThrow(/socket hang up/);

    // politeFetch throwing rather than answering was completely invisible at this layer.
    expect(matching(/threw after \d+ms: Error: socket hang up/)).toHaveLength(1);
  });

  it('logs the circuit-breaking statuses 403 and 429 as warnings', async () => {
    await expect(
      fetchTenant(ONE_CALENDAR_TENANT, WINDOW, {
        budget: new RequestBudget('vancouver', 20),
        fetchImpl: stubPortal(403),
        ...NO_SLEEP,
      })
    ).rejects.toBeInstanceOf(PortalBlockedError);
    expect(matching(/403 blocked — circuit-breaking the run/)).toHaveLength(1);

    lines = [];
    clearPolicyState();
    await expect(
      fetchTenant(ONE_CALENDAR_TENANT, WINDOW, {
        budget: new RequestBudget('vancouver', 20),
        fetchImpl: stubPortal(429, { 'retry-after': '120' }),
        ...NO_SLEEP,
      })
    ).rejects.toBeInstanceOf(PortalRateLimitedError);
    expect(matching(/429 rate-limited \(retry-after 120\) — circuit-breaking the run/)).toHaveLength(1);
  });

  it('logs the request cap aborting a run — the only thing that silently truncates it', async () => {
    await expect(
      fetchTenant(VANCOUVER, WINDOW, {
        budget: new RequestBudget('vancouver', 5),
        fetchImpl: stubPortal(),
        ...NO_SLEEP,
      })
    ).rejects.toBeInstanceOf(RequestCapExceededError);
    expect(matching(/request budget exhausted at 5 — aborting run/)).toHaveLength(1);
  });
});

// ── run-level progress ───────────────────────────────────────────────────────────────

describe('H6 FIX A — the run reports its own progress', () => {
  it('logs run start, per-calendar progress and a run summary', async () => {
    await fetchTenant({ ...VANCOUVER, dropInCalendarIds: [5] }, WINDOW, {
      budget: new RequestBudget('vancouver', 20),
      fetchImpl: stubPortal(),
      ...NO_SLEEP,
    });

    expect(matching(/\[activenet\] vancouver run start — 1 calendar\(s\), cap 20 request\(s\)/)).toHaveLength(1);
    // "How far through Vancouver's 23 calendars did the nine minutes get us?" — this line.
    const perCalendar = matching(/\[activenet\] vancouver calendar 5 \(1\/1\)/);
    expect(perCalendar).toHaveLength(1);
    expect(perCalendar[0]).toMatch(/occurrence\(s\).* in \d+ms, req \d+\/20/);
    expect(matching(/\[activenet\] vancouver run complete — 1 calendar\(s\)/)).toHaveLength(1);
    // 1 warning = the calendar-drift canary (this tenant is pinned to one of its 23
    // calendars for the test), which is itself part of what the summary must surface.
    expect(matching(/run complete/)[0]).toMatch(/4\/20 request\(s\), 1 warning\(s\) in \d+s/);
  });

  it('the per-calendar line counts calendars, so a stalled run shows where it stalled', async () => {
    await fetchTenant({ ...VANCOUVER, dropInCalendarIds: [1, 5] }, WINDOW, {
      budget: new RequestBudget('vancouver', 20),
      fetchImpl: stubPortal(),
      ...NO_SLEEP,
    });
    expect(matching(/calendar 1 \(1\/2\)/)).toHaveLength(1);
    expect(matching(/calendar 5 \(2\/2\)/)).toHaveLength(1);
  });
});

// ── discipline ───────────────────────────────────────────────────────────────────────

describe('H6 FIX A — the logging stays cheap and safe', () => {
  it('never logs response bodies or event content', async () => {
    await fetchTenant(ONE_CALENDAR_TENANT, WINDOW, {
      budget: new RequestBudget('vancouver', 20),
      fetchImpl: stubPortal(),
      ...NO_SLEEP,
    });

    const events = fixture<{ body: { center_events: Array<{ events?: Array<{ title?: string }> }> } }>(
      'vancouver.events.calendar-5.json'
    ).body.center_events;
    const titles = events.flatMap((g) => (g.events ?? []).map((e) => e.title)).filter(Boolean) as string[];
    expect(titles.length).toBeGreaterThan(0);

    const log = lines.join('\n');
    for (const title of [...new Set(titles)].slice(0, 25)) {
      expect(log, `payload content leaked into the log: ${title}`).not.toContain(title);
    }
    // No header dumps either — the request headers are the only place a UA/credential-
    // shaped value could appear, and there is no reason to print them.
    expect(log).not.toMatch(/KidsFunBot/);
  });

  it('reduces a URL embedded in an error message to its path (QA A3)', async () => {
    // FetchTimeoutError's message embeds the FULL request URL, query string and all, so
    // logging it raw would be the one line in this module that bypasses the
    // pathname-only discipline. No credentials ride that query string today; the point is
    // that a redaction added after one does is added too late.
    const leaky = (async () => {
      throw new Error(
        'fetch timed out after 15000ms on attempt 1 for activenet::vancouver at ' +
          'https://anc.ca.apm.activecommunities.com/vancouver/rest/onlinecalendar/calendars?locale=en-US&api_key=SHOULD_NOT_APPEAR'
      );
    }) as typeof fetch;

    await expect(
      fetchTenant(ONE_CALENDAR_TENANT, WINDOW, {
        budget: new RequestBudget('vancouver', 20),
        fetchImpl: leaky,
        ...NO_SLEEP,
      })
    ).rejects.toThrow(/timed out/);

    const log = lines.join('\n');
    expect(log, 'query string must not reach the log').not.toContain('SHOULD_NOT_APPEAR');
    expect(log).not.toContain('locale=en-US');
    expect(log).not.toContain('https://');
    // The useful part survives — the path still identifies which endpoint stalled.
    expect(matching(/threw after \d+ms: Error: fetch timed out/)).toHaveLength(1);
    expect(log).toContain('/vancouver/rest/onlinecalendar/calendars');
  });

  it('keeps a URL-free error message intact — redaction must not eat the diagnosis', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED 10.0.0.1:443');
    }) as typeof fetch;
    await expect(
      fetchTenant(ONE_CALENDAR_TENANT, WINDOW, {
        budget: new RequestBudget('vancouver', 20),
        fetchImpl: boom,
        ...NO_SLEEP,
      })
    ).rejects.toThrow();
    expect(matching(/threw after \d+ms: Error: ECONNREFUSED 10\.0\.0\.1:443/)).toHaveLength(1);
  });

  it('carries a consistent, greppable prefix on every line it emits', async () => {
    await fetchTenant(ONE_CALENDAR_TENANT, WINDOW, {
      budget: new RequestBudget('vancouver', 20),
      fetchImpl: stubPortal(),
      ...NO_SLEEP,
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, `unprefixed log line: ${line}`).toMatch(/^\[activenet(:client)?\] /);
    }
  });

  it('emits O(requests) lines, not O(records) — 100+ occurrences, a handful of lines', async () => {
    await fetchTenant(ONE_CALENDAR_TENANT, WINDOW, {
      budget: new RequestBudget('vancouver', 20),
      fetchImpl: stubPortal(),
      ...NO_SLEEP,
    });
    // 4 requests × (start + done) + run start + 1 calendar + run complete = 11.
    expect(lines).toHaveLength(11);
  });
});
