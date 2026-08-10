// lib/llm/config.ts — environment + tuning constants for the nightly LLM-assisted
// batch job (T14-2 dedup adjudication + T13-5 age-parse fallback).
//
// One place that knows every LLM-batch env var, mirroring lib/analytics/config.ts and
// lib/email/config.ts. Nothing here returns a secret to a caller that would print it —
// batchCronSecret() is only compared, in constant time, inside the run route; the
// Anthropic key is read by the client factory (lib/llm/anthropic-client.ts) and never
// logged.
//
// Env vars (all added to .env.example):
//   LLM_BATCH_MODEL         — the model id. DEFAULT + hard requirement: a Haiku model
//                             (Jon's constraint: classification/matching/extraction is
//                             right-sized for Haiku; never Sonnet/Opus). A non-Haiku
//                             override throws at read time.
//   LLM_BATCH_CRON_SECRET   — shared secret guarding POST /api/llm/batch/run.
//   LLM_BATCH_ENABLED       — "true" permits REAL Message-Batches submission; anything
//                             else forces detection-only DRY-RUN (mirrors
//                             WEEKLY_EMAIL_ENABLED). Stays off until the Anthropic
//                             credential is provisioned and an operator flips it on.
//   LLM_BATCH_DRY_RUN       — "true" forces dry-run regardless of caller/enabled state
//                             (an operator kill-switch to observe candidate volumes
//                             without any writes or any API call).
//   ANTHROPIC_API_KEY       — the Haiku-scoped key (credential slug `kids-fun-anthropic`).
//                             UNSET today: the client factory then returns an
//                             "unprovisioned" client that throws loudly on use, so a
//                             real API call is impossible by accident.
//   LLM_BATCH_MAX_CANDIDATES — safety cap on how many candidate records one run submits
//                              to a single batch (bounds cost + blast radius).

/** The mandated model. Haiku-only for this classification/matching/extraction work. */
export const DEFAULT_LLM_BATCH_MODEL = 'claude-haiku-4-5';

/**
 * Auto-merge a fuzzy duplicate pair ONLY when the model is this confident (≥). A high
 * bar because a merge archives a listing — the irreversible-leaning direction. Below it,
 * the pair is routed to the existing human QA queue rather than guessed. (Conservative
 * first version; tune with real usage signal in a later round.)
 */
export const DEDUP_AUTO_MERGE_MIN_CONFIDENCE = 0.9;

/**
 * Deterministic corroboration required for an auto-merge: the title trigram similarity
 * (lib/search/text/trigram.ts) must also clear this. Defense in depth — we never
 * auto-merge on the model's word alone; a cheap, transparent signal must agree. Below it
 * (but above the blocking floor) the pair still goes to review.
 *
 * >>> PRE-ENABLEMENT WARNING — THIS GATE IS VACUOUS FOR NON-LATIN TITLES. <<< The score it
 * checks comes from lib/search/text/trigram.ts, which normalises first, and normalize()
 * DELETES every non-Latin character. When both titles erase to empty the score is not low,
 * it is 1.0 — the maximum. Measured: "Сказки для малышей" vs "Песни для малышей" (fairy
 * tales vs SONGS) scores pg_trgm 0.4800, so the blocker DETECTS it, and JS 1.0, so this
 * bar is cleared perfectly. For any such pair the only remaining gate is
 * DEDUP_AUTO_MERGE_MIN_CONFIDENCE — i.e. exactly the "merge on the model's word alone"
 * this constant exists to prevent. Richmond and Vancouver Public Library run multilingual
 * storytimes, so this is the operating population, not a curiosity. Nothing reachable
 * today can act on it (Option D's decider cannot return auto_merge, and the LLM path is
 * flag-gated), but this must be resolved BEFORE auto-merge is enabled. See
 * DEDUP_REVIEW_MIN_SIMILARITY below for the full measurement.
 */
export const DEDUP_AUTO_MERGE_MIN_SIMILARITY = 0.55;

/** SQL blocking floor: title pairs below this trigram similarity are not even candidates. */
export const DEDUP_BLOCKING_MIN_SIMILARITY = 0.4;

/**
 * Option D review floor: the deterministic-only adjudicator routes a detected pair to the
 * human QA queue at or above this title similarity, and skips below it.
 *
 * Deliberately EQUAL to the blocking floor, i.e. "route everything the blocker detected".
 * A second, higher floor here would silently drop pairs the blocker already judged worth
 * surfacing, and there is no labelled pair set to justify where such a floor would sit
 * (the auto-merge thresholds have the same problem — see DEDUP_AUTO_MERGE_MIN_*, which
 * this path never consults). The knob exists so the floor is one named, testable constant
 * rather than a literal buried in the decider; raising it is a deliberate act, not a
 * default.
 *
 * THE TWO FLOORS ARE NOT THE SAME FUNCTION, AND EQUAL VALUES DO NOT MAKE THEM AGREE. The
 * blocker's floor is applied by pg_trgm to RAW titles inside Postgres; this one is applied
 * to the JS reimplementation's NORMALISED score. Measured against real pg_trgm (an earlier
 * version of this comment asserted the JS score "reads systematically higher" and that at
 * equal floors anything clearing the SQL floor also clears this one — BOTH ARE FALSE, and
 * the second is the dangerous one):
 *
 *   • The two metrics disagree in BOTH directions. Over 20 realistic titles QA measured
 *     JS-higher 11, equal 5, JS-LOWER 4; a pair pg_trgm scored 0.5000 and DETECTED was
 *     scored 0.2667 by JS and skipped. So a pair is selected by one metric and judged by
 *     another. Equal floors BOUND that divergence; they do not eliminate it.
 *   • The cause is normalize() (lib/search/text/normalize.ts): `replace(/[^a-z0-9]+/g,' ')`
 *     DELETES every non-Latin character, which pg_trgm keeps. CJK, Cyrillic, Hangul,
 *     Gurmukhi and Kana are erased outright.
 *   • THE WORST CASE IS NOT UNDER-DETECTION. When both titles erase to the empty string,
 *     the JS score is not low — it is 1.0, the MAXIMUM. Measured here:
 *         "Сказки для малышей" vs "Песни для малышей"  (fairy tales vs SONGS)
 *              pg_trgm 0.4800 → detected;  JS 1.00000000000000000
 *         "おはなし会" vs "よみきかせ"      (two different Japanese words)
 *              pg_trgm 0.0000;             JS 1.00000000000000000
 *     i.e. for non-Latin titles the JS score reports a perfect match on strings it deleted,
 *     so DEDUP_AUTO_MERGE_MIN_SIMILARITY is VACUOUS for them — the "deterministic
 *     corroboration" that is supposed to stop a merge on the model's word alone contributes
 *     nothing exactly where RPL and VPL run their multilingual storytimes.
 *
 * NONE OF THAT CAN CAUSE A MERGE ON THIS PATH — decideDedupDeterministic cannot return
 * auto_merge at all. It is recorded here because it is a live precondition for Option B,
 * and because the review floor is the constant a future reader will reach for first.
 * Deliberately NOT fixed here: changing the normalizer or the floors is a design decision
 * (it moves detection and scoring for every locale), not a comment correction.
 */
export const DEDUP_REVIEW_MIN_SIMILARITY = DEDUP_BLOCKING_MIN_SIMILARITY;

/**
 * Apply an LLM-resolved age band ONLY when the model is this confident (≥). Lower than
 * the dedup bar because the action is non-destructive (it fills a previously-unknown
 * age range; the search filter's "empty → don't hide" rule bounds the harm), and the
 * output is well-bounded (min/max months). Below it, we leave the record unresolved
 * (no-op) and mark it so it is not reprocessed every night.
 */
export const AGE_APPLY_MIN_CONFIDENCE = 0.8;

/**
 * Apply an LLM-resolved PRIMARY CATEGORY ONLY when the model is this confident (≥). Same bar
 * as age: the action is non-destructive and reversible — it only ever replaces the generic
 * 'class_program' fallback (or a null category) with a MORE specific category, never a
 * confident deterministic classification. Below it, the record keeps its fallback category
 * (no-op). (G-T13-5 category extension; conservative first version.)
 */
export const CATEGORY_APPLY_MIN_CONFIDENCE = 0.8;

/**
 * Apply an LLM-resolved COST ONLY when the model is this confident (≥). Same bar as age: it
 * only ever fills a previously-unknown cost (cost_status='unknown'); the search "unknown →
 * don't hide" rule bounds the harm of a wrong fill. Below it, cost stays 'unknown' (no-op).
 * We additionally only ever write the CONCRETE outcomes ('free' / 'known'); a bare
 * 'check_source' hint is treated as a no-op in this conservative first version.
 * (G-T13-5 cost extension.)
 */
export const COST_APPLY_MIN_CONFIDENCE = 0.8;

/** Default safety cap on candidate records submitted per batch run (per use case). */
export const DEFAULT_MAX_CANDIDATES = 500;

/** Job names (stable watermark keys in llm_batch_run). */
export const JOB_NAMES = {
  dedup: 'llm_dedup_adjudication',
  age: 'llm_age_fallback',
  categoryCost: 'llm_category_cost_fallback',
} as const;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * The model id. Env-overridable, but HARD-CONSTRAINED to a Haiku model — a Sonnet/Opus
 * override throws rather than silently reaching for an over-powered (and pricier) model
 * for classification/matching/extraction work.
 */
export function batchModel(): string {
  const raw = env('LLM_BATCH_MODEL') ?? DEFAULT_LLM_BATCH_MODEL;
  if (!raw.startsWith('claude-haiku')) {
    throw new Error(
      `LLM_BATCH_MODEL must be a Haiku model (got "${raw}"). This job is scoped to Haiku ` +
        `for classification/matching/extraction — do not use Sonnet/Opus here.`
    );
  }
  return raw;
}

/** The run-route shared secret, or null if unconfigured (route then fails closed → 503). */
export function batchCronSecret(): string | null {
  return env('LLM_BATCH_CRON_SECRET') ?? null;
}

/**
 * Whether REAL Message-Batches submission is permitted. Default FALSE — until an operator
 * sets LLM_BATCH_ENABLED=true (and the Anthropic credential is provisioned) the job runs
 * detection-only, so it can never make a live API call or a write before it's meant to.
 */
export function batchEnabled(): boolean {
  return env('LLM_BATCH_ENABLED') === 'true';
}

/** Operator kill-switch: force dry-run (detection-only, no writes, no API call). */
export function batchDryRunForced(): boolean {
  return env('LLM_BATCH_DRY_RUN') === 'true';
}

/** The Haiku-scoped Anthropic key, or null when unprovisioned (client then fails loudly). */
export function anthropicApiKey(): string | null {
  return env('ANTHROPIC_API_KEY') ?? null;
}

/** Safety cap on candidates per batch run. Env-overridable; always a finite positive int. */
export function maxCandidates(): number {
  const raw = env('LLM_BATCH_MAX_CANDIDATES');
  if (raw === undefined) return DEFAULT_MAX_CANDIDATES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_CANDIDATES;
  return Math.floor(n);
}
