// lib/search/text/normalize.ts — Text normalisation shared by parser and matcher.
//
// Mirrors what Postgres FTS + pg_trgm do so fixture results track live results:
// lowercase, strip punctuation, collapse whitespace, drop a small English stop list.

/** Postgres `english` config strips these from tsvectors; we mirror a compact subset. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'for', 'of', 'to', 'in', 'on', 'at', 'with',
  'my', 'me', 'is', 'are', 'be', 'or', 'near', 'this', 'that', 'i',
]);

/** Lowercase, replace any non-alphanumeric run with a single space, trim. */
export function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Tokenise into lexemes, dropping stop words. Stop-word removal is skippable for exact-phrase needs. */
export function tokenize(input: string, dropStopWords = true): string[] {
  const normalized = normalize(input);
  if (!normalized) return [];
  const tokens = normalized.split(' ');
  return dropStopWords ? tokens.filter((t) => t && !STOP_WORDS.has(t)) : tokens.filter(Boolean);
}
