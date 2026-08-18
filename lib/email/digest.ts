// lib/email/digest.ts — build the weekly-digest DATA model for one user.
//
// This is the heart of the feature and is deliberately PURE over its inputs: given
// a wired SearchEngine, the user's saved searches, and the set of occurrence ids
// that are NEW since the user's last email, it produces the digest with no DB or
// network access. That makes it exhaustively unit-testable against the fixture
// engine, and lets the DB glue (lib/email/weekly.ts) own all the I/O.
//
// Matching REUSES the real search pipeline (SearchEngine) rather than
// re-implementing matching in SQL — so what a parent gets in the digest is exactly
// what they'd get on /search. Each saved search's stored `params` (the /search URL
// shape, Task B) is turned back into a SearchRequest with the SAME pure helpers the
// page uses (parseSearchState + intentPhrases), so the two can never drift.
//
// "New/upcoming since last email": the engine's DB read model only returns
// non-expired occurrences (postgres-repository visibleOccurrenceWhereSql), so every
// candidate is already UPCOMING; we then keep only those whose occurrence id is in
// `newOccurrenceIds` (created since the watermark), i.e. genuinely NEW since we last
// wrote. Broadening is disabled (minResults: 0) so the digest never pads itself with
// non-matching "expected/seasonal" suggestions — only real matches.
//
// A saved search that matches NOTHING is still dropped from `sections` (there is nothing
// to list) but is no longer dropped SILENTLY: it is recorded in `emptySearches` together
// with the constraint the engine found to be blocking it. Declining to pad an email is not
// the same as declining to say why it is thin, and until now those were one decision.
import type { SearchEngine } from '@/lib/search/engine';
import type { ListingRecord } from '@/lib/search/types';
import type { OccurrenceSlot } from '@/lib/search/collapse';
import type { ConstraintKey } from '@/lib/search/broaden';
import { runSavedSearch } from '@/lib/search/saved-search-status';
import { hrefForParams } from '@/app/search/_lib/params';
import { appUrl } from './config';
import { formatWhen, formatCost, savedSearchLabel } from './format';

export const DEFAULT_PER_SEARCH_LIMIT = 6;

/** A saved search as consumed by the digest (unwrapped envelope). */
export interface DigestSavedSearch {
  id: string;
  name: string | null;
  params: Record<string, unknown>;
}

/** One matching activity as it appears in the email. */
export interface DigestActivity {
  id: string;
  seriesId: string;
  name: string;
  venue: string;
  when: string;
  cost: string;
  url: string;
  /**
   * True when this row came back under an active age filter WITHOUT the source ever stating an
   * age (lib/search/engine.ts `ageUnconfirmed`).
   *
   * The engine now hands these back in their own array so /search can hold them under an explicit
   * "Age not stated by source" heading instead of mixing them into the confirmed matches (Jon's
   * ruling 2026-08-18, option b). An email has no room for a second section, and the two wrong
   * answers here are both easy to reach by accident: read `results` only and a listing a parent
   * used to be told about silently stops arriving, or read both and the email states an age match
   * the catalogue never made. So the row is included AND flagged, and the template says so on the
   * line — the same deal the page offers, in the space an email has.
   */
  ageNotConfirmed?: boolean;
}

/** One saved search's block in the digest (only present when it has new matches). */
export interface DigestSection {
  savedSearchId: string;
  label: string;
  searchUrl: string;
  activities: DigestActivity[];
}

/**
 * A saved search that currently matches NOTHING AT ALL, and the constraint blocking it.
 *
 * Distinct from "has matches but nothing new this week": that search is not blocked by a
 * filter and gets no entry here, because naming one would be false.
 */
export interface DigestEmptySearch {
  savedSearchId: string;
  label: string;
  /** /search URL rebuilt from the stored params, so the parent can open and adjust it. */
  searchUrl: string;
  blockingConstraint: ConstraintKey | null;
  /** Human label for the blocking constraint, e.g. "price limit". Null when none unlocks it. */
  blockingLabel: string | null;
}

/** The full per-user digest data model. */
export interface WeeklyDigest {
  userId: string;
  sections: DigestSection[];
  totalActivities: number;
  /**
   * Saved searches that matched nothing, with the reason. Reporting only — it does NOT
   * feed `shouldSend`; see the note there.
   */
  emptySearches: DigestEmptySearch[];
  /** True iff there is at least one new matching activity worth emailing. */
  shouldSend: boolean;
}

export interface BuildDigestInput {
  userId: string;
  engine: SearchEngine;
  savedSearches: DigestSavedSearch[];
  /** The signed-in user's saved home postal, for saved-location ("home=1") searches. */
  homePostal: string | null;
  now: Date;
  /** Occurrence ids created since this user's last email (the "new" set). */
  newOccurrenceIds: Set<string>;
  perSearchLimit?: number;
}

/** Start-time key for soonest-first ordering; open-hours / undated sort last. */
function startKey(l: ListingRecord): number {
  if (l.openHours || !l.startDatetimeUtc) return Number.POSITIVE_INFINITY;
  const t = new Date(l.startDatetimeUtc).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** One candidate row: the occurrence to announce, plus whether its age was ever stated. */
interface DigestRow {
  listing: ListingRecord;
  ageNotConfirmed: boolean;
}

/** Keep the soonest upcoming occurrence per series, so a weekly series is one row, not five. */
function dedupeSoonestPerSeries(rows: DigestRow[]): DigestRow[] {
  const sorted = [...rows].sort((a, b) => startKey(a.listing) - startKey(b.listing));
  const seen = new Set<string>();
  const out: DigestRow[] = [];
  for (const row of sorted) {
    if (seen.has(row.listing.seriesId)) continue;
    seen.add(row.listing.seriesId);
    out.push(row);
  }
  return out;
}

/**
 * The card's own record re-pointed at ONE of its occurrences.
 *
 * WHY THIS EXISTS. Search hands back one card per series with every occurrence in `slots`
 * (lib/search/collapse.ts), and the occurrence that KEEPS the card is whichever ranked best —
 * which, under any sort but "soonest", need not be the one that is new this week. Reading only
 * the card's own listing would therefore have made the digest go quiet about genuinely new
 * sessions of a series a parent already knew about: exactly the silent-reduction failure the
 * `ageUnconfirmed` note above is about, arriving through a different door.
 *
 * Every field this overrides is a per-OCCURRENCE fact the slot carries first-hand (its instants
 * and its own three cost fields — see `OccurrenceSlot`, which exists because members of one group
 * really do disagree about price). Everything left untouched is a series/venue fact that is the
 * same for every member. So the row states what that occurrence IS; nothing is inferred from a
 * sibling.
 */
function occurrenceRecord(card: ListingRecord, slot: OccurrenceSlot): ListingRecord {
  return {
    ...card,
    id: slot.id,
    startDatetimeUtc: slot.startDatetimeUtc,
    endDatetimeUtc: slot.endDatetimeUtc,
    costStatus: slot.costStatus,
    costMinCad: slot.costMinCad,
    costMaxCad: slot.costMaxCad,
  };
}

function toActivity(listing: ListingRecord, ageNotConfirmed = false): DigestActivity {
  return {
    id: listing.id,
    seriesId: listing.seriesId,
    name: listing.activityName,
    venue: listing.venueName,
    when: formatWhen(listing),
    cost: formatCost(listing),
    url: appUrl(`/preview/${encodeURIComponent(listing.id)}`),
    ...(ageNotConfirmed ? { ageNotConfirmed } : {}),
  };
}

/**
 * Build the weekly digest for one user. Pure: no DB/network. Sections with no new
 * matches are omitted; `shouldSend` is false when nothing new matches any saved
 * search (the caller must NOT send — and must NOT advance the watermark — in that
 * case, so nothing new is missed next week).
 *
 * A saved search that matched NOTHING AT ALL also lands in `emptySearches` with the
 * constraint blocking it, so a digest that IS being sent can say why one of its saved
 * searches is missing. That is reporting only: see `shouldSend` below.
 */
export function buildWeeklyDigest(input: BuildDigestInput): WeeklyDigest {
  const perSearchLimit = input.perSearchLimit ?? DEFAULT_PER_SEARCH_LIMIT;
  const sections: DigestSection[] = [];
  const emptySearches: DigestEmptySearch[] = [];

  for (const ss of input.savedSearches) {
    const run = runSavedSearch(input.engine, ss.params, input.homePostal, input.now);

    // BOTH primary sections. Under an age filter the engine holds unstated-age listings in
    // `ageUnconfirmed` rather than mixing them into `results`; reading only `results` here would
    // silently stop emailing a parent about listings they used to be told about — a reduction in
    // what the product says, dressed up as a presentation change. They are carried and FLAGGED
    // (see DigestActivity.ageNotConfirmed) so the row states its own caveat.
    //
    // Read at the SLOT level, not the card level: a card stands for every occurrence of its
    // series, so "is this new since the last email?" is a question about the occurrences behind
    // it, and the row announces the SOONEST new one (slots are ascending, so the first match is
    // it). See `occurrenceRecord`.
    const fresh: DigestRow[] = [];
    for (const [items, ageNotConfirmed] of [
      [run.response.results, false],
      [run.response.ageUnconfirmed, true],
    ] as const) {
      for (const item of items) {
        const newSlot = item.slots.find((slot) => input.newOccurrenceIds.has(slot.id));
        if (!newSlot) continue;
        fresh.push({ listing: occurrenceRecord(item.listing, newSlot), ageNotConfirmed });
      }
    }

    const deduped = dedupeSoonestPerSeries(fresh).slice(0, perSearchLimit);
    if (deduped.length === 0) {
      // No empty sections — but record WHY when the reason is a constraint. `run.emptyState`
      // is non-null only when the saved search matched nothing at all; a search with plenty
      // of matches that simply has nothing NEW this week is not blocked by a filter, so it
      // gets no line rather than a wrong one.
      if (run.emptyState) {
        emptySearches.push({
          savedSearchId: ss.id,
          label: savedSearchLabel(ss.name, run.query),
          searchUrl: appUrl(hrefForParams(ss.params)),
          blockingConstraint: run.emptyState.blockingConstraint,
          blockingLabel: run.emptyState.blockingLabel,
        });
      }
      continue;
    }

    sections.push({
      savedSearchId: ss.id,
      label: savedSearchLabel(ss.name, run.query),
      searchUrl: appUrl(hrefForParams(ss.params)),
      activities: deduped.map((row) => toActivity(row.listing, row.ageNotConfirmed)),
    });
  }

  const totalActivities = sections.reduce((n, s) => n + s.activities.length, 0);
  return {
    userId: input.userId,
    sections,
    totalActivities,
    emptySearches,
    // DELIBERATELY UNCHANGED, and it must stay that way. An email still requires at least one
    // GENUINE new match. `emptySearches` is explanatory payload for an email that is already
    // being sent — it must never become a reason to send one, or a parent whose searches all
    // match nothing would start receiving mail whose entire content is "nothing matched".
    // tests/email/digest_empty_state.test.ts guards this.
    shouldSend: totalActivities > 0,
  };
}
