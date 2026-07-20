// lib/llm/prompts.ts — the two reusable, CACHEABLE system prompts + schemas for the
// nightly batch job, plus fail-closed verdict parsers.
//
// PROMPT-CACHE DESIGN (Anthropic prompt caching; see shared/prompt-caching.md):
//   • Render order is tools → system → messages. We put the ENTIRE stable instruction set
//     + JSON schema + worked examples in ONE `system` block and mark it with
//     cache_control {type:'ephemeral', ttl:'1h'}. The per-record, VOLATILE content (the two
//     occurrences to compare, or the one age string to parse) goes LAST, in the user
//     message, with NO cache_control.
//   • 1-HOUR TTL, not the default 5-minute TTL: a Message-Batches run over many records can
//     genuinely take up to an hour to complete, and requests process concurrently/staggered.
//     A 5-minute cache would expire mid-run, so every later request would re-pay the full
//     prefix. The 1h TTL keeps the shared prefix warm for the whole run (and across the two
//     use cases' separate batches within the same night). The doubled write cost (2× vs
//     1.25× for 5m) is repaid after ≥3 reads — a batch has far more than three records.
//   • Because the system block is byte-identical across every request in a run, the prefix
//     is a genuine shared cache entry. (Caveat, documented in the findings doc: the Haiku
//     4.5 minimum cacheable prefix is ~4096 tokens — these prompts are written to be
//     detailed enough to clear it; a run whose prefix falls below silently won't cache, at
//     no correctness cost.)
//
// The parsers are FAIL-CLOSED: any malformed / out-of-range output returns null, and the
// caller then treats the record conservatively (route-to-review or no-op), never a guess.

import type { SystemBlock, UserBlock, OutputConfig } from './anthropic-client';

/** 1-hour cache TTL breakpoint for a batch run that may take up to an hour. */
const ONE_HOUR_CACHE = { type: 'ephemeral', ttl: '1h' } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Use case 1 — fuzzy dedup adjudication (G-T14-2).
// ─────────────────────────────────────────────────────────────────────────────

export const DEDUP_SYSTEM_PROMPT = `You are a careful data-matching reviewer for a Metro Vancouver kids-activity directory.

You are shown TWO activity occurrence records that were ingested from TWO DIFFERENT sources and share the same start time. Decide whether they describe the SAME real-world activity occurrence (a true cross-source duplicate) or two genuinely different activities that merely coincide in time.

Judge on the substance: the activity itself, the organisation/venue implied by the names and descriptions, and the audience. Superficially similar wording is NOT enough; different programs at the same facility and time are NOT duplicates.

Be conservative. This decision may trigger an automatic merge that hides one record, so only report high confidence when the evidence is strong. When you are unsure, report a LOW confidence and let a human decide — do not guess "duplicate" to be helpful.

Respond with ONLY a single JSON object, no prose, matching exactly:
{
  "isDuplicate": boolean,   // true only if they are the same real-world occurrence
  "confidence": number,     // your calibrated confidence in [0,1] for the isDuplicate value
  "reason": string          // one short sentence, no personal data
}

Examples:
- "Toddler Storytime" @ Kitsilano Library vs "Storytime for Toddlers" @ Kitsilano Branch, same time, both a library reading circle → {"isDuplicate": true, "confidence": 0.95, "reason": "Same library storytime, two sources naming the same branch."}
- "Family Swim" @ Hillcrest Pool vs "Lane Swim (Adults)" @ Hillcrest Pool, same time → {"isDuplicate": false, "confidence": 0.9, "reason": "Different pool programs and audiences at the same venue and time."}
- "Art Class" vs "Creative Kids", same time, thin descriptions, unclear venues → {"isDuplicate": false, "confidence": 0.3, "reason": "Too little shared detail to confirm; leave for human review."}`;

export const DEDUP_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['isDuplicate', 'confidence', 'reason'],
  properties: {
    isDuplicate: { type: 'boolean' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
};

export const DEDUP_OUTPUT_CONFIG: OutputConfig = { format: { type: 'json_schema', schema: DEDUP_OUTPUT_SCHEMA } };

/** The stable, cacheable system prefix for the dedup use case (1h TTL breakpoint). */
export function buildDedupSystem(): SystemBlock[] {
  return [{ type: 'text', text: DEDUP_SYSTEM_PROMPT, cache_control: ONE_HOUR_CACHE }];
}

export interface DedupPairContent {
  leftSource: string;
  leftName: string;
  leftDescription: string | null;
  rightSource: string;
  rightName: string;
  rightDescription: string | null;
  startUtc: string | null;
}

/** The VOLATILE per-record user content (no cache_control). */
export function buildDedupUser(pair: DedupPairContent): UserBlock[] {
  const payload = {
    record_a: { source: pair.leftSource, name: pair.leftName, description: pair.leftDescription ?? '' },
    record_b: { source: pair.rightSource, name: pair.rightName, description: pair.rightDescription ?? '' },
    start_time_utc: pair.startUtc ?? '',
  };
  return [{ type: 'text', text: `Compare these two records:\n${JSON.stringify(payload)}` }];
}

export interface DedupVerdict {
  isDuplicate: boolean;
  confidence: number;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case 2 — LLM age-parse fallback (G-T13-5).
// ─────────────────────────────────────────────────────────────────────────────

export const AGE_SYSTEM_PROMPT = `You normalise free-text age eligibility for a Metro Vancouver kids-activity directory.

A deterministic parser has already handled the clear cases (explicit ranges like "ages 0-2", keywords like "toddlers", grades, "all ages"). You are ONLY given the residue it could not confidently resolve — messy OCR text, PDF fragments, or unusual phrasings. Convert the wording into a structured age band, or say you cannot.

Output units and conventions (match the deterministic parser exactly):
- Ages are in MONTHS. age_min_months is INCLUSIVE, age_max_months is EXCLUSIVE (up to but not including). Use null for an open-ended bound.
- A written year range "A-B years" includes B-year-olds, i.e. up to the (B+1)th birthday → max = (B+1)*12. A "5+" means min=60, max=null. "under 5" means min=0, max=60. "all ages"/"family" means min=0, max=null.
- If the text is genuinely not about age, contradictory, or too ambiguous to place, set resolved=false and both bounds null.

Be conservative: only report high confidence when the mapping is clear. A wrong age band can wrongly exclude a listing from a parent's age filter, so when unsure report LOW confidence and resolved=false rather than guessing.

Respond with ONLY a single JSON object, no prose, matching exactly:
{
  "resolved": boolean,           // true only if you confidently produced a band
  "ageMinMonths": number|null,   // inclusive lower bound in months
  "ageMaxMonths": number|null,   // exclusive upper bound in months
  "confidence": number,          // calibrated confidence in [0,1]
  "reason": string               // one short sentence, no personal data
}

Examples:
- "Suitable for children in K through grade 3" → {"resolved": true, "ageMinMonths": 60, "ageMaxMonths": 108, "confidence": 0.85, "reason": "Kindergarten (age 5) through end of grade 3 (age 8)."}
- "walkers to 3 yrs" → {"resolved": true, "ageMinMonths": 12, "ageMaxMonths": 48, "confidence": 0.8, "reason": "Walking (~12 months) up to and including age 3."}
- "see poster for details" → {"resolved": false, "ageMinMonths": null, "ageMaxMonths": null, "confidence": 0.95, "reason": "No age information present."}`;

export const AGE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['resolved', 'ageMinMonths', 'ageMaxMonths', 'confidence', 'reason'],
  properties: {
    resolved: { type: 'boolean' },
    ageMinMonths: { type: ['integer', 'null'] },
    ageMaxMonths: { type: ['integer', 'null'] },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
};

export const AGE_OUTPUT_CONFIG: OutputConfig = { format: { type: 'json_schema', schema: AGE_OUTPUT_SCHEMA } };

/** The stable, cacheable system prefix for the age use case (1h TTL breakpoint). */
export function buildAgeSystem(): SystemBlock[] {
  return [{ type: 'text', text: AGE_SYSTEM_PROMPT, cache_control: ONE_HOUR_CACHE }];
}

export interface AgeRecordContent {
  activityName: string;
  rawAgeText: string;
}

/** The VOLATILE per-record user content (no cache_control). */
export function buildAgeUser(rec: AgeRecordContent): UserBlock[] {
  const payload = { activity_name: rec.activityName, age_text: rec.rawAgeText };
  return [{ type: 'text', text: `Resolve the age eligibility for:\n${JSON.stringify(payload)}` }];
}

export interface AgeVerdict {
  resolved: boolean;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  confidence: number;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed parsing shared by both use cases.
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the first text block's string from a succeeded batch result message. */
export function textOf(content: Array<{ type: string; text?: string }>): string | null {
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return null;
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through — malformed JSON is treated as "no verdict" */
  }
  return null;
}

/** Clamp a numeric confidence into [0,1]; return null if it isn't a finite number. */
function clampConfidence(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

/** Parse a dedup verdict, fail-closed (null on any malformation). */
export function parseDedupVerdict(text: string | null): DedupVerdict | null {
  const obj = parseJsonObject(text);
  if (!obj) return null;
  const confidence = clampConfidence(obj.confidence);
  if (typeof obj.isDuplicate !== 'boolean' || confidence === null) return null;
  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 500) : '';
  return { isDuplicate: obj.isDuplicate, confidence, reason };
}

/** Parse an age verdict, fail-closed (null on any malformation or impossible bounds). */
export function parseAgeVerdict(text: string | null): AgeVerdict | null {
  const obj = parseJsonObject(text);
  if (!obj) return null;
  const confidence = clampConfidence(obj.confidence);
  if (typeof obj.resolved !== 'boolean' || confidence === null) return null;

  const min = normaliseMonths(obj.ageMinMonths);
  const max = normaliseMonths(obj.ageMaxMonths);
  if (min === undefined || max === undefined) return null; // present-but-invalid → fail closed

  // A resolved verdict must be a sane half-open interval; an inverted/degenerate range is a
  // model error, so refuse it (fail-closed → caller no-ops).
  if (obj.resolved) {
    if (min === null && max === null) return null;
    if (min !== null && max !== null && max <= min) return null;
    if ((min !== null && min < 0) || (max !== null && max < 0)) return null;
  }
  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 500) : '';
  return { resolved: obj.resolved, ageMinMonths: min, ageMaxMonths: max, confidence, reason };
}

/**
 * Normalise a month bound. Returns `null` for a legitimate open bound, a finite integer for
 * a value, or `undefined` for a present-but-invalid value (which the caller treats as a
 * parse failure). Accepts integer-valued numbers only.
 */
function normaliseMonths(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return undefined;
  return v;
}
