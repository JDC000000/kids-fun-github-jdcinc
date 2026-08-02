// worker/health/sla.ts — G-T15-3: CANONICAL worker-side source-health SLA (TSD §7.2, §12.5).
// Per-source health = cadence adherence + check-success rate + parse yield, over a rolling
// window, plus the aggregate SLA target: ≥95% of P0 sources checked within their cadence.
//
// Relationship to lib/admin/data-health.ts (Round 17/T33): that file is the READ path for
// the /admin/data-health page and computes ONE dimension — the "% of enabled sources on
// cadence" rollup — via its own isCadenceAdherent. This file is the broader operational
// computation the worker runs (three dimensions + a writable health_state). We deliberately
// keep them as two paths rather than have the Next app import from worker/ (the codebase
// isolates worker/: tsconfig excludes it, eslint ignores it, and nothing in app/lib imports
// it — introducing an app→worker build edge to share a 4-line predicate is worse than the
// duplication). The cadence-adherence formula here is byte-for-byte the same as
// data-health.ts's, and tests/health/sla-consistency.test.ts asserts the two predicates
// agree across a table of inputs, so they can never silently diverge. See findings doc.
import type { Pool } from 'pg';

/** §12.5 / T15 target: ≥95% of P0 sources checked within their cadence. */
export const HEALTH_SLA_TARGET_PCT = 95;

/**
 * Cadence-adherence grace (× cadence). Identical to lib/admin/data-health.ts
 * SLA_CADENCE_GRACE (the guard test pins this).
 *
 * This was 1 ("strict on-time"), which is UNSATISFIABLE IN STEADY STATE and was measured
 * doing real damage. The scheduler fires a source one cadence after the last fire, so the
 * observed gap between consecutive successes is `cadence + jitter` where jitter is
 * structurally ≥ 0 (tick alignment, queueing, the run's own duration). Demanding
 * gap ≤ 1× cadence is therefore demanding jitter ≤ 0. Measured on 2026-08-01:
 *   • production, every source, every run since launch: gap 1440.4–1441.0 min against a
 *     1440 min cadence → adherent=false 100% of the time, invisibly;
 *   • staging hourly sources: gaps 58.97–63.75 min against 60 min → adherent flickered
 *     run-to-run on ~30 SECONDS of jitter.
 * Adherence is worth 0.30 of computeSourceHealth, and worker/core/confidence.ts multiplies
 * that health in, so a coin-flip boolean was moving the confirmed/needs_review threshold by
 * ~46% and reclassifying thousands of user-visible occurrences every run.
 *
 * 1.5 absorbs scheduler drift (a source running exactly on cadence IS on cadence) while
 * still failing a source that has genuinely skipped a whole cycle (gap ≈ 2× cadence).
 * The documented gradient becomes: adherent (≤1.5×) → lagging (1.5–2×) → stale (>2×).
 */
export const SLA_CADENCE_GRACE = 1.5;

/** Fallback cadence when a source has none configured. Mirrors lib/admin DEFAULT_CADENCE_SECONDS. */
export const DEFAULT_CADENCE_SECONDS = 24 * 60 * 60;

/** Default rolling window for success-rate / parse-yield stats. */
export const HEALTH_WINDOW_DAYS = 7;

/** The health_state labels — mirrors the source.health_state CHECK set (0003_core_places.sql). */
export type HealthState = 'healthy' | 'degraded' | 'stale' | 'failing' | 'unknown';

// ─────────────────────────────────────────────────────────────────────────────
// Pure dimensions — DB-free, exhaustively unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

/** [0,1] clamp that also absorbs NaN (→ 0), so no dimension can poison the score. */
function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export interface CadenceInput {
  lastSuccessAtMs: number | null;
  cadenceSeconds: number | null;
}

/**
 * CONTINUOUS cadence adherence in [0,1] — how well a source is keeping its promised
 * schedule, as a gradient rather than a switch. This is the value computeSourceHealth
 * scores; cadenceAdherent() below is the pass/fail SLA view of the same number.
 *
 *   let x = (now − lastSuccess) ÷ cadence          "how many cadences late"
 *   adherence = 1                 for x ≤ grace    (on time, including scheduler jitter)
 *             = grace ÷ x         for x > grace    (reciprocal decay → 0)
 *   never succeeded → 0
 *
 * WHY THIS SHAPE.
 *  • It mirrors worker/core/confidence.ts freshnessFactor(), which is already a
 *    plateau-then-reciprocal-decay function. Reusing the project's existing idiom for
 *    "make lateness gradual" rather than inventing a second one.
 *  • It introduces NO new constant. The decay is pinned to SLA_CADENCE_GRACE, which
 *    already exists and is not changed here. grace ÷ x equals exactly 1 at x = grace, so
 *    the curve joins the plateau with no step — there is nothing to tune and nothing to
 *    drift. The confusion this measure has caused historically came from magic
 *    thresholds; this adds none.
 *  • It is 1.0 across the ENTIRE window the boolean called adherent, so the meaning of
 *    SLA_CADENCE_GRACE (and every board that reports it) is untouched.
 *
 * WHY IT WAS NEEDED. Adherence is worth 0.30 of computeSourceHealth and confidence
 * MULTIPLIES that health in as `volatility`, so as a 0/1 switch it moved every one of a
 * source's occurrences at once. Measured on real staging history 2026-08-01: the worst
 * gap still inside grace is 1.4626× against the 1.5× boundary — 0.037× of headroom, so
 * the switch was one bad night from flipping again — and H.R. MacMillan Space Centre had
 * already recorded a 2.0005× gap, i.e. a full 0.30 health drop for ONE missed nightly
 * run. That source now scores 0.75 here instead of 0.
 *
 * NO FLOOR, deliberately. freshnessFactor floors at 0.2 because confidence multiplies it
 * and a zero would annihilate the whole product; computeSourceHealth ADDS this term, so a
 * zero is harmless — and a floor would let a source that has been dead for months keep
 * earning health it is not delivering, which the boolean never did.
 */
export function adherenceFactor(
  input: CadenceInput,
  nowMs: number,
  grace: number = SLA_CADENCE_GRACE
): number {
  if (input.lastSuccessAtMs == null) return 0; // never delivered anything
  const cadence =
    input.cadenceSeconds != null && input.cadenceSeconds > 0 ? input.cadenceSeconds : DEFAULT_CADENCE_SECONDS;
  const thresholdMs = cadence * 1000 * grace;
  const elapsedMs = Math.max(0, nowMs - input.lastSuccessAtMs); // clock skew → "on time"
  // NB: compared in the same multiplied form the boolean has always used, so the
  // pass/fail verdict at the boundary is bit-for-bit what shipped (no divide-then-compare
  // rounding difference). thresholdMs ÷ elapsedMs is algebraically grace ÷ x.
  if (elapsedMs <= thresholdMs) return 1;
  return clamp01(thresholdMs / elapsedMs);
}

/** The SLA's pass/fail reading of an adherence factor: "is this source on cadence?" */
export function isFullyAdherent(adherence: number): boolean {
  return adherence >= 1;
}

/**
 * Cadence adherence, pass/fail: a source is adherent iff it has a successful/partial check
 * within grace × its effective cadence. A source that has NEVER succeeded is NOT adherent.
 *
 * Behaviour is UNCHANGED by the continuous rewrite — it is now simply the "at full value"
 * reading of adherenceFactor, so the two can never disagree about where the SLA boundary
 * is. tests/health/adherence-continuous.test.ts pins it against the original formula.
 * This is the SAME formula as lib/admin/data-health.ts isCadenceAdherent (guard-tested
 * for parity, along with adherenceFactor itself).
 */
export function cadenceAdherent(
  input: CadenceInput,
  nowMs: number,
  grace: number = SLA_CADENCE_GRACE
): boolean {
  return isFullyAdherent(adherenceFactor(input, nowMs, grace));
}

export interface RunCounts {
  /** Completed runs (success + partial + failed) in the window. Excludes still-'running'. */
  attempted: number;
  /** success + partial. */
  succeeded: number;
  /** success/partial runs that actually parsed ≥1 record. */
  withRecords: number;
}

/** Check-success rate = succeeded ÷ attempted, or null when nothing was attempted. */
export function checkSuccessRate(counts: RunCounts): number | null {
  if (counts.attempted <= 0) return null;
  return counts.succeeded / counts.attempted;
}

/** Parse yield = successful runs that produced records ÷ successful runs, or null when
 *  there were no successful runs (nothing to have yielded from). */
export function parseYieldRate(counts: RunCounts): number | null {
  if (counts.succeeded <= 0) return null;
  return counts.withRecords / counts.succeeded;
}

export interface SourceHealthInput {
  /** adherenceFactor() — continuous in [0,1], NOT a boolean (see that function). */
  adherence: number;
  successRate: number | null;
  parseYieldRate: number | null;
  attempted: number;
}

export interface SourceHealth {
  state: HealthState;
  /** Transparent composite in [0,1], or null when there's no data to score. */
  score: number | null;
}

/**
 * Fold the three dimensions into a health_state + transparent score. Precedence:
 *   unknown (no completed runs) → failing (mostly failing) → stale (not fully adherent) →
 *   degraded (adherent but imperfect success/low yield) → healthy.
 * score = 0.5·successRate + 0.3·adherence + 0.2·parseYield (each ∈ [0,1]).
 *
 * The SCORE is continuous in adherence (that is the whole point of adherenceFactor —
 * confidence multiplies this score in, so a step here mass-reclassifies user-visible
 * rows). The STATE deliberately is not: health_state answers the operational SLA
 * question "is this source meeting its cadence, yes or no", which is genuinely pass/fail,
 * and every board and the ≥95% P0 target are built on that reading. So the gradient goes
 * into the number and the verdict stays a verdict.
 */
export function computeSourceHealth(input: SourceHealthInput): SourceHealth {
  if (input.attempted <= 0 || input.successRate == null) {
    return { state: 'unknown', score: null };
  }
  const yieldRate = input.parseYieldRate ?? 0;
  const adherence = clamp01(input.adherence); // defensive: never let a bad input skew the score
  const score = 0.5 * input.successRate + 0.3 * adherence + 0.2 * yieldRate;
  const rounded = Math.round(score * 100) / 100;

  let state: HealthState;
  if (input.successRate < 0.5) state = 'failing';
  else if (!isFullyAdherent(adherence)) state = 'stale';
  else if (input.successRate < 0.9 || yieldRate < 0.5) state = 'degraded';
  else state = 'healthy';
  return { state, score: rounded };
}

/** Whole-number percentage numer/denom, or null when denom ≤ 0. */
export function adherencePct(adherent: number, total: number): number | null {
  if (!Number.isFinite(adherent) || !Number.isFinite(total) || total <= 0) return null;
  return Math.round((adherent / total) * 100);
}

/** Does an adherence % meet the SLA target? A null % (no P0 sources) does not. */
export function meetsSlaTarget(pct: number | null, target: number = HEALTH_SLA_TARGET_PCT): boolean {
  return pct != null && pct >= target;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed computation.
// ─────────────────────────────────────────────────────────────────────────────

/** "Live/enabled" sources = the set the scheduler actually runs (terms allowed or
 *  summarise-only). Broader than the dashboard's 'allowed'-only display filter — this is
 *  operational health of everything that RUNS. */
export const ENABLED_TERMS_STATUSES = ['allowed', 'summarise_only'] as const;

/** P0 = official-authority sources (the municipal recreation sources the SLA targets). */
export const P0_AUTHORITY_TIER = 'official';

export interface SourceHealthRow {
  sourceId: string;
  name: string;
  family: string;
  authorityTier: string;
  isP0: boolean;
  cadenceSeconds: number | null;
  lastSuccessAt: string | null;
  /** Pass/fail SLA verdict — the ≥95% P0 target counts these. */
  adherent: boolean;
  /** The continuous [0,1] measure that actually feeds the health score. */
  adherence: number;
  counts: RunCounts;
  successRate: number | null;
  parseYieldRate: number | null;
  health: SourceHealth;
}

export interface HealthSla {
  targetPct: number;
  windowDays: number;
  /** All enabled sources scored. */
  enabledCount: number;
  /** P0 (official) enabled sources — the SLA denominator. */
  p0Count: number;
  p0AdherentCount: number;
  /** p0Adherent ÷ p0Count as a whole %, or null when there are no P0 sources. */
  p0AdherencePct: number | null;
  meetsTarget: boolean;
  /** Per-source detail, worst-health first. */
  sources: SourceHealthRow[];
}

interface RawHealthRow {
  id: string;
  name: string;
  family: string;
  authority_tier: string;
  terms_status: string;
  cadence_seconds: number | null;
  last_success_at: Date | null;
  attempted: number | null;
  succeeded: number | null;
  with_records: number | null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const HEALTH_RANK: Record<HealthState, number> = {
  failing: 0,
  stale: 1,
  unknown: 2,
  degraded: 3,
  healthy: 4,
};

/**
 * Compute the source-health SLA across all enabled sources over a rolling window. Cadence,
 * last-success and per-window run counts come from source / source_check_run (ground truth);
 * every score is derived in TS via the pure helpers so it stays unit-testable + consistent.
 */
export async function computeHealthSla(
  pool: Pool,
  nowMs: number = Date.now(),
  opts: { windowDays?: number } = {}
): Promise<HealthSla> {
  const windowDays = opts.windowDays ?? HEALTH_WINDOW_DAYS;
  const { rows } = await pool.query<RawHealthRow>(
    `SELECT
       s.id,
       s.name,
       s.family,
       s.authority_tier,
       s.terms_status,
       extract(epoch FROM COALESCE(s.near_date_cadence, s.baseline_cadence))::float8 AS cadence_seconds,
       success.last_success_at,
       stats.attempted,
       stats.succeeded,
       stats.with_records
     FROM source s
     LEFT JOIN LATERAL (
       SELECT max(started_at) AS last_success_at
       FROM source_check_run cr
       WHERE cr.source_id = s.id AND cr.status IN ('success', 'partial')
     ) success ON true
     LEFT JOIN LATERAL (
       SELECT
         count(*) FILTER (WHERE cr.status IN ('success', 'partial', 'failed'))::int AS attempted,
         count(*) FILTER (WHERE cr.status IN ('success', 'partial'))::int            AS succeeded,
         count(*) FILTER (WHERE cr.status IN ('success', 'partial')
                            AND COALESCE(cr.records_found, 0) > 0)::int               AS with_records
       FROM source_check_run cr
       WHERE cr.source_id = s.id
         AND cr.started_at >= now() - ($1::int * interval '1 day')
     ) stats ON true
     WHERE s.terms_status = ANY($2::text[])
     ORDER BY s.name`,
    [windowDays, ENABLED_TERMS_STATUSES as unknown as string[]]
  );

  const sources: SourceHealthRow[] = rows.map((r) => {
    const counts: RunCounts = {
      attempted: r.attempted ?? 0,
      succeeded: r.succeeded ?? 0,
      withRecords: r.with_records ?? 0,
    };
    const lastSuccessAt = toIso(r.last_success_at);
    const cadenceSeconds = r.cadence_seconds ?? null;
    const cadenceInput = {
      lastSuccessAtMs: lastSuccessAt ? Date.parse(lastSuccessAt) : null,
      cadenceSeconds,
    };
    // One computation, two readings: the continuous score and its pass/fail SLA verdict.
    const adherence = adherenceFactor(cadenceInput, nowMs);
    const adherent = isFullyAdherent(adherence);
    const successRate = checkSuccessRate(counts);
    const yieldRate = parseYieldRate(counts);
    const health = computeSourceHealth({ adherence, successRate, parseYieldRate: yieldRate, attempted: counts.attempted });
    return {
      sourceId: r.id,
      name: r.name,
      family: r.family,
      authorityTier: r.authority_tier,
      isP0: r.authority_tier === P0_AUTHORITY_TIER,
      cadenceSeconds,
      lastSuccessAt,
      adherent,
      adherence,
      counts,
      successRate,
      parseYieldRate: yieldRate,
      health,
    };
  });

  // Worst health first (then non-adherent, then name) so a human sees problems on top.
  sources.sort(
    (a, b) =>
      HEALTH_RANK[a.health.state] - HEALTH_RANK[b.health.state] ||
      Number(a.adherent) - Number(b.adherent) ||
      a.name.localeCompare(b.name)
  );

  const p0 = sources.filter((s) => s.isP0);
  const p0AdherentCount = p0.reduce((n, s) => n + (s.adherent ? 1 : 0), 0);
  const p0Pct = adherencePct(p0AdherentCount, p0.length);

  return {
    targetPct: HEALTH_SLA_TARGET_PCT,
    windowDays,
    enabledCount: sources.length,
    p0Count: p0.length,
    p0AdherentCount,
    p0AdherencePct: p0Pct,
    meetsTarget: meetsSlaTarget(p0Pct),
    sources,
  };
}

/**
 * Persist each source's computed health_state onto source.health_state (currently an
 * unmaintained column — lib/admin/dashboard.ts notes it "isn't actively maintained yet").
 * A single batched UPDATE via unnest. Returns the number of rows whose state changed.
 */
export async function applyHealthStates(
  pool: Pool,
  sla: HealthSla
): Promise<number> {
  if (sla.sources.length === 0) return 0;
  const ids = sla.sources.map((s) => s.sourceId);
  const states = sla.sources.map((s) => s.health.state);
  const { rowCount } = await pool.query(
    `UPDATE source s
        SET health_state = v.state
       FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS state) v
      WHERE s.id = v.id
        AND s.health_state IS DISTINCT FROM v.state`,
    [ids, states]
  );
  return rowCount ?? 0;
}
