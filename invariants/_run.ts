// invariants/_run.ts — One engine per pinned clock, one walk of the query space, memoised.
//
// Every invariant file wants the same thing: "the response for this selection, at this clock".
// Building the corpus and walking the space once per invariant would multiply the runtime by the
// number of invariants for no extra coverage, so the walk happens once per (clock, ladder mode)
// and every invariant reads the same responses. Memoisation is safe precisely BECAUSE the
// responses are deterministic — which is itself one of the invariants asserted (see algebra).

import type { ListingRecord } from '../lib/search/types';
import { SearchEngine, type SearchResponse } from '../lib/search/engine';
import { buildCorpus, makeEngine } from './_corpus';
import { querySpace, toRequest, type Query } from './_space';
import { CLOCKS, type Clock } from './_harness';

/**
 * How many full combinations are drawn per clock, on top of the exhaustive spine.
 *
 * Chosen for runtime, not for confidence: the space is 752,640 selections and this suite runs on
 * every push through a report-only lane, so it has to stay in seconds. `coverageNote()` prints
 * the fraction so nobody has to infer it, and raising this number is the only knob — coverage
 * grows linearly with it.
 */
export const SAMPLE_SIZE = 160;
export const SAMPLE_SEED = 8_18_2026;

export interface Case {
  clock: Clock;
  query: Query;
  response: SearchResponse;
}

export interface ClockRun {
  clock: Clock;
  engine: SearchEngine;
  corpus: ListingRecord[];
  byId: Map<string, ListingRecord>;
}

const runs = new Map<string, ClockRun>();

/** The engine + corpus for a clock. The corpus is generated AROUND the clock — see _corpus.ts. */
export function runFor(clock: Clock): ClockRun {
  const existing = runs.get(clock.label);
  if (existing) return existing;
  const corpus = buildCorpus(clock.utc);
  const run: ClockRun = {
    clock,
    engine: makeEngine(corpus),
    corpus,
    byId: new Map(corpus.map((l) => [l.id, l])),
  };
  runs.set(clock.label, run);
  return run;
}

const spaces = new Map<number, Case[]>();

/**
 * Every (clock × selection) response for a ladder mode.
 *
 * `minResults: 3` is the /search default and the mode in which the broadening ladder can fire —
 * the DISCLOSURE invariants need it, because there is nothing to disclose without it.
 * `minResults: 0` is the digest's documented opt-out, and it is the mode the ALGEBRA invariants
 * need: broadening legitimately ADDS results the caller did not ask for, so a subset property
 * asserted with the ladder live would be a statement about padding rather than about filtering.
 */
export function casesFor(minResults: number): Case[] {
  const cached = spaces.get(minResults);
  if (cached) return cached;
  const queries = querySpace(SAMPLE_SIZE, SAMPLE_SEED);
  const out: Case[] = [];
  for (const clock of CLOCKS) {
    const { engine } = runFor(clock);
    for (const query of queries) {
      out.push({ clock, query, response: engine.search(toRequest(query, clock.utc, { minResults })) });
    }
  }
  spaces.set(minResults, out);
  return out;
}

/** A single ad-hoc search at a clock — for the metamorphic pairs, which build their own queries. */
export function searchAt(clock: Clock, query: Query, minResults: number, facets = false): SearchResponse {
  return runFor(clock).engine.search(toRequest(query, clock.utc, { minResults, facets }));
}
