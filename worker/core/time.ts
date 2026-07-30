// worker/core/time.ts — shared, DST-aware local-wall-clock → UTC conversion.
//
// WHY THIS EXISTS (extracted, not duplicated)
// Several sources publish LOCAL WALL-CLOCK timestamps with NO offset:
//   • BiblioCommons  "2026-07-15T10:00:00"      (worker/adapters/library)
//   • ActiveNet      "2026-07-30 15:30:00"      (worker/adapters/activenet)
// Interpreting those as UTC silently shifts every listing by 7–8 hours, and doing
// the conversion with a FIXED offset silently breaks by an hour on either side of
// a DST transition. The conversion therefore has to resolve the offset that is
// actually in force at that instant, in a named IANA zone.
//
// The implementation used to live privately inside the library adapter; ActiveNet
// needed the identical logic, so it moved here rather than being copied (a second
// copy of a DST rule is a second copy that can rot independently).
//
// CORRECTNESS NOTE — why two passes, not one.
// Resolving a zoned local time to an instant is a fixed-point problem: you need the
// zone offset at the *target instant*, but you only know the *local* time. The
// single-pass approximation (offset sampled at "local-as-if-UTC") is wrong for local
// times within one UTC-offset of a transition — e.g. in America/Vancouver a local
// 2026-11-01 01:30 is sampled at an instant that is still PDT, yielding the PDT
// offset when the true instant is PST. A second pass re-samples the offset at the
// candidate instant, which converges for every real zone (offsets change by ≤ a few
// hours, and no zone has two transitions within that span).
//
// Two local times are genuinely not one-to-one with instants and are resolved
// deliberately, not accidentally (both verified against America/Vancouver 2026):
//   • SPRING-FORWARD GAP (a local time that never occurs — 2026-03-08 02:30) → a
//     well-defined instant, never NaN: the summer offset is applied, so the result
//     renders as the local hour immediately BEFORE the gap (01:30 PST). No instant
//     can render as a skipped local time, so some such choice is unavoidable; this
//     one at least keeps the listing on the right day and within an hour.
//   • FALL-BACK OVERLAP (a local time that occurs twice — 2026-11-01 01:30) → the
//     FIRST (pre-transition, PDT) occurrence, which is what a published schedule
//     means by "1:30am" on that morning.

/** The product's single local timezone (TSD cross-cutting canon: store UTC, display local). */
export const DEFAULT_TIME_ZONE = 'America/Vancouver';

/** Accepts "YYYY-MM-DDTHH:MM(:SS)" and "YYYY-MM-DD HH:MM(:SS)" — the two shapes our
 *  offset-less sources publish. Anything else is rejected rather than guessed. */
const LOCAL_WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/** The wall-clock fields `date` renders to in `timeZone`. */
function zonedParts(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)])
  );
}

/** Zone offset in ms (east-positive) in force at instant `utcMs`. */
function offsetMsAt(utcMs: number, timeZone: string): number {
  const r = zonedParts(new Date(utcMs), timeZone);
  // Intl renders midnight as hour 24 in some ICU versions; normalise to 0.
  const hour = r.hour === 24 ? 0 : r.hour;
  const renderedAsUtc = Date.UTC(r.year, r.month - 1, r.day, hour, r.minute, r.second);
  return renderedAsUtc - utcMs;
}

/**
 * Convert an offset-less LOCAL wall-clock timestamp in `timeZone` to a UTC ISO instant.
 * Returns undefined for empty/unparseable input (callers treat that as "no start time"
 * rather than inventing one).
 */
export function zonedLocalToUtcIso(
  local: string | undefined | null,
  timeZone: string = DEFAULT_TIME_ZONE
): string | undefined {
  if (!local) return undefined;
  const m = LOCAL_WALL_CLOCK_RE.exec(local.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s = '0'] = m;
  const localAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (!Number.isFinite(localAsUtc)) return undefined;

  // Pass 1: offset sampled at local-as-if-UTC. Pass 2: re-sample at the candidate
  // instant, which is what makes this DST-correct (see header).
  const firstPass = localAsUtc - offsetMsAt(localAsUtc, timeZone);
  const secondPass = localAsUtc - offsetMsAt(firstPass, timeZone);
  return new Date(secondPass).toISOString();
}

/** The local calendar date (YYYY-MM-DD) that `instant` falls on in `timeZone`.
 *  Used to build fetch windows in the source's own local days rather than in UTC. */
export function zonedDateString(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const p = zonedParts(instant, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
