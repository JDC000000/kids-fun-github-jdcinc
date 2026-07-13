// lib/search/parse.ts — G-T16-1: query parser (normalise + intent extraction,
// TSD §5A.2). Deterministic, no DB/network access — lowercase/trim + extract
// date, time-of-day, age hints, radius, cost intent into a SearchContext.

export type DateIntent = 'today' | 'tomorrow' | 'this_weekend' | null;
export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | null;

export interface SearchContext {
  /** Raw query with recognised intent words stripped — feeds tsquery/trigram matching. */
  freeText: string;
  dateIntent: DateIntent;
  timeOfDay: TimeOfDay;
  ageHints: string[];
  radiusKm: number | null;
  costIntent: 'free' | null;
  nearMe: boolean;
}

const DATE_WORDS: Array<[string, NonNullable<DateIntent>]> = [
  ['this weekend', 'this_weekend'],
  ['weekend', 'this_weekend'],
  ['tomorrow', 'tomorrow'],
  ['tonight', 'today'],
  ['today', 'today'],
];

const TIME_OF_DAY_WORDS: Array<[string, NonNullable<TimeOfDay>]> = [
  ['morning', 'morning'],
  ['afternoon', 'afternoon'],
  ['evening', 'evening'],
  ['night', 'evening'],
];

const AGE_HINT_WORDS = ['toddler', 'baby', 'infant', 'preschooler', 'teenager', 'teen', 'kids', 'kid'];
const RADIUS_RE = /\b(\d{1,3})\s*km\b/;
const AGE_NUMBER_RE = /\b(\d{1,2})\s*(?:years?|yrs?|yo)\b/;
const NEAR_ME_RE = /\bnear me\b/;
const FREE_RE = /\bfree\b/;

export function parseQuery(rawQuery: string): SearchContext {
  const normalised = rawQuery.toLowerCase().trim().replace(/\s+/g, ' ');

  const dateIntent = firstMatch(normalised, DATE_WORDS);
  const timeOfDay = firstMatch(normalised, TIME_OF_DAY_WORDS);
  const nearMe = NEAR_ME_RE.test(normalised);
  const costIntent = FREE_RE.test(normalised) ? 'free' : null;
  const radiusMatch = normalised.match(RADIUS_RE);
  const radiusKm = radiusMatch ? Number(radiusMatch[1]) : null;
  const ageHints = extractAgeHints(normalised);
  const freeText = stripKnownTerms(normalised);

  return { freeText, dateIntent, timeOfDay, ageHints, radiusKm, costIntent, nearMe };
}

function firstMatch<T extends string>(text: string, pairs: Array<[string, T]>): T | null {
  for (const [word, value] of pairs) {
    if (text.includes(word)) return value;
  }
  return null;
}

function extractAgeHints(normalised: string): string[] {
  const hints = AGE_HINT_WORDS.filter((w) => normalised.includes(w));
  const ageNumberMatch = normalised.match(AGE_NUMBER_RE);
  if (ageNumberMatch) hints.push(ageNumberMatch[0]);
  return hints;
}

function stripKnownTerms(normalised: string): string {
  let text = normalised;
  const stripPhrases = [
    'near me',
    'free',
    ...DATE_WORDS.map(([w]) => w),
    ...TIME_OF_DAY_WORDS.map(([w]) => w),
  ];
  for (const phrase of stripPhrases) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'g'), ' ');
  }
  text = text.replace(RADIUS_RE, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
