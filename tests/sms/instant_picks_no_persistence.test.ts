// tests/sms/instant_picks_no_persistence.test.ts — what an Instant Picks press may and may not
// write, enforced on the IMPORT GRAPH.
//
// ═══ ⚠ THIS FILE USED TO ASSERT "THE ROUTE CANNOT REACH A SEND-LOG WRITER AT ALL" ═══
// That was correct while the feature was page-only, and it is NOT correct now: Jon ruled the
// button also sends a text (PRD v3.22), CASL requires an append-only record that it went out, and
// migration 0049 adds the send_type to carry it. The old assertion has therefore been REPLACED
// rather than relaxed — and the replacement is deliberately narrower, not weaker.
//
// ⚠⚠ AND HERE IS THE DEFECT THAT WOULD HAVE HAPPENED BY DEFAULT, WRITTEN DOWN BECAUSE IT ACTUALLY
//    OCCURRED DURING THIS BUILD: the old patterns matched literal `from './send-log'`-style
//    imports on the route file. The moment the route reached the send log INDIRECTLY — via
//    lib/sms/instant-picks-send.ts — every one of those patterns kept passing, and the suite stayed
//    green while the guarantee it described had been gone for an hour. A guard that only sees
//    direct imports stops guarding the moment somebody adds one layer. So the route's half of this
//    file now walks the graph TRANSITIVELY (see `reachableFrom`), which is what the original
//    file's own header claimed to be doing — "a module that cannot reach a writer cannot call one
//    on any branch".
//
// ═══ WHY THIS IS STATIC AND NOT ONLY BEHAVIOURAL ═══
// Unchanged, and it is the reason the file exists. "Does not write X" is a NEGATIVE property, and
// a behavioural test can only prove the writer was not called on the paths it thought to exercise.
// A press that persisted only on, say, the widened-retry branch would sail past a suite that never
// produced one. The import graph is where the property is TOTAL.
//
// ═══ THE DEFECT THIS EXISTS TO PREVENT, STATED ONCE PROPERLY ═══
// `sms_send_log` is what the "Last Friday" panel READS FROM (`findLastWeek` in
// lib/sms/preferences.ts), and the Instant Picks button sits INSIDE that panel. A press recorded
// there under a send_type that panel reads would appear to the subscriber as a text we had decided
// to send them, and would land in PRD §6's send and click-through metrics as a message that never
// existed. That is why the audit row uses a FOURTH send_type the panel does not select — see
// tests/sms/instant_picks_send_log_invariants.test.ts, which owns that half.
//
// If this test fails, do NOT relax the patterns. The named file has grown a reach it must not
// have, and the fix is in that file.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(ROOT + rel, 'utf8');

/** Anything that can put a row in `sms_send_log`, or send a message that would produce one. */
const WRITERS = [
  { what: 'the send-log writer', re: /from\s+['"](\.\/send-log|@\/lib\/sms\/send-log)['"]/ },
  { what: 'the Twilio client', re: /from\s+['"](\.\/twilio-client|@\/lib\/sms\/twilio-client)['"]/ },
  { what: 'the message renderer', re: /from\s+['"](\.\/message|@\/lib\/sms\/message)['"]/ },
  { what: 'the weekly send orchestrator', re: /from\s+['"].*\/weekly-send(-io)?['"]/ },
  { what: 'the click recorder', re: /recordClick/ },
  { what: 'a raw send-log statement', re: /sms_send_log/ },
];

/** A value import of the pool. Type-only imports are fine — they cannot execute a query. */
const DB_IMPORT = /^import\s+(?!type\b)[^;]*from\s+['"]@\/lib\/db\/client['"]/m;

describe('instant picks · the selection half still cannot write to sms_send_log', () => {
  // ⚠ THE ROUTE IS NO LONGER IN THIS LIST, AND THAT IS THE ONLY THING THAT CHANGED. Everything
  // that produces the LIST is still totally unable to reach a writer, which is the guarantee that
  // was actually protecting the "Last Friday" panel: the selector, its read, its throttle and its
  // UI cannot persist anything on any branch, and the send is a separate module the route calls
  // after the list is already in hand.
  for (const file of [
    '/lib/sms/instant-picks.ts',
    '/lib/sms/instant-picks-store.ts',
    '/lib/sms/instant-picks-throttle.ts',
    '/app/u/[preferencesToken]/_components/InstantPicks.tsx',
  ]) {
    describe(file, () => {
      const src = read(file);
      for (const { what, re } of WRITERS) {
        it(`does not reach ${what}`, () => {
          // Comments in these files discuss the send log at length on purpose — that is how the
          // reasoning survives. Strip them so the discussion is not mistaken for the defect.
          expect(stripComments(src)).not.toMatch(re);
        });
      }
    });
  }

  it('the pure selection wrapper imports no database seam at all', () => {
    // The strongest form of the guarantee, and only the pure module can carry it: the store and
    // the throttle legitimately need the pool (one read, one counter), so their guarantee is the
    // per-writer one above. This one cannot reach ANY table.
    expect(read('/lib/sms/instant-picks.ts')).not.toMatch(DB_IMPORT);
  });

  it('the client component cannot reach the server-only send module either', () => {
    // It restates the `sendStatus` union locally rather than importing it, precisely so the pg
    // pool, the Twilio SDK and the send-log writer stay out of the browser bundle's graph. A
    // `import type` would be erased and harmless; a value import would not be, so this pins the
    // absence of the module name entirely.
    const src = stripComments(read('/app/u/[preferencesToken]/_components/InstantPicks.tsx'));
    expect(src).not.toMatch(/instant-picks-send/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE ROUTE — one writer, reached one way
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every first-party module reachable from `entry`, following relative and `@/`-aliased imports.
 *
 * WALKS THE GRAPH RATHER THAN READING ONE FILE, for the reason in this file's header: a direct-
 * import check stops being true the moment somebody adds a layer, and it stops SILENTLY. Skips
 * `import type` lines — a type import is erased at build time and cannot execute anything.
 *
 * ═══ STATIC AND DYNAMIC REACHES ARE COUNTED SEPARATELY, AND THE DISTINCTION IS REAL ═══
 * A top-level `import` is loaded on every request that touches the module — it is cold-start cost
 * and it is what "this route can run that code" means on the ordinary path. An
 * `await import('...')` inside a branch is code-split and loads only if that branch runs.
 * lib/sms/instant-picks-send.ts uses one deliberately, to keep lib/sms/weekly-send-io.ts's
 * SearchEngine-and-repositories graph off the press path for the sake of one UPDATE on the
 * carrier-opt-out branch. Folding the two together would make that engineering invisible here and
 * would report a cost this route does not pay.
 */
function reachableFrom(entry: string, { includeDynamic = false } = {}): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const rel = queue.shift()!;
    if (seen.has(rel)) continue;
    seen.add(rel);

    let src: string;
    try {
      src = read(rel);
    } catch {
      continue; // a package, or a path shape this resolver does not model. Not first-party.
    }
    const body = stripComments(src);
    for (const m of body.matchAll(/^\s*import\s+(?!type\b)[\s\S]*?from\s+['"]([^'"]+)['"]/gm)) {
      const resolved = resolve(rel, m[1]);
      if (resolved) queue.push(resolved);
    }
    if (includeDynamic) {
      for (const m of body.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const resolved = resolve(rel, m[1]);
        if (resolved) queue.push(resolved);
      }
    }
  }
  return seen;
}

/** Does this module VALUE-import the shared `sms_send_log` writer? (Defining it does not count.) */
const IMPORTS_SEND_LOG = /^\s*import\s+(?!type\b)[\s\S]*?from\s+['"](\.\/send-log|@\/lib\/sms\/send-log)['"]/m;

/** `@/x` → `/x`, `./y` → sibling of `from`. Returns null for a bare package specifier. */
function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) {
    base = '/' + spec.slice(2);
  } else if (spec.startsWith('.')) {
    const dir = from.slice(0, from.lastIndexOf('/'));
    const parts = (dir + '/' + spec).split('/');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') out.pop();
      else out.push(p);
    }
    base = '/' + out.join('/');
  } else {
    return null;
  }
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    try {
      readFileSync(ROOT + base + ext, 'utf8');
      return base + ext;
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

describe('instant picks · the route reaches a send-log writer exactly one way', () => {
  const ROUTE = '/app/api/sms/instant-picks/route.ts';
  const graph = reachableFrom(ROUTE);

  it('the walker actually walked something — a sanity check on itself', () => {
    // A resolver that silently returned null for everything would make every assertion below pass
    // vacuously, which is the failure mode of a guard that walks a graph.
    expect(graph.size).toBeGreaterThan(5);
    expect(graph).toContain('/lib/sms/instant-picks-store.ts');
    expect(graph).toContain('/lib/sms/instant-picks.ts');
  });

  it('the send module is the ONLY first-party module on the route that writes sms_send_log', () => {
    // lib/sms/send-log.ts DEFINES the writer; this asks who REACHES it. Exactly one module may, so
    // the send_type and picks_snapshot invariants have exactly one place to be got wrong. A second
    // name appearing here means a second audit-row shape exists on this path.
    const writers = [...graph]
      .filter((f) => f !== '/lib/sms/send-log.ts' && IMPORTS_SEND_LOG.test(read(f)))
      .sort();
    expect(writers).toEqual(['/lib/sms/instant-picks-send.ts']);
  });

  it('the weekly send orchestrator is NOT on the press path — only behind the 21610 branch', () => {
    // lib/sms/weekly-send-io.ts top-level imports the SearchEngine, both listing repositories, the
    // alias resolver and the region hierarchy. Round 12 flagged that graph leaking into unrelated
    // callers and round 16 acted on it. The Instant Picks route runs on every press and the press
    // that matters is the PAGE RENDER, so the one thing it needs from that module
    // (`markStoppedViaCarrier`, on a branch that fires when a carrier-suppressed number holds a
    // live preferences link) is reached through a dynamic import instead.
    expect(graph).not.toContain('/lib/sms/weekly-send-io.ts');
    // ...and it IS genuinely still reachable, so this is a statement about WHEN it loads rather
    // than a claim that the opt-out safeguard was dropped.
    expect(reachableFrom(ROUTE, { includeDynamic: true })).toContain('/lib/sms/weekly-send-io.ts');
  });

  it('the route file itself still contains no SQL and no direct dispatch', () => {
    const src = stripComments(read(ROUTE));
    expect(src).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i);
    expect(src).not.toMatch(/dispatchSms|recordSmsSend|renderWeeklyMessage/);
    expect(src).toMatch(/checkAndRecordInstantPicks/);
    expect(src).toMatch(/sendInstantPicksText/);
  });

  it('the one send-log call on this route writes send_type instant_picks and a NULL snapshot', () => {
    const src = stripComments(read('/lib/sms/instant-picks-send.ts'));
    expect(src).toMatch(/sendType:\s*'instant_picks'/);
    expect(src).toMatch(/picksSnapshot:\s*null/);
    // No other send_type may be written from this module, and no snapshot may ever be attached:
    // 0035's CHECK rejects the latter, and the weekly novelty filter would silently break if that
    // CHECK were ever widened to permit it. See migration 0049.
    expect(src.match(/sendType:/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(/picksSnapshot:(?!\s*null\b)/);
  });

  it('the selector is still not reachable from the send module', () => {
    // The text carries no activity names (Jon's D3 ruling), so nothing about what was selected
    // should be able to reach the thing that composes it — which also means the message cannot
    // leak a child's age, an area, or a pick, and is identical for every recipient.
    const sendGraph = reachableFrom('/lib/sms/instant-picks-send.ts');
    expect(sendGraph).not.toContain('/lib/sms/instant-picks.ts');
    expect(sendGraph).not.toContain('/lib/sms/instant-picks-store.ts');
  });
});

/** Block and line comments removed; string literals are left alone. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
