// lib/search/parse.ts — Query parser (G-T16-1, TSD §5A.2).
//
// Turns a raw parent-language query into a structured `SearchContext`: date,
// time-of-day, age bands, radius, cost + status intent, sort, and residual
// free-text terms (fed to alias-expand → matcher). Intent phrases are stripped
// so they don't pollute text relevance (e.g. "free" must not match a venue named
// "Freedom"). Deterministic: pass `now` for reproducible relative-date parsing.

import type { AgeBandKey, DayPart, DateIntent, SearchContext, SortKey } from './types';
import { normalize, tokenize } from './text/normalize';
import { localIsoDate, addDaysIso, toVancouverParts } from './time/vancouver';

export interface ParseOptions {
  /** Reference instant for relative dates ("today"/"tomorrow"/weekday). Defaults to now. */
  now?: Date;
  /** Default radius when none is expressed (TSD §5B). */
  defaultRadiusKm?: number;
  /** Explicit sort from the UI control; overrides any sort keyword in the text. */
  sort?: SortKey;
  /**
   * Explicit include-registration-courses flag from the UI. Structured only — deliberately NOT
   * parsed from `q`. It is an inclusion policy, not something a parent types, and keeping it out
   * of the text pipeline means it can never be triggered by a query that merely mentions a course.
   */
  includeRegistration?: boolean;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

// Parent-language → user age bands. A phrase may imply multiple bands.
const AGE_PHRASES: Array<{ re: RegExp; bands: AgeBandKey[] }> = [
  { re: /\bunder ?2\b|\bnewborn\b|\binfant(s)?\b|\bbaby\b|\bbabies\b/, bands: ['under2'] },
  { re: /\btoddler(s)?\b/, bands: ['under2', '2-4'] },
  { re: /\bpreschool(er)?(s)?\b|\b2 ?- ?4\b/, bands: ['2-4'] },
  { re: /\bkids?\b|\bchildren\b|\b5 ?- ?9\b/, bands: ['5-9'] },
  { re: /\btween(s)?\b|\b10 ?- ?14\b/, bands: ['10-14'] },
  { re: /\bteen(s|ager)?s?\b|\byouth\b|\b15\+?\b/, bands: ['15+'] },
];

const SORT_PHRASES: Array<{ re: RegExp; sort: SortKey }> = [
  { re: /\bcheapest\b|\blowest cost\b|\bleast expensive\b/, sort: 'lowest_cost' },
  { re: /\bclosest\b|\bnearest\b/, sort: 'distance' },
  { re: /\bsoonest\b|\bnext up\b/, sort: 'soonest' },
  { re: /\bnewest\b|\bjust added\b/, sort: 'newest' },
];

/** Parse a raw query into a `SearchContext`. */
export function parseQuery(raw: string, opts: ParseOptions = {}): SearchContext {
  const now = opts.now ?? new Date();
  const ctx: SearchContext = {
    raw,
    terms: [],
    unparsedQuery: false,
    date: null,
    timeOfDay: null,
    ageBands: [],
    radiusKm: opts.defaultRadiusKm ?? 10,
    nearMe: false,
    costFree: false,
    includeRegistration: opts.includeRegistration ?? false,
    bookableNow: false,
    rainyDay: false,
    dropIn: false,
    sort: opts.sort ?? 'best_match',
  };

  // Work on a normalised string; strip each matched span so residual = free text.
  let s = ` ${normalize(raw)} `;
  /**
   * Did ANY intent phrase below actually match? This is the second half of `unparsedQuery`
   * (see the assignment at the end of this function), and it is measured by watching `strip`
   * rather than by re-reading `ctx` afterwards, because the two are not the same question.
   * Several strips below recognise a phrase and then deliberately DISCARD its value — the
   * price ceiling, "include unknown cost" — so a context-field sweep would call those queries
   * unread when the parser understood them perfectly well and chose to act on nothing. What
   * matters here is comprehension, not consequence.
   */
  let recognisedIntent = false;
  const strip = (re: RegExp) => {
    const stripped = s.replace(re, ' ');
    if (stripped !== s) recognisedIntent = true;
    s = stripped;
  };

  // --- Location intent ---
  if (/\bnear me\b|\bnearby\b|\baround me\b/.test(s)) {
    ctx.nearMe = true;
    strip(/\bnear me\b|\bnearby\b|\baround me\b/g);
  }
  const radiusMatch = s.match(/\b(\d{1,3})\s*km\b/);
  if (radiusMatch) {
    ctx.radiusKm = Number(radiusMatch[1]);
    strip(/\bwithin\b/g);
    strip(/\b\d{1,3}\s*km\b/g);
  }

  // --- Cost intent (FR-10/BR-11) ---
  // "include unknown cost" / "check source" are still STRIPPED, but they no longer set
  // anything: unknown-cost listings are always included now (lib/search/filters/cost.ts), so
  // asking for them is a no-op. The strip stays because these are cost-intent words, not
  // content — leaving them in the text would have them ranked as if a parent were looking for
  // an activity called "check source".
  strip(/\binclude unknown\b|\bunknown cost\b|\bcheck source\b|\bcheck-source\b/g);
  if (/\bfree\b|\bno cost\b|\bno charge\b/.test(s)) {
    ctx.costFree = true;
    strip(/\bfree\b|\bno cost\b|\bno charge\b/g);
  }
  // Max-price ceiling (was P1 cost range, G-T21-4) — RECOGNISED AND DISCARDED, NOT UNPARSED.
  //
  // The ceiling is gone from the product (Jon's ruling, 2026-08-11: "remove the price ceiling
  // from search, full stop — it can be found on the original source site"). The URL path was
  // removed in the beta round; this closes the free-text path it deliberately left open, and
  // with it the question app/search/_lib/params.ts flagged for Jon rather than deciding.
  //
  // DELETING THIS BLOCK OUTRIGHT WOULD HAVE BEEN A REGRESSION, WHICH IS WHY IT IS STILL HERE.
  // It is the only thing that strips "under 20" out of the search text. Without the strip the
  // words "under" and "20" survive into `ctx.terms`, and the matcher ORs user terms
  // (lib/search/match.ts) — so they would start pulling coincidental relevance out of
  // descriptions, widening results and degrading ranking. The phrase is cost INTENT, not
  // content; it is removed from the text for the same reason "check source" is stripped above,
  // and for the same reason. Only the VALUE is thrown away.
  //
  // The 2+ digit requirement is likewise load-bearing and unchanged: it keeps this from
  // swallowing the "under 2" AGE phrase (a single digit), which parses below.
  strip(/\b(?:under|up to|below) \d{2,4}\b/g);

  // --- Status chips ---
  if (/\bbookable now\b|\bbookable\b|\bbook now\b/.test(s)) {
    ctx.bookableNow = true;
    strip(/\bbookable now\b|\bbookable\b|\bbook now\b/g);
  }
  if (/\brainy day\b|\brainy-day\b|\brainy\b/.test(s)) {
    ctx.rainyDay = true;
    strip(/\brainy day\b|\brainy-day\b|\brainy\b/g);
  }
  if (/\bindoor\b|\bindoors\b/.test(s)) {
    ctx.rainyDay = true; // Rainy-day chip == indoor suitability (TSD §5A.4)
    strip(/\bindoor\b|\bindoors\b/g);
  }
  // normalize() collapses "drop-in" → "drop in", so match the two-word / joined forms.
  if (/\bdrop in\b|\bdropin\b/.test(s)) {
    ctx.dropIn = true; // Drop-in suitability chip (G-T21-3): just show up, no booking.
    strip(/\bdrop in\b|\bdropin\b/g);
  }

  // --- Time-of-day (FR-09) ---
  if (/\btonight\b/.test(s)) {
    ctx.timeOfDay = 'evening';
    ctx.date = ctx.date ?? relativeDate('today', now);
    strip(/\btonight\b/g);
  }
  const dayParts: Array<[RegExp, DayPart]> = [
    [/\bmorning\b/, 'morning'],
    [/\bafternoon\b/, 'afternoon'],
    [/\bevening\b|\bnight\b/, 'evening'],
  ];
  for (const [re, part] of dayParts) {
    if (re.test(s)) {
      ctx.timeOfDay = ctx.timeOfDay ?? part;
      strip(new RegExp(re.source, 'g'));
    }
  }

  // --- Date intent ---
  const explicit = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (explicit) {
    ctx.date = { kind: 'explicit', isoDate: explicit[0], weekday: null };
    strip(/\b\d{4}-\d{2}-\d{2}\b/g);
  } else if (/\btoday\b/.test(s)) {
    ctx.date = relativeDate('today', now);
    strip(/\btoday\b/g);
  } else if (/\btomorrow\b/.test(s)) {
    ctx.date = relativeDate('tomorrow', now);
    strip(/\btomorrow\b/g);
  } else if (/\bthis weekend\b|\bweekend\b/.test(s)) {
    ctx.date = relativeDate('weekend', now);
    strip(/\bthis weekend\b|\bweekend\b/g);
  } else {
    for (const [name, idx] of Object.entries(WEEKDAYS)) {
      if (new RegExp(`\\b${name}\\b`).test(s)) {
        ctx.date = weekdayDate(idx, now);
        strip(new RegExp(`\\b${name}\\b`, 'g'));
        break;
      }
    }
  }

  // --- Age intent ---
  const bands = new Set<AgeBandKey>();
  for (const { re, bands: b } of AGE_PHRASES) {
    if (re.test(s)) {
      b.forEach((x) => bands.add(x));
      strip(new RegExp(re.source, 'g'));
    }
  }
  ctx.ageBands = [...bands];

  // --- Sort keyword (only if UI didn't pass one) ---
  if (!opts.sort) {
    for (const { re, sort } of SORT_PHRASES) {
      if (re.test(s)) {
        ctx.sort = sort;
        strip(new RegExp(re.source, 'g'));
        break;
      }
    }
  }

  // Residual free-text terms → alias-expand + matcher.
  ctx.terms = tokenize(s);

  /**
   * "THE PARENT TYPED SOMETHING AND NONE OF IT SURVIVED." — see SearchContext.unparsedQuery.
   *
   * Three conditions, and all three are load-bearing:
   *   • `raw.trim() !== ''` — a BLANK query is a browse, not a failure. /search with no text
   *     and no chips is a legitimate "show me everything on", and it must stay one.
   *   • `terms.length === 0` — nothing survived normalisation and stop-word removal.
   *     `normalize()` keeps only [a-z0-9], so a query written in any non-Latin script
   *     (中文, русский, العربية) reduces to the empty string here, as does one made
   *     entirely of punctuation or of stop words.
   *   • `!recognisedIntent` — nothing was understood as intent either. "free tomorrow" and
   *     the chip phrases app/search/_lib/params.ts composes into `q` leave no residual terms
   *     BY DESIGN (every word is stripped as intent), and they are fully understood queries.
   *
   * A query that is PARTLY readable is not unparsed: "游泳 swim" keeps "swim" and searches
   * for it, which is a better answer than refusing the whole thing.
   */
  ctx.unparsedQuery = raw.trim() !== '' && ctx.terms.length === 0 && !recognisedIntent;
  return ctx;
}

/**
 * Exported for lib/search/engine.ts's structured `when` override (Stage 2a): the engine
 * resolves a typed `when` param ('today'/'tomorrow'/'weekend') to the same DateIntent this
 * parser would produce from the equivalent text phrase, so the two paths can never compute
 * different dates for the same intent.
 */
export function relativeDate(kind: 'today' | 'tomorrow' | 'weekend', now: Date): DateIntent {
  const todayIso = localIsoDate(now);
  if (kind === 'today') return { kind: 'today', isoDate: todayIso, weekday: null };
  if (kind === 'tomorrow') return { kind: 'tomorrow', isoDate: addDaysIso(todayIso, 1), weekday: null };
  return weekendDate(now, todayIso);
}

/**
 * A WEEKEND IS SATURDAY *AND* SUNDAY, ALWAYS BOTH, NEVER ONE (Jon, 2026-08-18).
 *
 * This used to resolve to a single Saturday — `delta = (6 - wd + 7) % 7` — and `matchesDate`
 * then day-equality-matched it, so Sunday was never in a "this weekend" result set at all.
 * Worse, on a SUNDAY the formula read `(6 - 0 + 7) % 7 = 6` and threw the intent six days
 * forward to NEXT Saturday: a parent searching on Sunday morning was shown nothing that was on
 * that very day. Measured on the DST fall-back clock — `2026-11-01T08:30:00Z`, a Sunday —
 * it resolved to `2026-11-07`.
 *
 * The pair is the NEAREST one, and today is always in it when today is a weekend day:
 *
 *   Sun → [yesterday, TODAY]   Mon → [+5, +6]   Tue → [+4, +5]   Wed → [+3, +4]
 *   Thu → [+2, +3]             Fri → [+1, +2]   Sat → [TODAY, +1]
 *
 * Sunday's already-past Saturday is deliberately NOT special-cased away. The read model only
 * ever holds occurrences that have not yet ended (`visibleOccurrenceWhereSql()`), so a finished
 * Saturday contributes nothing on its own — the same mechanism that already makes `today`
 * behave at 9pm. Trimming it here would be a second, divergent prune of the same fact.
 */
function weekendDate(now: Date, todayIso: string): DateIntent {
  const wd = toVancouverParts(now).weekday; // 0=Sun..6=Sat
  const saturdayDelta = wd === 0 ? -1 : 6 - wd;
  const saturday = addDaysIso(todayIso, saturdayDelta);
  return { kind: 'weekend', isoDate: saturday, endIsoDate: addDaysIso(saturday, 1), weekday: 6 };
}

function weekdayDate(targetWeekday: number, now: Date): DateIntent {
  const todayIso = localIsoDate(now);
  const wd = toVancouverParts(now).weekday;
  const delta = (targetWeekday - wd + 7) % 7; // next occurrence incl. today
  return { kind: 'weekday', isoDate: addDaysIso(todayIso, delta), weekday: targetWeekday };
}
