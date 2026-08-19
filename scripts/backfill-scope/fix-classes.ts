// scripts/backfill-scope/fix-classes.ts — one re-derivation rule per §3h worker-side fix class.
//
// Pure functions, no database, no network, no clock. `measure.ts` supplies stored rows and
// renders the tally; everything here is a decision about ONE row and is unit-testable without
// either.
//
// ── THE ONE IDEA THIS FILE IMPLEMENTS ────────────────────────────────────────────────────
// A worker-side parser fix changes what the ingest path WRITES. It does not change what is
// already written, and — this is §3h — when the fixed parser concludes "no age claim can be
// made", worker/core/ingest.ts writes NOTHING rather than clearing the stale value:
//
//     const ageParse = record.ageAudienceLabels?.length ? parseAudienceLabels(...)
//                    : record.ageText ? parseAgeText(record.ageText) : null;
//     ...
//     if (ageParse) { await upsertOccurrenceAge(...); }        // ingest.ts:294
//
// So every row splits three ways under a given fix, and the split is the entire deliverable:
//
//   SELF_HEALS  the fixed parser still makes a claim, and it differs from what is stored.
//               The next re-ingest overwrites the row. NO BACKFILL IS NEEDED — deploying is
//               the whole remedy. Counting these as "stale" is the easiest way to inflate a
//               backfill's apparent size, so they are counted separately and deliberately.
//   STALE_3H    the fixed parser makes NO claim, and a claim is stored. `if (ageParse)` is
//               false, nothing is written, and the stale claim survives EVERY future
//               re-ingest, forever. These and only these need a write to correct.
//   AGREES      stored already equals what the fixed parser produces. Nothing to do.
//
// and a fourth outcome that is not a verdict but an admission:
//
//   AMBIGUOUS   the fixed parser's decision depends on an input production does not retain.
//               Reported with a real count and never guessed at. This is the same discipline
//               the Operator applied by hand when they corrected 73 unambiguous PerfectMind
//               rows and deliberately left ~55 ambiguous ones alone.
//
// ── WHY THESE CALL THE SHIPPED PARSERS RATHER THAN COPIES OF THEIR REGEXES ───────────────
// Several of the decisive patterns (PerfectMind's TITLE_STATES_AGE_RE, CityCalendar's
// ADULT_SUBJECT_RE, ActiveNet's titleStatesAge) are module-private. Copying them here would
// make this tool measure a SNAPSHOT of the fix rather than the fix, and the copy would rot
// silently the first time one of them is tuned. Instead every class below drives the real
// exported entry point with a synthetic record — which is exactly how each fix's own
// regression tests drive it (tests/adapters/perfectmind.test.ts:772 builds
// `({ EventName, NoAgeRestriction: true })` for precisely this reason). What is measured here
// is therefore what ships.
import { extractAgeText } from '../../worker/adapters/activenet/parse';
import { resolveAgeText } from '../../worker/adapters/perfectmind/parse';
import { resolveBiblioCommonsAgeSignal } from '../../worker/adapters/library/index';
import { CityCalendarAdapter } from '../../worker/adapters/citycalendar';
import { getCityCalendar } from '../../worker/adapters/citycalendar/config';
import { parseAgeText, type AgeParse } from '../../worker/core/age';

/** One occurrence as production stores it, joined to its occurrence_age row if any. */
export interface StoredRow {
  occurrenceId: string;
  family: string;
  activityName: string;
  openHoursState: string | null;
  hasAgeRow: boolean;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  ageNotes: string | null;
  bandCount: number;
  lastCheckedAt: string | null;
}

export type Verdict =
  /** Stored already equals today's parser output. */
  | 'agrees'
  /** Today's parser still claims something, but different — the next re-ingest overwrites it. */
  | 'self_heals'
  /** Today's parser claims nothing and a claim is stored — survives re-ingest forever. §3h. */
  | 'stale_3h'
  /** The decision needs an input production does not retain. Never guessed. */
  | 'ambiguous'
  /** This fix cannot touch this row (wrong family, or the gate provably does not fire). */
  | 'not_applicable';

export interface RowFinding {
  occurrenceId: string;
  activityName: string;
  verdict: Verdict;
  /** Short machine-readable reason, tallied in the report so every count is explainable. */
  reason: string;
  storedClaim: string;
  derivedClaim: string;
  /**
   * When ingest last upserted this row. Carried through to the report because it is what turns
   * a PREDICTION into an OBSERVATION: a row whose stored claim today's parser would not make,
   * and which has been re-ingested since the fixed build started running, has DEMONSTRABLY
   * survived a post-fix re-ingest. That is §3h caught in the act rather than argued from the
   * code. `measure.sh --deployed-since <iso>` supplies the boundary.
   */
  lastCheckedAt: string | null;
}

/** A stored age claim is "positive" when it asserts bounds a parent's filter can match on. */
export function hasPositiveClaim(row: StoredRow): boolean {
  return row.hasAgeRow && (row.ageMinMonths !== null || row.ageMaxMonths !== null);
}

export function describeStored(row: StoredRow): string {
  if (!row.hasAgeRow) return 'no occurrence_age row';
  const notes = row.ageNotes === null ? 'NULL' : JSON.stringify(row.ageNotes);
  return `[${row.ageMinMonths ?? '-'}, ${row.ageMaxMonths ?? '∞'}) bands=${row.bandCount} notes=${notes}`;
}

function describeParse(parse: AgeParse | null): string {
  if (!parse) return 'no claim (no occurrence_age row would be written)';
  return `[${parse.ageMinMonths ?? '-'}, ${parse.ageMaxMonths ?? '∞'}) resolved=${parse.resolved}`;
}

/** Does today's parse assert the same bounds the row already holds? */
function sameBounds(row: StoredRow, parse: AgeParse): boolean {
  return row.ageMinMonths === parse.ageMinMonths && row.ageMaxMonths === parse.ageMaxMonths;
}

/**
 * The shared ending for every class whose fixed parser produced `ageText`: turn that wording
 * into the three-way verdict. `derivedAgeText === undefined` is the §3h case — and it is only
 * §3h if there is in fact a stored claim to be left behind.
 */
function verdictFor(row: StoredRow, derivedAgeText: string | undefined, reasonPrefix: string): RowFinding {
  const parse = derivedAgeText ? parseAgeText(derivedAgeText) : null;
  const base = {
    occurrenceId: row.occurrenceId,
    activityName: row.activityName,
    lastCheckedAt: row.lastCheckedAt,
    storedClaim: describeStored(row),
    derivedClaim: describeParse(parse),
  };
  if (!parse) {
    return hasPositiveClaim(row)
      ? { ...base, verdict: 'stale_3h', reason: `${reasonPrefix}:claim-withdrawn-row-survives` }
      : { ...base, verdict: 'agrees', reason: `${reasonPrefix}:no-claim-either-side` };
  }
  if (!row.hasAgeRow) return { ...base, verdict: 'self_heals', reason: `${reasonPrefix}:row-would-be-created` };
  if (sameBounds(row, parse)) return { ...base, verdict: 'agrees', reason: `${reasonPrefix}:bounds-match` };
  return { ...base, verdict: 'self_heals', reason: `${reasonPrefix}:bounds-differ-overwrite-on-reingest` };
}

// ── class 2 — venue-allages (959d123) ────────────────────────────────────────────────────
//
// buildOpenHoursRecord used to hardcode `ageText: 'All ages'`. It now emits none, so an
// open-hours record makes no age claim and no occurrence_age row is written. There is no
// wording to re-derive: the fixed builder's output is unconditionally "no claim", so every
// open-hours row that still holds a claim is §3h-stale by construction. No input is needed
// beyond the fact that the row IS an open-hours record, which `open_hours_state` states.
export function classifyVenueAllAges(row: StoredRow): RowFinding {
  const base = {
    occurrenceId: row.occurrenceId,
    activityName: row.activityName,
    lastCheckedAt: row.lastCheckedAt,
    storedClaim: describeStored(row),
    derivedClaim: 'no claim (builder emits no ageText at all)',
  };
  if (row.openHoursState === null) return { ...base, verdict: 'not_applicable', reason: 'venue:not-an-open-hours-record' };
  return hasPositiveClaim(row)
    ? { ...base, verdict: 'stale_3h', reason: 'venue:fabricated-all-ages-survives' }
    : { ...base, verdict: 'agrees', reason: 'venue:no-claim-either-side' };
}

// ── classes 3 + 6 + 7 — ActiveNet (f15d6c8, 3b29456, 6637ae5) ────────────────────────────
//
// extractAgeText has two independent halves joined by ' — ':
//     titleClaim = titleStatesAge(title) ? title : undefined      ← f15d6c8 gated it, 3b29456 tuned the gate
//     phrase     = statedAgePhrase(stripHtml(description))        ← 6637ae5 rewrote this
//
// The title half is a pure function of `activity_name` and is therefore exactly reproducible.
// The phrase half needs the description, which production does not retain in ANY column
// (description_snippet is NULL on 100% of rows and no adapter has ever written it — see
// lib/audit/types.ts:24). So the phrase is recoverable ONLY where `age_notes` echoed the whole
// pre-fix ageText back, which worker/core/age.ts does for unresolved parses and nothing else:
//     notes: `unresolved: ${ageText.trim()}`                       age.ts:309
//
// That produces an uncomfortable but honest structural result, and it is stated here rather
// than buried in the report: the rows whose input IS fully recoverable are the UNRESOLVED ones,
// which hold null bounds and therefore cannot harm a parent's search; and the rows that hold a
// harmful positive claim are exactly the RESOLVED ones, whose `age_notes` is NULL and whose
// description is gone. For those, this returns 'ambiguous' with the title-only evidence
// attached, never a guess.
export function classifyActiveNetTitleGate(row: StoredRow): RowFinding {
  const title = row.activityName;
  const recovered = recoverActiveNetAgeText(row);

  if (recovered.kind === 'exact') {
    // Full pre-fix ageText recovered from age_notes. Feeding the recovered description phrase
    // back in as `description` is faithful: statedAgePhrase() is the identity on a string that
    // is itself an age phrase, so this isolates the title-gate fixes and holds 6637ae5 constant.
    return verdictFor(row, extractAgeText({ title, description: recovered.phrase }), 'activenet');
  }

  // No echo of the pre-fix wording. Decide only what the TITLE alone can decide.
  const titleOnly = extractAgeText({ title });
  const base = {
    occurrenceId: row.occurrenceId,
    activityName: title,
    lastCheckedAt: row.lastCheckedAt,
    storedClaim: describeStored(row),
    derivedClaim: titleOnly ? `title admitted: ${JSON.stringify(titleOnly)}` : 'title rejected by the fixed gate',
  };

  if (titleOnly !== undefined) {
    // The fixed gate still admits this title, so neither f15d6c8 nor 3b29456 withdraws
    // anything here. Only 6637ae5 (description-only) could still change the row, and that is
    // unmeasurable — so this row is provably NOT §3h-stale on account of the title fixes.
    const parse = parseAgeText(titleOnly);
    if (hasPositiveClaim(row) && !sameBounds(row, parse)) {
      return { ...base, verdict: 'ambiguous', reason: 'activenet:title-admitted-but-bounds-differ-description-unknown' };
    }
    return { ...base, verdict: 'not_applicable', reason: 'activenet:title-still-admitted-by-fixed-gate' };
  }

  // The fixed gate REJECTS this title. Whatever the stored claim was, the title no longer
  // contributes to it. Whether the row ends up with nothing (→ §3h stale) or with a surviving
  // description phrase (→ self-heals) depends on the description, which is gone.
  if (!hasPositiveClaim(row)) {
    return { ...base, verdict: 'agrees', reason: 'activenet:no-positive-claim-stored' };
  }
  // One discriminator IS available: if today's parser, given the title alone, reproduces the
  // stored bounds exactly, then the stored claim is consistent with having been manufactured
  // from the title — the precise thing f15d6c8/3b29456 withdraw. That makes it a CANDIDATE,
  // not a confirmed stale row, and it is reported as such.
  const titleDerived = parseAgeText(title);
  return sameBounds(row, titleDerived)
    ? { ...base, verdict: 'ambiguous', reason: 'activenet:candidate-title-manufactured-claim' }
    : { ...base, verdict: 'ambiguous', reason: 'activenet:title-rejected-source-of-stored-claim-unknown' };
}

interface RecoveredAgeText {
  kind: 'exact' | 'unavailable';
  phrase?: string;
}

/**
 * Pull the pre-fix `ageText` back out of `age_notes`, and split it into its title and
 * description halves. Anchoring on the title rather than splitting on the em-dash is
 * deliberate: rec-centre titles are full of hyphens and several contain an em-dash of their own.
 */
export function recoverActiveNetAgeText(row: StoredRow): RecoveredAgeText {
  const notes = row.ageNotes;
  if (!notes || !notes.startsWith('unresolved: ')) return { kind: 'unavailable' };
  const ageText = notes.slice('unresolved: '.length);
  const title = row.activityName;
  if (ageText === title) return { kind: 'exact', phrase: undefined };
  const joined = `${title} — `;
  if (ageText.startsWith(joined)) return { kind: 'exact', phrase: ageText.slice(joined.length) };
  // The title was not admitted by whichever generation wrote this row, so the whole echo is
  // the description phrase.
  return { kind: 'exact', phrase: ageText };
}

// ── class 5 — PerfectMind NoAgeRestriction (9f95e31) ─────────────────────────────────────
//
// The fix fires on ONE conjunction: the vendor's `NoAgeRestriction` flag was true AND the
// venue's own title states an age. The flag is not retained in any column — but it is
// recoverable by a one-to-one proxy, because the flag's branch is the only PerfectMind path
// that emits the literal `ageText: 'All ages'` (parse.ts:423), and `notes: 'all-ages'` is
// written by exactly one branch of parseAgeText (age.ts:299). So:
//
//     age_notes = 'all-ages'  ⇒  this row came from the NoAgeRestriction branch
//
// The proxy is not perfectly pure — the display-restrictions / age-restrictions fallbacks could
// in principle carry vendor text reading "all ages" or "family" — but those branches are only
// reached when the structured fields are unusable, and parseAgeText checks its numeric rules
// before ALL_AGES_RE. The residual is reported as a caveat, not claimed to be zero.
//
// Running the title gate over rows OUTSIDE that proxy would be the single biggest over-count
// available here: a title stating an age with the flag OFF takes a structured path and is
// untouched by this fix (pinned by tests/adapters/perfectmind.test.ts:861).
export function classifyPerfectMind(row: StoredRow): RowFinding {
  const base = {
    occurrenceId: row.occurrenceId,
    activityName: row.activityName,
    lastCheckedAt: row.lastCheckedAt,
    storedClaim: describeStored(row),
    derivedClaim: '',
  };
  if (row.ageNotes !== 'all-ages') {
    return { ...base, verdict: 'not_applicable', reason: 'perfectmind:not-from-the-no-age-restriction-branch', derivedClaim: 'n/a' };
  }
  // Drive the REAL fixed parser with the flag the proxy just established and the stored title.
  const verdict = resolveAgeText({ EventName: row.activityName, NoAgeRestriction: true });
  base.derivedClaim = `code=${verdict.code} ageText=${verdict.ageText === undefined ? 'undefined' : JSON.stringify(verdict.ageText)}`;
  if (verdict.code === 'no-age-restriction-contradicted') {
    return hasPositiveClaim(row)
      ? { ...base, verdict: 'stale_3h', reason: 'perfectmind:title-contradicts-flag-claim-withdrawn' }
      : { ...base, verdict: 'agrees', reason: 'perfectmind:no-claim-stored' };
  }
  return verdictFor(row, verdict.ageText, 'perfectmind');
}

// ── class 4 — CityCalendar adult-subject suppression (f59cd71) ───────────────────────────
//
// The fix withholds a catch-all audience wording when the event's own text names an adult-only
// subject. Two inputs: the wording (which comes from the Trumba `customFields` Audiences tag —
// never persisted, and StructuredRecord.raw carries the whole event but is never written) and
// the haystack title+description (description never persisted either).
//
// `age_notes = 'all-ages'` again stands in for "the pre-fix wording was a catch-all", because
// isCatchAllAudience() defers to the very same parseAgeText branch that writes that literal.
// The suppression guard is then evaluated by driving the real adapter with a synthetic event
// carrying the stored title and a catch-all Audiences tag. What CANNOT be recovered is the
// description half of the haystack, which can move the guard in BOTH directions — a lost
// child-audience word would un-suppress, a lost adult subject would suppress a title that looks
// innocent. So every outcome here is a CANDIDATE, and the class is reported as candidate-only.
const cityCalendarAdapter = (() => {
  const config = getCityCalendar('vancouver');
  return config ? new CityCalendarAdapter(config) : null;
})();

export function classifyCityCalendar(row: StoredRow): RowFinding {
  const base = {
    occurrenceId: row.occurrenceId,
    activityName: row.activityName,
    lastCheckedAt: row.lastCheckedAt,
    storedClaim: describeStored(row),
    derivedClaim: '',
  };
  if (row.ageNotes !== 'all-ages') {
    return { ...base, verdict: 'not_applicable', reason: 'citycalendar:stored-wording-was-not-a-catch-all', derivedClaim: 'n/a' };
  }
  if (!cityCalendarAdapter) {
    return { ...base, verdict: 'ambiguous', reason: 'citycalendar:adapter-config-unavailable', derivedClaim: 'n/a' };
  }
  // extract() drops any event without BOTH a title and a startDateTime, so the synthetic record
  // must carry a date even though nothing in the age path reads it.
  const [record] = cityCalendarAdapter.extract([
    {
      eventID: 1,
      title: row.activityName,
      startDateTime: '2026-08-31T10:00:00',
      startTimeZoneOffset: '-0700',
      customFields: [{ label: 'Audiences', value: 'All ages' }],
    },
  ] as never);
  const derivedAgeText = record?.ageText;
  base.derivedClaim = derivedAgeText === undefined ? 'suppressed (no claim)' : JSON.stringify(derivedAgeText);
  if (derivedAgeText === undefined && hasPositiveClaim(row)) {
    return { ...base, verdict: 'ambiguous', reason: 'citycalendar:candidate-adult-subject-suppression-description-unknown' };
  }
  return { ...base, verdict: 'not_applicable', reason: 'citycalendar:title-alone-does-not-trigger-suppression' };
}

// ── class 8 — Library title-anchored age (e277d5c) ───────────────────────────────────────
//
// The bug was literal title-blindness: tier 1 read `descriptionText` only, so an age stated in
// the TITLE was never seen. The fix widens the haystack to `title + ". " + description` and adds
// an anchored bare-range pattern over it.
//
// This is the one class where a title-only re-derivation is not merely a candidate but PROVABLE
// for its positive half, and the reason is a dominance property rather than an assumption:
// AGE_RANGE_RE is non-global (so `match` returns the LEFTMOST hit), the title is the PREFIX of
// the haystack, and the pattern is terminated by `.` while ageHaystack joins with ". ". A
// title-internal hit is therefore byte-identical whether the description is present or empty —
// so if the title matches, `resolveBiblioCommonsAgeSignal(title, '', [])` returns exactly what
// the real parser returns on the full record.
//
// The direction that is NOT provable is the negative one: a title with no age wording may still
// gain a claim from description prose under the new anchored pattern. That is a self-heal, not a
// §3h stale row, so it cannot inflate the backfill — it is reported as unmeasurable and set aside.
export function classifyLibraryTitleAge(row: StoredRow): RowFinding {
  const derived = resolveBiblioCommonsAgeSignal(row.activityName, '', []).ages;
  const base = {
    occurrenceId: row.occurrenceId,
    activityName: row.activityName,
    lastCheckedAt: row.lastCheckedAt,
    storedClaim: describeStored(row),
    derivedClaim: derived ? JSON.stringify(derived) : 'title states no age',
  };
  if (derived === undefined) {
    // The title says nothing about age, so this fix cannot change the row from the title side.
    // It never WITHDRAWS a claim — it only adds one — so a title-silent row is not §3h-stale.
    return { ...base, verdict: 'not_applicable', reason: 'library:title-states-no-age' };
  }
  const parse = parseAgeText(derived);
  if (!row.hasAgeRow) return { ...base, verdict: 'self_heals', reason: 'library:title-age-would-create-row' };
  if (sameBounds(row, parse)) return { ...base, verdict: 'agrees', reason: 'library:bounds-already-match' };
  return { ...base, verdict: 'self_heals', reason: 'library:title-age-overwrites-on-reingest' };
}
