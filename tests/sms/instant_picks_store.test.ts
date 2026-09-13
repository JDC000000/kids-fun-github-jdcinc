// tests/sms/instant_picks_store.test.ts — the one read behind an Instant Picks press.
//
// The `query` seam is INJECTED rather than module-mocked, so this file never constructs a pool and
// stays in the `unit` lane (vitest.workspace.ts). What is under test is WHICH COLUMNS ARE ASKED
// FOR and WHO IS REFUSED.
//
// (Injection rather than `vi.mock` is also what keeps this suite honest: in Vitest 2.0.5,
// registering a `mockResolvedValue`/`mockRejectedValue` records a spurious zero-argument entry in
// `mock.calls` — so index-based assertions on the recorded SQL silently read the wrong call, and a
// rejecting mock surfaces as an unhandled rejection rather than the code path under test.)
//
// ═══ WHY THE COLUMN LIST IS WORTH A TEST OF ITS OWN ═══
// This file was added because a mutation survived: adding `consecutive_empty_weeks` back to this
// store passed every other suite, because the route's tests mock this module and the wrapper's
// tests never reach it. That column is the input to `shouldPause` — the flag that, wired wrong,
// lets a button press pause a real subscriber. The wrapper passes a hard zero regardless, so this
// is the SECOND line of defence, not the only one; but "the value is not even in scope on this
// path" is the guarantee that survives a careless edit to the wrapper, and nothing was checking it.
import { describe, expect, it } from 'vitest';
import { findInstantPicksSubscriber } from '@/lib/sms/instant-picks-store';

const TOKEN = 'a'.repeat(43);

const ROW = {
  id: '11111111-2222-3333-4444-555555555555',
  status: 'active' as const,
  postal_code: 'V5L 1A1',
  birth_years: [2018, 2021],
  category_interests: ['public_swim'],
};

interface Recorded {
  sql: string;
  params: unknown[];
}

/** A `query` stand-in that records the statement and returns the rows the test supplied. */
function harness(rows: unknown[] = [ROW]) {
  const calls: Recorded[] = [];
  const query = (async (sql: string, params: unknown[]) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return rows;
  }) as never;
  return { calls, query };
}

/** A `query` stand-in that fails the way an unreachable database does. */
const failing = (async () => {
  throw new Error('connection refused');
}) as never;

describe('instant picks store · the empty-week counter is never read', () => {
  it('does not SELECT consecutive_empty_weeks', async () => {
    const { calls, query } = harness();
    await findInstantPicksSubscriber(TOKEN, { query });

    const sql = calls[0].sql;
    expect(sql).not.toMatch(/consecutive_empty_weeks/i);
    // Nor the rest of the send-path machinery this page has no use for.
    expect(sql).not.toMatch(/phone_number|short_ref|sms_send_log/i);
  });

  it('does not return it, under any name, even if the row carries one', async () => {
    // A row shaped like `loadActiveSubscribers`'s — the realistic accident is copying that query.
    const { query } = harness([{ ...ROW, consecutive_empty_weeks: 2 }]);

    const result = await findInstantPicksSubscriber(TOKEN, { query });

    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.subscriber).not.toHaveProperty('consecutiveEmptyWeeks');
    expect(JSON.stringify(result.subscriber)).not.toMatch(/empty.?week|2\b.*empty/i);
    expect(Object.keys(result.subscriber).sort()).toEqual(
      ['birthYears', 'categoryInterests', 'postalCode']
    );
  });

  it('asks for exactly the columns a press uses, and no more', async () => {
    const { calls, query } = harness();
    await findInstantPicksSubscriber(TOKEN, { query });

    expect(calls).toHaveLength(1);
    const sql = calls[0].sql;
    expect(sql).toMatch(
      /SELECT id, status, postal_code, birth_years, category_interests FROM sms_consent/i
    );
    expect(sql).not.toMatch(/SELECT \*/i);
  });

  it('matches on the token as a parameter, never interpolated', async () => {
    const { calls, query } = harness();
    await findInstantPicksSubscriber(TOKEN, { query });

    expect(calls[0].sql).toContain('$1');
    expect(calls[0].sql).not.toContain(TOKEN);
    expect(calls[0].params).toEqual([TOKEN]);
  });
});

describe('instant picks store · who is refused', () => {
  it('serves an active subscriber', async () => {
    const result = await findInstantPicksSubscriber(TOKEN, harness());
    expect(result).toEqual({
      outcome: 'found',
      subscriberId: ROW.id,
      subscriber: {
        postalCode: 'V5L 1A1',
        birthYears: [2018, 2021],
        categoryInterests: ['public_swim'],
      },
    });
  });

  it.each(['pending', 'paused'] as const)('serves a %s subscriber too', async (status) => {
    // Real rows with real stored preferences, asking for this themselves, on their own page, with
    // nothing sent. The same rule the page uses to decide whether to show its edit form.
    const { query } = harness([{ ...ROW, status }]);
    expect((await findInstantPicksSubscriber(TOKEN, { query })).outcome).toBe('found');
  });

  it('refuses a stopped subscriber', async () => {
    // They asked us to stop. Building them a personalised list out of the data they asked us to
    // stop using is the wrong answer even though nothing is sent.
    const { query } = harness([{ ...ROW, status: 'stopped' }]);
    expect((await findInstantPicksSubscriber(TOKEN, { query })).outcome).toBe('not_found');
  });

  it('refuses a purged row', async () => {
    const { query } = harness([{ ...ROW, postal_code: null, birth_years: null }]);
    expect((await findInstantPicksSubscriber(TOKEN, { query })).outcome).toBe('not_found');
  });

  it('still serves a row that has a postal code but no birth years', async () => {
    // Not purged — a subscriber with no ages recorded. That means "no age filter", honestly,
    // rather than an error, and it is the coercion `loadActiveSubscribers` already makes.
    const { query } = harness([{ ...ROW, birth_years: null }]);
    const result = await findInstantPicksSubscriber(TOKEN, { query });
    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.subscriber.birthYears).toEqual([]);
  });

  it('refuses an unknown token', async () => {
    const { query } = harness([]);
    expect((await findInstantPicksSubscriber(TOKEN, { query })).outcome).toBe('not_found');
  });

  it('reports a failed read as not_found rather than throwing', async () => {
    // Same posture as `resolvePreferences`: "no such token" versus "the database is down" is
    // information a prober would like and a parent cannot use — and this is a public endpoint.
    await expect(findInstantPicksSubscriber(TOKEN, { query: failing })).resolves.toEqual({
      outcome: 'not_found',
    });
  });
});
