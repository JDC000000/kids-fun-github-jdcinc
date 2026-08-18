// lib/audit/rules/outdoor-indoor.ts — PATTERN 1: the source says outdoor, we render indoor.
//
// The real instance this exists for:
//   "Sportball Outdoor Soccer (5-7yrs) Rain/Shine"  →  suitabilityTags ['outdoor','indoor']
// which the card renders as "Indoor / Rainy-day friendly / Confirmed". A parent filtering for
// a rainy day is shown a soccer field.
//
// SCOPE OF EVIDENCE — deliberately narrow. Only `title`, `description` and `openHoursLabel`
// are read. `venueName` and `organisation` are NOT: half of Metro Vancouver's rec centres are
// operated by a Park Board and a meaningful number are named "<something> Park Community
// Centre", so treating a venue string as an outdoor claim would flag an indoor gym for having
// the word Park in its address. That is the difference between an auditor people read and one
// they mute.
//
// TWO EVIDENCE TIERS, because "outdoor" and "park" are not the same claim:
//   strong — the words mean outdoors and nothing else ("Outdoor", "Rain/Shine", "spray park").
//            The tonight instance is strong on two independent counts.
//   weak   — words that USUALLY mean outdoors and sometimes don't ("park", "field", "garden",
//            "playground"). An indoor playground is a playground; a field trip is not a field.
//            These are what the LLM adjudication stage is for — they are candidates, not
//            findings, and this file never promotes them on its own.
import type { AuditListing, AuditRule, RuleEvidence, RuleSignal } from '../types';

/** The derived tag this rule tests. Its presence is what renders "Rainy-day friendly". */
const INDOOR_TAG = 'indoor';

/**
 * The source calling itself indoor. Checked FIRST and short-circuits the whole rule: if the
 * page says "Indoor Playground" then `playground` is not evidence of anything, and neither is
 * `park` in "Indoor Park". Without this guard the weak tier alone would flag every indoor
 * play centre in the catalogue.
 */
const SOURCE_SAYS_INDOOR_RE = /\bindoors?\b/i;

interface Marker {
  re: RegExp;
  strength: 'strong' | 'weak';
}

const OUTDOOR_MARKERS: Marker[] = [
  // ── strong ────────────────────────────────────────────────────────────────
  { re: /\boutdoors?\b/i, strength: 'strong' },
  // "Rain or Shine", "Rain/Shine", "Rain & Shine", "Rain-Shine" — a promise the programme
  // runs in the weather, which is only ever said about something held outside.
  { re: /\brain\s*(?:or|\/|&|-|\+)\s*shine\b/i, strength: 'strong' },
  { re: /\bweather\s+permitting\b/i, strength: 'strong' },
  { re: /\bspray\s*park\b/i, strength: 'strong' },
  { re: /\bwater\s*park\b/i, strength: 'strong' },
  { re: /\bwading\s+pool\b/i, strength: 'strong' },
  { re: /\bnature\s+(?:walk|hike|play|program(?:me)?)\b/i, strength: 'strong' },
  { re: /\bhik(?:e|es|ing)\b/i, strength: 'strong' },
  { re: /\bcampfire\b/i, strength: 'strong' },
  { re: /\bpicnic\b/i, strength: 'strong' },
  { re: /\bbeach(?:es)?\b/i, strength: 'strong' },
  { re: /\btrails?\b/i, strength: 'strong' },
  { re: /\bcanoe|kayak|paddl(?:e|ing)\b/i, strength: 'strong' },
  // ── weak ──────────────────────────────────────────────────────────────────
  // `\bpark\b` does NOT match "parking" (no word boundary before the 'i'), which is the one
  // false positive people expect it to have. What it does still match is "Park Board" and
  // "Park Royal" — hence weak, hence adjudicated.
  { re: /\bparks?\b/i, strength: 'weak' },
  { re: /\bfields?\b/i, strength: 'weak' }, // "field trip", "track and field", "field house"
  { re: /\bplaygrounds?\b/i, strength: 'weak' }, // indoor playgrounds exist and are common
  { re: /\bgardens?\b/i, strength: 'weak' }, // "Garden Room", "Olive Garden"
  { re: /\boutside\b/i, strength: 'weak' }, // "outside of school hours"
  { re: /\bforest\b/i, strength: 'weak' },
  { re: /\bcourtyard|plaza\b/i, strength: 'weak' },
];

/** Fields whose text is admissible as evidence, in report order. */
const EVIDENCE_FIELDS = ['title', 'description', 'openHoursLabel'] as const;

function collectEvidence(listing: AuditListing): RuleEvidence[] {
  const out: RuleEvidence[] = [];
  const seen = new Set<string>();
  for (const field of EVIDENCE_FIELDS) {
    const text = listing.source[field];
    if (!text) continue;
    for (const marker of OUTDOOR_MARKERS) {
      const match = marker.re.exec(text);
      if (!match) continue;
      // De-duplicate by the matched words so "Outdoor Soccer — Outdoor Field" reports once.
      const key = `${field}:${match[0].toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ quote: match[0], field, strength: marker.strength });
    }
  }
  return out;
}

export const outdoorIndoorRule: AuditRule = {
  id: 'outdoor_source_indoor_tag',
  title: 'Source says outdoor, listing is tagged Indoor / Rainy-day friendly',
  // Severity 3: this is the class the testers hit. A parent choosing a rainy-day activity is
  // being sent to a field, with a "Confirmed" badge next to it.
  severity: 3,

  detect(listing: AuditListing): RuleSignal | null {
    if (!listing.derived.suitabilityTags.includes(INDOOR_TAG)) return null;

    // FP guard 1 — the source calls itself indoor. Believe it; drop the whole listing.
    const selfDescribedIndoor =
      SOURCE_SAYS_INDOOR_RE.test(listing.source.title) ||
      SOURCE_SAYS_INDOOR_RE.test(listing.source.description);
    if (selfDescribedIndoor) return null;

    const evidence = collectEvidence(listing);
    if (evidence.length === 0) return null;

    // Context worth carrying into the report, but NOT evidence: the tag set contradicting
    // itself is our bug, not the source's claim, and the rule must stand on source text.
    const bothTags = listing.derived.suitabilityTags.includes('outdoor');

    return {
      evidence,
      derivedClaim: bothTags
        ? "suitabilityTags contains BOTH 'outdoor' and 'indoor'; the card renders Indoor / Rainy-day friendly"
        : "suitabilityTags contains 'indoor'; the card renders Indoor / Rainy-day friendly",
      note: bothTags
        ? 'Listing carries the outdoor tag too — the indoor tag is additive, not a reading of the source.'
        : undefined,
    };
  },
};
