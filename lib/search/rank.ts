// lib/search/rank.ts — Weighted ranking function + status/confidence boost (G-T19-1/2, TSD §5A.3).
//
//   score = w1·ts_rank + w2·age_match + w3·date_proximity + w4·distance_decay
//         + w5·status_confidence_boost + w6·suitability_match + w7·recency
//
// Every component is normalised to ~[0,1] and returned in a breakdown so the ranking
// is TRANSPARENT (explainable, no black box) and has NO monetisation input (BR-18).
// Confirmed/bookable + officially-fresh listings are boosted above
// schedule_not_published / seasonal / stale (§5A.3, honest ranking).

import type { AgeBandKey, ConfidenceLabel, DateIntent, GeoPoint, ListingRecord, StatusState } from './types';
import type { MatchCandidate } from './match';
import type { RankWeights } from './rank-config';
import { DEFAULT_RANK_WEIGHTS } from './rank-config';
import { distanceFromOrigin, distanceDecay } from '../geo/radius';
import { localIsoDate } from './time/vancouver';

/** Status → base actionability score (§5A.3): confirmed/bookable highest, stale lowest. */
const STATUS_SCORE: Record<StatusState, number> = {
  bookable_open: 1.0,
  confirmed: 0.95,
  seasonal_active: 0.75,
  inferred_recurring: 0.7,
  schedule_not_published: 0.5,
  not_yet_bookable: 0.5,
  waitlist: 0.45,
  full: 0.4,
  postponed: 0.3,
  seasonal_preseason: 0.3,
  seasonal_out_of_season: 0.2,
  manual_candidate: 0.2,
  stale: 0.15,
  suspended: 0.1,
  cancelled: 0.05,
  needs_review: 0.1,
};

/** Confidence label → multiplier (BR-13): official+recent outranks editorial/old/manual. */
const CONFIDENCE_SCORE: Record<ConfidenceLabel, number> = {
  official_recent: 1.0,
  official: 0.9,
  editorial: 0.6,
  inferred: 0.5,
  stale: 0.3,
};

const DATE_HORIZON_DAYS = 14; // proximity window for date scoring
const RECENCY_HORIZON_DAYS = 30; // freshness window for recency scoring

// Neutral fallbacks for values not in the score maps. The live DB stores
// `confidence_label` as free text (e.g. 'official_verified', 'editorial_old'),
// so an unmapped label must NOT produce NaN — it degrades to a neutral score.
const DEFAULT_STATUS_SCORE = 0.3;
const DEFAULT_CONFIDENCE_SCORE = 0.5;

/** Status → actionability score, defaulting safely for values outside the enum. */
function statusScore(status: StatusState): number {
  return STATUS_SCORE[status] ?? DEFAULT_STATUS_SCORE;
}

/** Confidence label → multiplier, tolerant of live free-text labels via a neutral default. */
function confidenceScore(label: ConfidenceLabel | string): number {
  return CONFIDENCE_SCORE[label as ConfidenceLabel] ?? DEFAULT_CONFIDENCE_SCORE;
}

export interface RankContext {
  origin: GeoPoint | null;
  radiusKm: number;
  ageBands: AgeBandKey[];
  date: DateIntent | null;
  /** Rainy-day (indoor) requested → suitability signal. */
  rainyDay: boolean;
  now: Date;
  weights?: RankWeights;
}

export interface RankComponents {
  tsRank: number;
  ageMatch: number;
  dateProximity: number;
  distanceDecay: number;
  statusConfidenceBoost: number;
  suitabilityMatch: number;
  recency: number;
}

export interface ScoredListing {
  candidate: MatchCandidate;
  score: number;
  components: RankComponents;
  distanceKm: number | null;
}

/** Score one candidate. Pure + deterministic given `ctx.now`. */
export function scoreListing(candidate: MatchCandidate, ctx: RankContext): ScoredListing {
  const w = ctx.weights ?? DEFAULT_RANK_WEIGHTS;
  const listing = candidate.listing;
  const distance = ctx.origin ? distanceFromOrigin(ctx.origin, listing.geo) : null;

  const components: RankComponents = {
    tsRank: saturate(candidate.relevance),
    ageMatch: ageMatchScore(listing, ctx.ageBands),
    dateProximity: dateProximityScore(listing, ctx),
    distanceDecay: distanceDecay(distance, ctx.radiusKm),
    statusConfidenceBoost: statusScore(listing.statusState) * confidenceScore(listing.confidenceLabel),
    suitabilityMatch: suitabilityScore(listing, ctx),
    recency: recencyScore(listing, ctx.now),
  };

  const score =
    w.tsRank * components.tsRank +
    w.ageMatch * components.ageMatch +
    w.dateProximity * components.dateProximity +
    w.distanceDecay * components.distanceDecay +
    w.statusConfidenceBoost * components.statusConfidenceBoost +
    w.suitabilityMatch * components.suitabilityMatch +
    w.recency * components.recency;

  return { candidate, score, components, distanceKm: distance };
}

/** Score + order a candidate set (descending), with a stable id tiebreak. */
export function rankCandidates(candidates: MatchCandidate[], ctx: RankContext): ScoredListing[] {
  return candidates
    .map((c) => scoreListing(c, ctx))
    .sort((a, b) => b.score - a.score || a.candidate.listing.id.localeCompare(b.candidate.listing.id));
}

// --- component helpers ---

/** relevance/(relevance+1): saturating, per-listing (not set-relative) → deterministic. */
function saturate(x: number): number {
  return x <= 0 ? 0 : x / (x + 1);
}

function ageMatchScore(listing: ListingRecord, userBands: AgeBandKey[]): number {
  if (userBands.length === 0) return 0; // no age signal
  if (listing.ageBandMatches.length === 0) return 0.5; // all-ages/unknown → neutral
  const covered = userBands.filter((b) => listing.ageBandMatches.includes(b)).length;
  return covered / userBands.length;
}

function dateProximityScore(listing: ListingRecord, ctx: RankContext): number {
  if (listing.openHours) return 0.8; // always available → strong, but below an exact-date hit
  if (!listing.startDatetimeUtc) return 0;
  const occIso = localIsoDate(new Date(listing.startDatetimeUtc));
  const targetIso = ctx.date?.isoDate ?? localIsoDate(ctx.now);
  const diff = Math.abs(daysBetweenIso(targetIso, occIso));
  if (occIso < localIsoDate(ctx.now)) return 0; // already past
  return Math.max(0, 1 - diff / DATE_HORIZON_DAYS);
}

function suitabilityScore(listing: ListingRecord, ctx: RankContext): number {
  if (!ctx.rainyDay) return 0;
  return listing.suitabilityTags.includes('indoor') ? 1 : 0;
}

function recencyScore(listing: ListingRecord, now: Date): number {
  if (!listing.lastCheckedAtUtc) return 0;
  const ageDays = (now.getTime() - new Date(listing.lastCheckedAtUtc).getTime()) / 86_400_000;
  if (ageDays < 0) return 1;
  return Math.max(0, 1 - ageDays / RECENCY_HORIZON_DAYS);
}

/** Whole-day difference b - a between two YYYY-MM-DD strings. */
function daysBetweenIso(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}
