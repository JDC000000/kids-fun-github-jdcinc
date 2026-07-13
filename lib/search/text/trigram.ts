// lib/search/text/trigram.ts — pg_trgm-compatible trigram similarity for typo/partial matches.
//
// Postgres `pg_trgm` pads each word with two leading spaces + one trailing space,
// slices length-3 windows, and reports `similarity(a,b) = |A ∩ B| / |A ∪ B|`
// (Jaccard over the trigram sets). We reproduce that so the fixture matcher's
// fuzzy behaviour (G-T16-3) tracks the eventual `similarity()`/`%` operator.

import { normalize } from './normalize';

/** Default `pg_trgm.similarity_threshold`. */
export const DEFAULT_TRIGRAM_THRESHOLD = 0.3;

/** Generate the pg_trgm trigram set for a string. */
export function trigrams(input: string): Set<string> {
  const words = normalize(input).split(' ').filter(Boolean);
  const set = new Set<string>();
  for (const word of words) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      set.add(padded.slice(i, i + 3));
    }
  }
  return set;
}

/** Jaccard similarity of two trigram sets — matches pg_trgm `similarity()` in [0,1]. */
export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const g of ta) if (tb.has(g)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** True when similarity clears the threshold (pg_trgm `%` operator). */
export function fuzzyMatches(a: string, b: string, threshold = DEFAULT_TRIGRAM_THRESHOLD): boolean {
  return similarity(a, b) >= threshold;
}
