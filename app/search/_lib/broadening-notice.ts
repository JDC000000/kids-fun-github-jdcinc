// app/search/_lib/broadening-notice.ts — "your search was widened, and here is exactly how".
//
// When a search is too thin to fill a page, the engine climbs a broadening ladder
// (lib/search/broaden.ts) that relaxes constraints one rung at a time. Doing that is
// reasonable. Doing it QUIETLY is not: /search rendered none of the ladder's output, so a
// widened result set was pixel-identical to an exact one. A parent who asked for a Tuesday
// morning under-2 session and was handed a Saturday afternoon 5–9 one had no way to tell
// whether the product had answered them or ignored them — and every card then reads as a bug.
//
// This derivation turns the rungs that FIRED into one honest sentence. Pure and unit-pinned,
// like the other _lib derivations, because it is load-bearing rather than decorative.
//
// TWO RUNGS ARE DELIBERATELY SILENT, and the reason is the same in both cases — a notice may
// only report things that actually happened:
//   • `synonym_widen` sets `widenText`, which nothing downstream reads (see types.ts). It is
//     inert, so announcing it would be a fresh lie told by the very feature meant to end them.
//   • `expected_section` adds no relaxation; it surfaces seasonal/expected listings, which the
//     results page already renders under its own "Expected / not yet posted" heading.

import type { AgeBandKey, DayPart } from '@/lib/search/types';
import { ADJACENT_DAY_PARTS } from '@/lib/search/filters/time';
import { CONSTRAINT_LABELS, type ConstraintKey } from '@/lib/search/broaden';
import { formatRangeLabel } from './day-groups';
import { AGE_OPTIONS, TIME_OF_DAY_OPTIONS } from './params';

/** The broadened context a rung applied, as it arrives in the /api/search JSON. */
export interface BroadenedContextDto {
  date?: { isoDate: string | null; endIsoDate?: string | null } | null;
  timeOfDay?: DayPart | null;
  ageBands?: AgeBandKey[];
  radiusKm?: number;
}

/** One `broadening.applied[]` entry — only the fields this derivation reads. */
export interface AppliedRungDto {
  key: string;
  constraint?: string;
  context?: BroadenedContextDto | null;
}

export interface BroadeningNotice {
  /** One phrase per rung that genuinely changed the search, in ladder order. */
  changes: string[];
}

const ageLabel = (band: AgeBandKey): string => AGE_OPTIONS.find((o) => o.key === band)?.label ?? band;
const timeLabel = (part: DayPart): string =>
  (TIME_OF_DAY_OPTIONS.find((o) => o.key === part)?.label ?? part).toLowerCase();

/** "a", "a and b", "a, b and c" — an Oxford-comma-free list a sentence can swallow. */
export function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The parent-facing phrase for one rung, or null when the rung changed nothing worth saying. */
function phraseFor(rung: AppliedRungDto): string | null {
  const ctx = rung.context ?? {};
  switch (rung.key) {
    case 'adjacent_date': {
      const date = ctx.date;
      if (!date?.isoDate || !date.endIsoDate) return null;
      return `nearby dates (${formatRangeLabel(date.isoDate, date.endIsoDate)})`;
    }
    case 'adjacent_time': {
      if (!ctx.timeOfDay) return null;
      return `adjacent times of day (${joinPhrases(ADJACENT_DAY_PARTS[ctx.timeOfDay].map(timeLabel))})`;
    }
    case 'adjacent_age': {
      const bands = ctx.ageBands ?? [];
      if (bands.length === 0) return null;
      return `neighbouring age groups (${joinPhrases(bands.map(ageLabel))})`;
    }
    case 'drop_chip': {
      const key = rung.constraint as ConstraintKey | undefined;
      if (!key || !(key in CONSTRAINT_LABELS)) return null;
      return `your ${CONSTRAINT_LABELS[key]} set aside`;
    }
    case 'radius_expand': {
      if (ctx.radiusKm == null) return null;
      return `a wider ${ctx.radiusKm} km search`;
    }
    // synonym_widen (inert) and expected_section (its own section heading) say nothing here.
    default:
      return null;
  }
}

/**
 * Describe what the ladder did, or null when it did nothing worth reporting — which is the
 * common case and means "render nothing", so an unbroadened search stays exactly as it is.
 */
export function describeBroadening(applied: AppliedRungDto[] | undefined): BroadeningNotice | null {
  const changes = (applied ?? []).map(phraseFor).filter((p): p is string => p != null);
  return changes.length > 0 ? { changes } : null;
}
