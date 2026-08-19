// scripts/three-things-pool-probe.ts — READ-ONLY: how much content each front-door slot has today.
//
// WHY THIS EXISTS. Jon's ruling of 2026-08-19 chose the honest `isRainyDayFriendly` signal for the
// indoor slot in full knowledge that its pool is thin, and chose to run that slot CITYWIDE rather
// than inside the nearby slot's radius precisely because the radius-constrained version measured
// EMPTY that afternoon (2 cards within 5 km of downtown, both with `ageMinMonths: null`). The
// added instruction that came with the approval was: don't claim the citywide pool stays
// non-empty — verify it, and leave behind a way to keep verifying it.
//
// This is that way. It is not monitoring and does not want to be: it is one command that any
// agent or human can run in ten seconds, before a deploy or after a catalogue change, that
// answers "does the front door still have three things to say?" and exits non-zero when the
// indoor slot has nothing.
//
// ── WHAT MAKES IT TRUSTWORTHY ────────────────────────────────────────────────────────────────
// It calls the REAL gate (`isShowableOnFrontDoor`) and the REAL cost predicate (`isFree`) from
// lib/, over rows fetched from a live `/api/search`. It does not reimplement either. That is the
// whole design: a probe that mirrors the logic it measures cannot detect the logic changing, and
// this repo has been burned by exactly that (see scripts/search-cap-probe.ts's header, which
// documents three separate reviews that each measured a different population than they claimed).
// `isShowableOnFrontDoor` takes a structural `FrontDoorSignalInput` so the wire DTO satisfies it
// with no cast — the same reason `cost.ts#isFree` takes `CostFacts`.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────────
// It does not apply the cross-slot de-dupe. Pool sizes are what the question is about — "is there
// anything here at all" — and de-duping three pools against each other would report a number that
// depends on the ORDER slots were filled in, which is not what anyone reading this wants to know.
// The real assignment is unit-tested; this measures supply.
//
// Usage (staging is the default target; it is the environment the design was measured against):
//   bash scripts/three-things-pool-probe.sh
//   bash scripts/three-things-pool-probe.sh --base https://example.test --json
//   bash scripts/three-things-pool-probe.sh --radius 5 --lat 49.2827 --lng -123.1207

import { isFree } from '../lib/search/filters/cost';
import { isShowableOnFrontDoor } from '../lib/recommend/three-things';
import { DEFAULT_NEARBY_RADIUS_KM } from '../lib/recommend/three-things';

const DEFAULT_BASE = 'https://kids-fun-staging-jdci-nc.vercel.app';
/** Ruling 7.4's coordinate, and the one docs/answer-before-search-design.md §2d measured from. */
const DEFAULT_ORIGIN = { lat: 49.2827, lng: -123.1207 };

interface Row {
  listing: {
    id: string;
    activityName: string;
    venueName: string;
    statusState: string;
    ageMinMonths: number | null;
    ageMaxMonths: number | null;
    ageNotes?: string | null;
    costStatus: 'known' | 'free' | 'unknown' | 'check_source';
    costMinCad: number | null;
    costMaxCad: number | null;
  };
}

interface Body {
  total: number;
  results: Row[];
  broadening: { applied: unknown[] };
}

interface SlotReport {
  slot: string;
  query: string;
  /** `SearchResponse.total` — every card the engine reached, before any gate of ours. */
  reached: number;
  /** Rows returned in this page (the API clamps `limit` to 100). */
  returned: number;
  /** Rows that survive the front-door gate, and the slot's own predicate where it has one. */
  showable: number;
  /** The first few, so a reader can sanity-check WHAT is holding the slot up, not just how many. */
  sample: string[];
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function fetchSlot(base: string, params: Record<string, string>): Promise<Body> {
  // `minResults=0` on every call, for the same reason the feature itself passes it: a probe that
  // let the broadening ladder fire would measure a pool the product would never show.
  const qs = new URLSearchParams({ q: '', limit: '100', minResults: '0', ...params });
  const res = await fetch(`${base}/api/search?${qs}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET /api/search?${qs} → ${res.status}`);
  return (await res.json()) as Body;
}

async function main(): Promise<void> {
  const base = arg('base', DEFAULT_BASE)!;
  const asJson = process.argv.includes('--json');
  const lat = arg('lat', String(DEFAULT_ORIGIN.lat))!;
  const lng = arg('lng', String(DEFAULT_ORIGIN.lng))!;
  const radius = arg('radius', String(DEFAULT_NEARBY_RADIUS_KM))!;

  const slots: Array<{ slot: string; params: Record<string, string>; extra?: (r: Row) => boolean }> = [
    { slot: 'free', params: { when: 'today', free: '1' }, extra: (r) => isFree(r.listing) },
    // NO ORIGIN, NO RADIUS — this is the citywide-vs-radius decision the ruling made, expressed as
    // the absence of two params. If someone adds them here, the number below is what changes.
    { slot: 'indoor', params: { when: 'today', rainy: '1' } },
    { slot: 'nearby', params: { when: 'today', lat, lng, radius, sort: 'distance' } },
  ];

  const reports: SlotReport[] = [];
  for (const { slot, params, extra } of slots) {
    const body = await fetchSlot(base, params);
    if (body.broadening.applied.length > 0) {
      throw new Error(`${slot}: the engine broadened a minResults=0 request — the probe is measuring the wrong pool`);
    }
    const showable = body.results.filter((r) => isShowableOnFrontDoor(r.listing) && (extra ? extra(r) : true));
    reports.push({
      slot,
      query: new URLSearchParams(params).toString(),
      reached: body.total,
      returned: body.results.length,
      showable: showable.length,
      sample: showable.slice(0, 3).map((r) => `${r.listing.activityName} · ${r.listing.venueName}`),
    });
  }

  const indoor = reports.find((r) => r.slot === 'indoor')!;

  if (asJson) {
    console.log(JSON.stringify({ base, measuredAtUtc: new Date().toISOString(), slots: reports }, null, 2));
  } else {
    console.log(`three-things pool probe — ${base} — ${new Date().toISOString()}`);
    console.log('(reached = what the engine found; showable = what the front door may actually print)\n');
    for (const r of reports) {
      console.log(`  ${r.slot.padEnd(7)} reached ${String(r.reached).padStart(5)}   showable ${String(r.showable).padStart(4)}   ?${r.query}`);
      for (const s of r.sample) console.log(`          · ${s}`);
      if (r.returned < r.reached) {
        console.log(`          (showable counted over the first ${r.returned} of ${r.reached}; the API clamps limit to 100)`);
      }
    }
  }

  if (indoor.showable === 0) {
    console.error(
      '\nFAIL: the indoor slot has NOTHING showable citywide today.\n' +
        'This is the condition Jon\'s 2026-08-19 ruling accepted a thin pool in order to avoid.\n' +
        'The block degrades honestly (the slot renders its empty state, ruling 7.5) so nothing is\n' +
        'broken — but the front door is now offering two things, not three, and somebody should\n' +
        'know that rather than discover it from a screenshot.',
    );
    process.exit(1);
  }
  console.log(`\nOK: the indoor slot has ${indoor.showable} showable card(s) citywide.`);
}

main().catch((err) => {
  console.error(`three-things-pool-probe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
