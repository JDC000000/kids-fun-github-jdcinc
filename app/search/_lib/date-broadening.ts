// app/search/_lib/date-broadening.ts — "your dates were widened, and here is how far".
//
// The broadening ladder (lib/search/broaden.ts) may widen a date request to a nearby window
// when the exact one is too sparse to fill a page. That is a reasonable thing to DO and an
// unacceptable thing to do QUIETLY: a parent who asked for one day and is handed a week of
// results with no notice reads them as answers to their question, and every card's date then
// reads as a mistake rather than as a deliberate substitution.
//
// This is the derivation behind that notice. Pure, unit-pinned, and deliberately narrow: it
// speaks ONLY for the date rung. The other rungs (radius, text, chips) are out of its scope —
// notably `radius_expand`, which fires on the default 10km radius even when there is no origin
// to measure from and so would otherwise put a notice on searches nothing was done to.

import { formatRangeLabel } from './day-groups';
import { whenChipLabel } from './filter-summary';
import { hasDateRange, type SearchState } from './params';

/** The date window a rung applied, as it arrives in the /api/search JSON. */
export interface BroadenedDateDto {
  isoDate: string | null;
  endIsoDate?: string | null;
}

/** One `broadening.applied[]` entry — only the fields this derivation reads. */
export interface AppliedRungDto {
  key: string;
  context?: { date?: BroadenedDateDto | null } | null;
}

export interface DateBroadening {
  /**
   * The parent's own words for what they asked for ("Sep 14", "This weekend"), or null when
   * the date intent came from free text rather than a control — in which case the URL state
   * cannot name it and claiming otherwise would be a second small lie.
   */
  requested: string | null;
  /** The window the shown results are ACTUALLY filtered to, e.g. "Sep 11 – Sep 17". */
  shown: string;
}

/**
 * Describe the date relaxation, or null when the dates on screen are exactly the dates asked
 * for. Null is the common case and means "render nothing" — an unbroadened search must stay
 * visually identical to what it is today.
 */
export function describeDateBroadening(
  state: SearchState,
  applied: AppliedRungDto[] | undefined,
): DateBroadening | null {
  const widened = applied?.find((rung) => rung.key === 'adjacent_date')?.context?.date;
  if (!widened?.isoDate || !widened.endIsoDate) return null;

  // `whenChipLabel` falls back to "Any day" for a state carrying no date control, which would
  // misname a free-text date intent ("swim saturday"). Say nothing rather than say that.
  const named = hasDateRange(state) || state.when !== 'any';
  return {
    requested: named ? whenChipLabel(state) : null,
    shown: formatRangeLabel(widened.isoDate, widened.endIsoDate),
  };
}
