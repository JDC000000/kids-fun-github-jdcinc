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

/** Decompose a UTC instant into Vancouver-local calendar/clock parts. */
export function toVancouverParts(instant: Date): VancouverParts {
  const parts = PARTS_FMT.formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === '24' ? 0 : Number(map.hour); // Intl may emit '24' at midnight
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    weekday: WEEKDAY_INDEX[map.weekday] ?? 0,
    isoDate: `${map.year}-${map.month}-${map.day}`,
  };
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
