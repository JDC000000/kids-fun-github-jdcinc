// invariants/_time.ts — An America/Vancouver oracle the PRODUCT does not own.
//
// WHY THIS DUPLICATES lib/search/time/vancouver.ts ON PURPOSE. Every date invariant in this
// suite is a claim about local days: "when=today resolved to the Vancouver day, not the UTC
// day". Asserting that with `localIsoDate()` — the very function under test — proves only
// that the function agrees with itself, which is exactly the shape of assertion that let a
// UTC-day bug survive a green suite. So the oracle here is written independently, from
// `Intl.DateTimeFormat` directly, and never imports from lib/.
//
// It is deliberately SMALL: three questions (what local day is this instant, what instant is
// this local wall-clock time, and what is this local day plus N). Anything larger would start
// to be a second implementation worth its own tests.

export const VANCOUVER_TZ = 'America/Vancouver';

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: VANCOUVER_TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0=Sun … 6=Sat, Vancouver-local. */
  weekday: number;
  /** YYYY-MM-DD, Vancouver-local. */
  isoDate: string;
  /** Minutes past local midnight (0..1439). */
  minutesOfDay: number;
}

/** Decompose a UTC instant into Vancouver-local calendar/clock parts. */
export function localParts(instant: Date): LocalParts {
  const map: Record<string, string> = {};
  for (const part of PARTS.formatToParts(instant)) map[part.type] = part.value;
  // `en-US` with hour12:false emits '24' for local midnight in some ICU versions.
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  const minute = Number(map.minute);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute,
    second: Number(map.second),
    weekday: WEEKDAY_INDEX[map.weekday] ?? -1,
    isoDate: `${map.year}-${map.month}-${map.day}`,
    minutesOfDay: hour * 60 + minute,
  };
}

/** Vancouver-local YYYY-MM-DD for a UTC instant. */
export function localDay(instant: Date): string {
  return localParts(instant).isoDate;
}

/** Vancouver-local minutes past midnight for a UTC instant. */
export function localMinutes(instant: Date): number {
  return localParts(instant).minutesOfDay;
}

/** The zone's UTC offset in minutes at a given instant (PDT → -420, PST → -480). */
function offsetMinutes(instant: Date): number {
  const p = localParts(instant);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asIfUtc - instant.getTime()) / 60_000);
}

/**
 * The UTC instant for a Vancouver-local wall-clock time.
 *
 * Two passes, because the offset depends on the instant we are trying to find: guess with the
 * zone-naive value, read the real offset there, correct, then read it once more so a guess that
 * landed on the wrong side of a DST transition still converges. During the repeated hour of a
 * fall-back this returns the FIRST (daylight-time) occurrence, which is the convention every
 * caller here wants — the corpus only needs a stable, real instant for a stated local time.
 */
export function localToUtc(isoDate: string, hour: number, minute = 0): Date {
  const [y, m, d] = isoDate.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, hour, minute, 0);
  let ts = naive;
  for (let i = 0; i < 2; i += 1) ts = naive - offsetMinutes(new Date(ts)) * 60_000;
  return new Date(ts);
}

/**
 * Add whole days to a local YYYY-MM-DD. Anchored at UTC noon so a DST transition can never
 * carry the arithmetic into the neighbouring day.
 */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  const mm = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(anchor.getUTCDate()).padStart(2, '0');
  return `${anchor.getUTCFullYear()}-${mm}-${dd}`;
}

/** YYYY-MM-DD strings order lexicographically exactly as they order chronologically. */
export function daysOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom <= bTo && bFrom <= aTo;
}
