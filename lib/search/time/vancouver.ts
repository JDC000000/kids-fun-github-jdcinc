// lib/search/time/vancouver.ts — America/Vancouver local-time helpers.
//
// Canon (TSD cross-cutting): store UTC, display/filter America/Vancouver. These
// helpers convert a UTC instant into Vancouver-local parts WITHOUT pulling in a
// tz library — Node ships full ICU, so Intl.DateTimeFormat handles DST correctly.

export const VANCOUVER_TZ = 'America/Vancouver';

const PARTS_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: VANCOUVER_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  weekday: 'short',
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export interface VancouverParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23 local
  minute: number; // 0-59
  weekday: number; // 0=Sun..6=Sat
  isoDate: string; // YYYY-MM-DD local
}

// Intl.DateTimeFormat.formatToParts costs ~5µs per call — trivial once, ruinous in a filter
// loop. Search decomposes the SAME handful of instants over and over: every date/time-of-day
// predicate, every ranking pass, every rung of the broadening ladder, and every facet count
// re-derives the local parts of the same occurrence start/end. The instants are a small,
// bounded set (two per listing) and the mapping is deterministic, so memoise it. Bounded and
// cleared wholesale on overflow: this module lives for the life of the server process, and a
// simple cap is enough — the working set is one page of listings, not a growing history.
const PARTS_CACHE_LIMIT = 4096;
const partsCache = new Map<number, VancouverParts>();

/** Decompose a UTC instant into Vancouver-local calendar/clock parts. */
export function toVancouverParts(instant: Date): VancouverParts {
  const key = instant.getTime();
  const cached = partsCache.get(key);
  if (cached) return cached;
  const parts = computeVancouverParts(instant);
  // An invalid Date already threw above; only real instants reach the cache.
  if (partsCache.size >= PARTS_CACHE_LIMIT) partsCache.clear();
  partsCache.set(key, parts);
  return parts;
}

function computeVancouverParts(instant: Date): VancouverParts {
  const parts = PARTS_FMT.formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === '24' ? 0 : Number(map.hour); // Intl may emit '24' at midnight
  // Frozen because it is shared out of the cache — a caller mutating it would corrupt
  // every later reader of the same instant.
  return Object.freeze({
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    weekday: WEEKDAY_INDEX[map.weekday] ?? 0,
    isoDate: `${map.year}-${map.month}-${map.day}`,
  });
}

/** Vancouver-local minutes-past-midnight for a UTC instant (0..1439). */
export function localMinutesOfDay(instant: Date): number {
  const p = toVancouverParts(instant);
  return p.hour * 60 + p.minute;
}

/** Vancouver-local ISO date (YYYY-MM-DD) for a UTC instant. */
export function localIsoDate(instant: Date): string {
  return toVancouverParts(instant).isoDate;
}

const SHORT_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
});

/**
 * Short "Jul 18 – Jul 20" label for two local YYYY-MM-DD dates (collapses when they are equal).
 *
 * Lives beside the other local-date helpers because three surfaces now print a date range in
 * these words — the searched range in the results summary, a multi-day occurrence's own
 * when-line on the card/detail, and the same occurrence's when-line in the weekly email — and
 * one label with three definitions is a wording drift waiting to happen. Anchored at UTC-noon
 * so the calendar day is exact regardless of the server's own timezone.
 */
export function formatRangeLabel(fromIso: string, toIso: string): string {
  const short = (iso: string) => SHORT_DATE_FMT.format(new Date(`${iso}T12:00:00Z`));
  return fromIso === toIso ? short(fromIso) : `${short(fromIso)} – ${short(toIso)}`;
}

/** Add whole days to a local ISO date string, returning a new YYYY-MM-DD (UTC-noon anchored to avoid DST edges). */
export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  const yy = anchor.getUTCFullYear();
  const mm = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(anchor.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
