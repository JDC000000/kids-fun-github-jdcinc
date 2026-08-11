import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LibraryAdapter,
  assessBiblioCommonsRun,
  getLibrarySystem,
  parseBiblioCommonsRss,
} from '../../worker/adapters/library';
import { finishCheckRun } from '../../worker/core/checkrun';
import { ingestSource } from '../../worker/core/ingest';
import { clearPolicyState } from '../../worker/health/policy';

// BiblioCommons RSS — TRUNCATION DIAGNOSTICS (unit U1).
//
// WHAT THIS FILE IS FOR, and why it is not "more coverage".
// The library family already had truncation MEASUREMENT: a `droppedByLimit` COUNT and buckets
// that reconcile to `itemsInFeed`. All of it was reachable only from `generic_rss` (NVDPL) —
// the one library platform that is not live. The two that ARE live, VPL and RPL, ran the
// BiblioCommons RSS parser, which recorded nothing at all: not the feed's item count, not
// the emit count, not what the client-side cap refused. This file is the BiblioCommons
// equivalent of tests/adapters/library-nvdpl-rss.test.ts's diagnostics and run-health
// blocks, and it is modelled on them deliberately — same invariant, same vocabulary.
//
// >>> STAGE 0 CHANGED WHAT THE MEASUREMENT IS FOR. <<<
// The family also had a `truncated_by_limit` ALERT on that count, and that alert was wrong in
// both directions: loud on every healthy full run (our cap sits below the vendor page, so a
// healthy run always drops records) and silent on a genuinely short one (the vendor sent less
// than our cap, so nothing was dropped). It is DELETED. The count, the tally line and the
// reconciliation invariant all survive — see 'the truncation ALERT is gone'.
// In its place the feed's own item count is now RECORDED (source_check_run.items_in_feed,
// migration 0031), because a number in the database is the only thing that makes a quiet,
// permanently-capped source visible. A verdict string cannot: ingest reads it only when the
// verdict alerts.
//
// >>> WHAT THIS UNIT DID NOT DO, stated here because the number invites the mistake. <<<
// It did not raise any `liveEventsLimit`, and raising one would not have helped: the live
// path is RSS, our limit is applied CLIENT-SIDE after the response arrives, and the vendor's
// RSS caps at 25 items regardless of what we ask for. VPL's cap (25) and that page size (25)
// are THE SAME NUMBER, which is exactly why the two are easy to confuse. See the
// 'the VPL shape' block at the bottom — it pins that collision in executable form so nobody
// has to rediscover it from the constants.

const vplSystem = () => getLibrarySystem('vpl')!;
const rplSystem = () => getLibrarySystem('rpl')!;

/** A byte-shaped slice of the real BiblioCommons RSS item: CDATA text nodes + `bc:` geo. */
function bcItem(n: number): string {
  const id = `6a062d43caf93436005b${String(n).padStart(4, '0')}`;
  return `<item>
<title><![CDATA[Baby Storytime ${n}]]></title>
<description><![CDATA[<p>Songs and rhymes for babies. For children ages 0-2 with a caregiver.</p>]]></description>
<link>https://vpl.bibliocommons.com/events/${id}</link>
<guid isPermaLink="true">https://vpl.bibliocommons.com/events/${id}</guid>
<category><![CDATA[Storytimes]]></category>
<bc:start_date>2026-07-15T17:30:00Z</bc:start_date>
<bc:end_date>2026-07-15T18:00:00Z</bc:end_date>
<bc:is_cancelled>false</bc:is_cancelled>
<bc:location><bc:name>Mount Pleasant Branch</bc:name><bc:number>1</bc:number><bc:street>Kingsway</bc:street><bc:city>Vancouver</bc:city><bc:zip>V5T 3H7</bc:zip><bc:latitude>49.26432743195909</bc:latitude><bc:longitude>-123.1004038834671</bc:longitude></bc:location>
</item>`;
}

/** The library withdrew this one. A real, expected outcome — not a defect. */
const CANCELLED_ITEM = `<item>
<title><![CDATA[Cancelled Program]]></title>
<link>https://vpl.bibliocommons.com/events/6a062d43caf93436005bffff</link>
<bc:start_date>2026-07-16T17:30:00Z</bc:start_date>
<bc:is_cancelled>true</bc:is_cancelled>
</item>`;

/** No `bc:start_date` at all: structurally unusable, whatever else it carries. */
const MALFORMED_ITEM = `<item>
<title><![CDATA[No Start Date]]></title>
<link>https://vpl.bibliocommons.com/events/6a062d43caf93436005bfffe</link>
<bc:is_cancelled>false</bc:is_cancelled>
</item>`;

function bcFeed(...itemsXml: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:bc="http://bibliocommons.com/rss">
<channel>
<title><![CDATA[Vancouver Public Library — Events]]></title>
<link>https://vpl.bibliocommons.com/events</link>
${itemsXml.join('\n')}
</channel>
</rss>`;
}

/** n ordinary, emittable items — the vendor page as it actually arrives. */
function feedOf(n: number): string {
  return bcFeed(...Array.from({ length: n }, (_, i) => bcItem(i + 1)));
}

describe('BiblioCommons RSS — the parser records a run tally at all (it previously recorded none)', () => {
  it('reports items received, items emitted and items dropped by the client-side cap', () => {
    // The three numbers criterion 1 asks for, and the three the live path was discarding.
    const { events, diagnostics } = parseBiblioCommonsRss({ ...vplSystem(), liveEventsLimit: 3 }, feedOf(5));
    expect(events).toHaveLength(3);
    expect(diagnostics).toMatchObject({ itemsInFeed: 5, emitted: 3, droppedByLimit: 2 });
  });

  it('counts cancelled and malformed items rather than dropping them into silence', () => {
    const { diagnostics } = parseBiblioCommonsRss(
      { ...vplSystem(), liveEventsLimit: 25 },
      bcFeed(bcItem(1), CANCELLED_ITEM, MALFORMED_ITEM, bcItem(2))
    );
    expect(diagnostics).toMatchObject({
      itemsInFeed: 4,
      emitted: 2,
      cancelledItems: 1,
      malformedItems: 1,
      droppedByLimit: 0,
    });
  });
});

describe('BiblioCommons RSS — the diagnostics buckets ACCOUNT FOR EVERY ITEM', () => {
  // THE INVARIANT, copied deliberately from the generic_rss suite rather than reinvented:
  // the buckets exist so that "why did a 25-item feed yield 20 records?" is answerable off
  // the health board without re-pulling the feed. That only holds if every item the feed
  // delivered lands in exactly ONE bucket. Asserted across limits so the truncating and the
  // non-truncating paths are both covered.
  const bucketSum = (d: Record<string, number>) =>
    d.emitted + d.cancelledItems + d.malformedItems + d.droppedByLimit;

  const MIXED_FEED = bcFeed(
    bcItem(1), bcItem(2), bcItem(3), CANCELLED_ITEM, bcItem(4), MALFORMED_ITEM, bcItem(5)
  );

  for (const limit of [1, 2, 3, 20, 25]) {
    it(`reconciles to itemsInFeed at liveEventsLimit=${limit}`, () => {
      const system = { ...vplSystem(), liveEventsLimit: limit };
      const { events, diagnostics } = parseBiblioCommonsRss(system, MIXED_FEED);
      expect(
        bucketSum(diagnostics as unknown as Record<string, number>),
        `buckets must account for all ${diagnostics.itemsInFeed} items: ${JSON.stringify(diagnostics)}`
      ).toBe(diagnostics.itemsInFeed);
      // And the limit is genuinely enforced, not merely reported.
      expect(events.length).toBeLessThanOrEqual(limit);
      expect(diagnostics.emitted).toBe(events.length);
    });
  }

  it('counts the items truncation actually cost, rather than only that it happened', () => {
    // 5 items are emittable (one cancelled, one malformed); at a cap of 2, three are lost.
    const { diagnostics } = parseBiblioCommonsRss({ ...vplSystem(), liveEventsLimit: 2 }, MIXED_FEED);
    expect(diagnostics.emitted).toBe(2);
    expect(diagnostics.droppedByLimit).toBe(3);
  });

  it('drops NOTHING to the limit when the feed fits', () => {
    const { diagnostics } = parseBiblioCommonsRss({ ...vplSystem(), liveEventsLimit: 25 }, MIXED_FEED);
    expect(diagnostics.droppedByLimit).toBe(0);
    expect(diagnostics.emitted).toBe(5);
  });

  it('a truncated run still emits the SAME records it always did, in the same order', () => {
    // The parser now keeps iterating past the cap instead of breaking out of the loop, purely
    // to count what it refuses. That must not change one byte of what it emits.
    const { events } = parseBiblioCommonsRss({ ...vplSystem(), liveEventsLimit: 3 }, feedOf(10));
    expect(events.map((e) => e.title)).toEqual([
      'Baby Storytime 1', 'Baby Storytime 2', 'Baby Storytime 3',
    ]);
  });

  it("RPL's real config against the vendor's real page size loses exactly 5 records", () => {
    // The concrete production case: BiblioCommons RSS answers with 25 items; RPL's
    // liveEventsLimit is 20. Five kid events per run have been discarded uncounted.
    const { diagnostics } = parseBiblioCommonsRss(rplSystem(), feedOf(25));
    expect(diagnostics).toMatchObject({ itemsInFeed: 25, emitted: 20, droppedByLimit: 5 });
  });
});

describe('BiblioCommons RSS — run health', () => {
  const diagnostics = (over: Record<string, unknown> = {}) => ({
    itemsInFeed: 25, emitted: 25, cancelledItems: 0, malformedItems: 0, droppedByLimit: 0,
    ...over,
  });

  it('passes on a healthy run', () => {
    expect(assessBiblioCommonsRun(vplSystem(), diagnostics())).toMatchObject({
      code: 'ok', alert: false,
    });
  });

  it('ALERTS on an empty feed', () => {
    expect(
      assessBiblioCommonsRun(vplSystem(), diagnostics({ itemsInFeed: 0, emitted: 0 }))
    ).toMatchObject({ code: 'empty_feed', alert: true });
  });

  it('ALERTS when a non-empty feed yields zero records — the green-run-over-nothing case', () => {
    expect(
      assessBiblioCommonsRun(vplSystem(), diagnostics({ emitted: 0, cancelledItems: 25 }))
    ).toMatchObject({ code: 'yield_collapse', alert: true });
  });

  it('does NOT alert when our cap dropped records — the truncation ALERT is gone', () => {
    // THE DELETION, PINNED. Reinstating the `droppedByLimit > 0` ⇒ `truncated_by_limit` arm
    // fails here first, so it cannot come back by accident.
    //
    // WHY IT HAD TO GO, in the numbers of this very fixture. RPL's cap (20) sits below the
    // page this feed delivers (25), so `droppedByLimit` is > 0 on a PERFECTLY HEALTHY full
    // run — the alert fires every run, forever. And it is INVERTED: on a genuinely short run
    // the vendor sends fewer than our cap, nothing is dropped, and it says nothing. Loud when
    // healthy, silent when not.
    //
    // Permanent is also much worse than noisy here. `health_alert_code IS NULL` is half of
    // CLEAN_SUCCESS_RUN_SQL (worker/health/sla.ts, mirrored in lib/admin/dashboard.ts), which
    // drives both the rolling success ratio and `last_success_at` — so an alert on every run
    // means no run is ever a clean success and `last_success_at` never advances. The source
    // would read as permanently down on the SLA board and the admin dashboard while working
    // perfectly.
    const verdict = assessBiblioCommonsRun(rplSystem(), diagnostics({ emitted: 20, droppedByLimit: 5 }));
    expect(verdict).toMatchObject({ code: 'ok', alert: false });
    expect(verdict.code, 'the truncation verdict code must not exist any more').not.toBe(
      'truncated_by_limit'
    );
  });

  it('but the COUNT and the TALLY survive the deletion — only the alert went', () => {
    // The deletion removed an alerting arm, NOT the measurement. Everything a reader needs to
    // diagnose a capped run is still on the line; it simply no longer degrades the run.
    const verdict = assessBiblioCommonsRun(rplSystem(), diagnostics({ emitted: 20, droppedByLimit: 5 }));
    expect(verdict.detail).toContain('20 emitted of 25 feed items');
    expect(verdict.detail, 'the droppedByLimit count is still rendered').toContain('5 over limit');
    expect(verdict.alert).toBe(false);
  });

  it('every verdict states the tally, so a thin run is diagnosable without a re-pull', () => {
    expect(assessBiblioCommonsRun(vplSystem(), diagnostics()).detail).toContain(
      '25 emitted of 25 feed items'
    );
    expect(
      assessBiblioCommonsRun(vplSystem(), diagnostics({ emitted: 23, cancelledItems: 2 })).detail
    ).toContain('2 cancelled');
  });

  describe('the tally line SAYS what its relationship to our cap is, rather than implying it', () => {
    // Three numbers on a line, two of which sometimes coincide, is not a diagnosis — the
    // reader has to know which pairs matter before the line tells them anything. These pin
    // the words.
    it('says so when the feed delivered exactly our cap (VPL: 25 of 25)', () => {
      const detail = assessBiblioCommonsRun(vplSystem(), diagnostics()).detail;
      expect(detail).toContain('AT OUR CAP');
      expect(detail).toContain('liveEventsLimit=25');
      // The specific misreading this exists to block: `0 over limit` means our cap refused
      // nothing, NOT that we received everything the vendor has.
      expect(detail).toContain('NOT that the feed was complete');
    });

    it('says so when our cap is BELOW what the feed delivered (RPL: 20 against 25)', () => {
      const detail = assessBiblioCommonsRun(
        rplSystem(),
        diagnostics({ emitted: 20, droppedByLimit: 5 })
      ).detail;
      expect(detail).toContain('OUR CAP IS BELOW SUPPLY');
      expect(detail).toContain('liveEventsLimit=20');
      expect(detail, 'the count is the actionable part').toContain(
        '5 already-fetched record(s) were discarded'
      );
    });

    it('says NOTHING extra when the run is uncensored — no note is the healthy read', () => {
      // Feed below our cap: nothing was refused and nothing coincides, so there is nothing to
      // explain. A note on every line would be noise, and noise on a healthy line is how the
      // signal on an unhealthy one gets ignored.
      const detail = assessBiblioCommonsRun(
        vplSystem(),
        diagnostics({ itemsInFeed: 12, emitted: 12 })
      ).detail;
      expect(detail).toContain('12 emitted of 12 feed items');
      expect(detail).not.toContain('AT OUR CAP');
      expect(detail).not.toContain('OUR CAP IS BELOW SUPPLY');
    });

    it('quotes the cap the PARSE APPLIED, not the config field, when a system declares none', () => {
      // A system with no `liveEventsLimit` parses under DEFAULT_BIBLIOCOMMONS_LIMIT (20). A
      // line quoting `system.liveEventsLimit` would print `undefined` while describing a run
      // that had silently capped at 20 — a tally line lying about the cap it is explaining.
      const { liveEventsLimit: _omitted, ...noLimit } = vplSystem();
      const detail = assessBiblioCommonsRun(
        noLimit,
        diagnostics({ itemsInFeed: 20, emitted: 20 })
      ).detail;
      expect(detail).toContain('liveEventsLimit=20');
      expect(detail).not.toContain('undefined');
    });

    it('the note is NOT what makes a quiet capped source visible — the column is', () => {
      // ⚠️ THE TRAP THIS WHOLE STAGE EXISTS TO AVOID RE-CREATING, pinned in executable form.
      // worker/core/ingest.ts reads `verdict.detail` ONLY inside `if (verdict?.alert)`. There
      // is no else branch and no logging path, so a non-alerting verdict's detail is computed
      // and discarded in memory: never the DB, never the logs, never the UI. VPL's verdict is
      // 'ok' permanently, so NO improvement to this line can ever reach a durable surface for
      // it. The line only ever helps verdicts that ALREADY alert.
      // What makes the quiet case visible is source_check_run.items_in_feed — a recorded
      // number — which is why this stage adds a column and not just a better string.
      const verdict = assessBiblioCommonsRun(vplSystem(), diagnostics());
      expect(verdict.detail, 'the note is computed…').toContain('AT OUR CAP');
      expect(verdict.alert, '…and then thrown away, because this verdict does not alert').toBe(
        false
      );
    });
  });

  it('ALERTS on a PARTIAL yield collapse against the trailing baseline (live runs only)', () => {
    const verdict = assessBiblioCommonsRun(vplSystem(), diagnostics({ emitted: 5 }), 25, true);
    expect(verdict).toMatchObject({ code: 'yield_collapse', alert: true });
    expect(verdict.detail).toContain('trailing baseline 25');
  });

  it('does NOT alert when a live run is merely a bit thinner than baseline', () => {
    expect(assessBiblioCommonsRun(vplSystem(), diagnostics({ emitted: 20 }), 25, true)).toMatchObject({
      code: 'ok', alert: false,
    });
  });

  it('a FIXTURE run is never compared to a live baseline — the false-alert trap', () => {
    // 1 fixture record against a live baseline of 25 is a 96% "collapse". Comparing them
    // would fire on every fixture run, i.e. the default posture and every CI run.
    expect(
      assessBiblioCommonsRun(vplSystem(), diagnostics({ itemsInFeed: 1, emitted: 1 }), 25, false)
    ).toMatchObject({ code: 'ok', alert: false });
  });

  it('a first run (no baseline) does not alert', () => {
    expect(assessBiblioCommonsRun(vplSystem(), diagnostics({ emitted: 3 }), null, true)).toMatchObject({
      code: 'ok', alert: false,
    });
  });
});

describe('BiblioCommons RSS — the verdict is reachable AT THE ADAPTER BOUNDARY', () => {
  // WHY THESE EXIST ALONGSIDE THE PURE-FUNCTION TESTS ABOVE, and why those are not enough.
  // QA finding G-1 on the generic_rss path proved the trap the hard way: the collapse logic
  // was thoroughly covered as a PURE FUNCTION invoked with explicit arguments, so reverting
  // the ADAPTER's call to `assess(system, diagnostics)` — dropping the baseline and the
  // liveness flag — left the entire suite green. The defect lived in the wiring, and no test
  // crossed it. These do: they drive fetch() → extract() → assessRun() and assert verdicts
  // that are unreachable unless the tally is recorded AND forwarded with both arguments.

  beforeEach(() => {
    // politeFetch enforces a 3s per-source floor; without this each test waits it out.
    clearPolicyState();
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'vpl,rpl';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
  });

  const serve = (xml: string) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml' } })) as unknown as typeof fetch);

  it('a LIVE truncated run does NOT alert through the adapter, but still states the count', async () => {
    // The deletion, asserted at the WIRING and not only on the pure function — the level QA
    // finding G-1 proved a pure-function-only suite cannot reach.
    serve(feedOf(25));
    const adapter = new LibraryAdapter(rplSystem());
    const records = adapter.extract(await adapter.fetch());
    expect(records, 'RPL caps at 20').toHaveLength(20);
    const verdict = adapter.assessRun(null)!;
    expect(verdict).toMatchObject({ code: 'ok', alert: false });
    expect(verdict.detail, 'the count survives the deletion').toContain('5 over limit');
    expect(verdict.detail).toContain('OUR CAP IS BELOW SUPPLY');
  });

  it('a LIVE run below baseline alerts THROUGH the adapter — assessRun must forward the baseline', async () => {
    // 3 records against a trailing baseline of 25 is an 88% drop. The verdict is a cheerful
    // 'ok' if the baseline argument is dropped on the way through the adapter.
    serve(feedOf(3));
    const adapter = new LibraryAdapter(vplSystem());
    adapter.extract(await adapter.fetch());
    expect(adapter.assessRun(25)).toMatchObject({ code: 'yield_collapse', alert: true });
  });

  it('the same LIVE run is healthy against a baseline it does NOT collapse against', async () => {
    // The other direction: the alert must come from the comparison, not from merely being a
    // live run with few records.
    serve(feedOf(3));
    const adapter = new LibraryAdapter(vplSystem());
    adapter.extract(await adapter.fetch());
    expect(adapter.assessRun(4)).toMatchObject({ code: 'ok', alert: false });
  });

  it('the adapter reports LIVE-ness, not fixture-ness, after a live fetch', async () => {
    // The liveness flag is the other half of what a dropped-arguments regression loses: a
    // live run misreported as a fixture run also skips the baseline comparison and passes.
    serve(feedOf(3));
    const adapter = new LibraryAdapter(vplSystem());
    adapter.extract(await adapter.fetch());
    expect(adapter.assessRun(25)!.detail).toContain('trailing baseline 25');
  });

  it('a FIXTURE run reports NO verdict — nothing was parsed, so there is nothing to report', async () => {
    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
    const adapter = new LibraryAdapter(vplSystem());
    adapter.extract(await adapter.fetch());
    // The BiblioCommons fixture is a hand-built object, not RSS — there is no feed tally.
    // Reporting `empty_feed` (itemsInFeed 0) here would alert on every default-posture run.
    expect(adapter.assessRun(25)).toBeNull();
  });

  it('a FIXTURE run after a LIVE one does not report the LIVE run’s stale tally', async () => {
    // The module-scoped hand-off between fetch() and assessRun() is per-system and survives
    // the fetch, so a fixture run following a live one would otherwise inherit numbers from
    // a run that never touched the network — a lie with a plausible figure attached.
    serve(feedOf(25));
    const adapter = new LibraryAdapter(rplSystem());
    adapter.extract(await adapter.fetch());
    expect(adapter.assessRun(null)!.detail, 'live run reports a real tally').toContain(
      '20 emitted of 25 feed items'
    );

    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
    adapter.extract(await adapter.fetch());
    expect(adapter.assessRun(null)).toBeNull();
  });

  it('Communico still reports no verdict — it has no feed parser to tally', async () => {
    const cpl = new LibraryAdapter(getLibrarySystem('cpl')!);
    cpl.extract(await cpl.fetch());
    expect(cpl.assessRun()).toBeNull();
  });
});

describe('items_in_feed — the feed count is MEASURED AND PERSISTED, not merely computed', () => {
  // WHY THIS BLOCK IS THE POINT OF THE STAGE. `records_found` is identically the adapter's
  // EMIT count (ingest increments it once per extracted record), i.e. the number OUR cap
  // censors — and every trailing baseline in this project is computed from it. `itemsInFeed`
  // is the same run measured before our cap touches it, and it had never been recorded by any
  // adapter in any run. These tests assert it survives all the way to the UPDATE statement,
  // because "the adapter computes it" is exactly the state U1 was already in.

  beforeEach(() => {
    clearPolicyState();
    process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS = 'vpl,rpl';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
  });

  const serve = (xml: string) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml' } })) as unknown as typeof fetch);

  it('reports the UNCENSORED feed count on a live run — not the capped emit count', async () => {
    // RPL: the vendor sent 25, our cap let 20 through. The whole reason for the column is
    // that these are different numbers and only one of them is about the vendor.
    serve(feedOf(25));
    const adapter = new LibraryAdapter(rplSystem());
    const records = adapter.extract(await adapter.fetch());
    expect(records, 'what our cap let through').toHaveLength(20);
    expect(adapter.reportItemsInFeed(), 'what the vendor actually sent').toBe(25);
  });

  it('reports NULL on a bibliocommons fixture run — a fixture is not a vendor measurement', async () => {
    // Recording a fixture's item count would poison both things this column exists for:
    // max(items_in_feed) read as the vendor page size, and a live-only supply baseline.
    // On THIS platform the null comes for free: the bibliocommons fixture is a hand-built
    // object rather than RSS, so fetch() clears the diagnostics map outright. The next test
    // covers the platform where it does NOT come for free.
    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
    const adapter = new LibraryAdapter(vplSystem());
    adapter.extract(await adapter.fetch());
    expect(adapter.reportItemsInFeed()).toBeNull();
  });

  it('reports NULL on a generic_rss fixture run TOO — where the null is NOT free', async () => {
    // THE CASE THE LIVE GATE ACTUALLY EXISTS FOR, and the one an adjacent test cannot reach.
    // Unlike bibliocommons, the generic_rss fixture path parses real fixture XML and RECORDS
    // a full tally (with live: false) — the diagnostics map is populated, not cleared. So
    // without the explicit `live` check in reportItemsInFeed, NVDPL would persist its
    // fixture's item count to items_in_feed on every default-posture run: a synthetic number
    // in the column that later reads `max(items_in_feed)` as the vendor's page size.
    // Deleting the gate makes this test fail and no other, which is why it is written
    // separately rather than folded into the one above.
    delete process.env.KIDS_FUN_LIVE_LIBRARY_SYSTEMS;
    const nvdpl = new LibraryAdapter(getLibrarySystem('nvdpl')!);
    const records = nvdpl.extract(await nvdpl.fetch());
    expect(records.length, 'the fixture really did parse and record a tally').toBeGreaterThan(0);
    expect(nvdpl.assessRun(null), 'and that tally reached assessRun — the map is populated').not.toBeNull();
    expect(nvdpl.reportItemsInFeed(), 'yet no feed count is reported for a fixture run').toBeNull();
  });

  it('reports NULL for an adapter with no feed to count (Communico)', async () => {
    const cpl = new LibraryAdapter(getLibrarySystem('cpl')!);
    cpl.extract(await cpl.fetch());
    expect(cpl.reportItemsInFeed()).toBeNull();
  });

  it('finishCheckRun WRITES it to the items_in_feed column', async () => {
    // The narrowest possible statement of "persisted": the column is named in the UPDATE and
    // the value is bound to it. Without this, every assertion above is about a number that
    // still never leaves the process — which is precisely the state being corrected.
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [{ source_id: 'src-1' }] };
      },
    } as unknown as Parameters<typeof finishCheckRun>[0];

    await finishCheckRun(pool, 'run-1', {
      status: 'success',
      recordsFound: 20,
      itemsInFeed: 25,
      startedAt: new Date(),
    });

    const update = calls.find((c) => c.sql.includes('UPDATE source_check_run'))!;
    expect(update.sql).toContain('items_in_feed');
    expect(update.params, 'the uncensored count is bound, alongside the censored one').toContain(25);
    expect(update.params).toContain(20);
  });

  it('END TO END: a LIVE run carries the feed count through ingestSource into the UPDATE', async () => {
    // The wiring test. QA finding G-1 on this same adapter proved that a suite covering only
    // pure functions leaves a dropped-argument regression completely green — the defect lives
    // between the parts. So this drives the real path: live fetch → parse → extract →
    // ingestSource → finishCheckRun, and reads the number off the SQL parameters.
    serve(feedOf(25));
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        // startCheckRun needs an id back; finishCheckRun needs a source_id. Every other query
        // may answer empty — the record loop's failures are caught per record and are not
        // what this test is about.
        return { rows: [{ id: 'run-1', source_id: 'src-1' }] };
      },
    } as unknown as Parameters<typeof ingestSource>[0];

    const summary = await ingestSource(pool, new LibraryAdapter(rplSystem()), 'src-1');

    expect(summary.itemsInFeed, 'the vendor sent 25').toBe(25);
    expect(summary.recordsFound, 'our cap let 20 through — a DIFFERENT number').toBe(20);

    const update = calls.find((c) => c.sql.includes('UPDATE source_check_run'))!;
    expect(update.params).toContain(25);
  });

  it('is recorded on a run whose verdict does NOT alert — the whole point', async () => {
    // ⚠️ THE STRUCTURAL DEFECT THIS STAGE EXISTS TO ROUTE AROUND. ingest.ts consults the
    // verdict ONLY inside `if (verdict?.alert)`, so everything a non-alerting verdict carries
    // is discarded in memory. A permanently-capped source is 'ok' on every run — so if the
    // measurement travelled on the verdict it would be lost in exactly the case it exists to
    // illuminate. It travels on its own method instead, and this asserts the consequence:
    // NO alert raised, and the number recorded anyway.
    serve(feedOf(25));
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [{ id: 'run-1', source_id: 'src-1' }] };
      },
    } as unknown as Parameters<typeof ingestSource>[0];

    const summary = await ingestSource(pool, new LibraryAdapter(rplSystem()), 'src-1');

    expect(summary.healthAlert, 'RPL dropping 5 records no longer alerts').toBeNull();
    expect(summary.itemsInFeed, 'and the measurement is kept regardless').toBe(25);
    const update = calls.find((c) => c.sql.includes('UPDATE source_check_run'))!;
    expect(update.params).toContain(25);
    expect(update.params, 'no alert code was written').not.toContain('truncated_by_limit');
  });
});

describe('BiblioCommons RSS — the VPL shape: why a droppedByLimit of 0 is NOT "not truncated"', () => {
  it('VPL emits 25 of 25 and drops nothing BY OUR CAP, because our cap IS the vendor page size', () => {
    // This is the collision that has misled every previous reader of these constants, pinned
    // in executable form. BiblioCommons' RSS returns 25 items whatever `limit` we ask for;
    // VPL's liveEventsLimit is also 25. So the client-side truncation counter is 0 — and
    // that is NOT evidence VPL is complete. It means our cap never had to refuse anything,
    // because the vendor had already stopped at the same number.
    const { diagnostics } = parseBiblioCommonsRss(vplSystem(), feedOf(25));
    expect(diagnostics).toMatchObject({ itemsInFeed: 25, emitted: 25, droppedByLimit: 0 });
    expect(assessBiblioCommonsRun(vplSystem(), diagnostics)).toMatchObject({
      code: 'ok', alert: false,
    });
    // The fingerprint is itemsInFeed sitting exactly on the cap, and the tally line now names
    // it in words instead of leaving two numbers to be compared by eye.
    const detail = assessBiblioCommonsRun(vplSystem(), diagnostics).detail;
    expect(detail).toContain('25 emitted of 25 feed items');
    expect(detail).toContain('AT OUR CAP');
    // ⚠️ BUT THAT LINE IS NOT ON THE HEALTH BOARD, AND AN EARLIER VERSION OF THIS COMMENT
    // CLAIMED IT WAS. ingest.ts reads `verdict.detail` only inside `if (verdict?.alert)`, so
    // an 'ok' verdict's detail reaches no durable surface — not source_check_run, not the
    // logs, not the UI. VPL's verdict is 'ok' permanently, so for VPL specifically NO tally
    // line has ever been, or can ever be, visible anywhere. What IS on record for VPL after
    // this stage is source_check_run.items_in_feed: a number, in a column, that a query can
    // reach. That distinction is the correction this stage rests on.
    expect(assessBiblioCommonsRun(vplSystem(), diagnostics).alert).toBe(false);
    expect(vplSystem().liveEventsLimit).toBe(25);
  });

  it('raising the cap would NOT have been the fix — the counter only sees what the vendor sent', () => {
    // Bumping liveEventsLimit is a proven mechanical no-op for this platform. Modelled here
    // rather than argued: with the vendor still returning 25, a cap of 60 changes neither
    // the records emitted nor the diagnostics. The only thing it changes is which side of
    // the ceiling the number came from — and that is not something this adapter can move.
    const raised = parseBiblioCommonsRss({ ...vplSystem(), liveEventsLimit: 60 }, feedOf(25));
    const asIs = parseBiblioCommonsRss(vplSystem(), feedOf(25));
    expect(raised.events).toHaveLength(asIs.events.length);
    expect(raised.diagnostics).toEqual(asIs.diagnostics);
  });

  it('the live caps are UNCHANGED by this unit', () => {
    // Pinned so that changing one is a deliberate, visible act rather than a quiet edit —
    // the same idiom tests/compliance/no-bypass.test.ts uses for the adapter-family list.
    // This unit MEASURES truncation; it does not change any cap.
    expect(vplSystem().liveEventsLimit).toBe(25);
    expect(rplSystem().liveEventsLimit).toBe(20);
    expect(getLibrarySystem('nvdpl')!.liveEventsLimit).toBe(60);
  });
});
