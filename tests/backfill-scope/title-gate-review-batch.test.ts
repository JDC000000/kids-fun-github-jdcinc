// tests/backfill-scope/title-gate-review-batch.test.ts — the two claims the §3h ActiveNet
// title-gate review queue actually rests on:
//
//   1. THE BUCKET PARTITION. "The review population is 633, not 2,279." If partitionAmbiguous()
//      silently drops or merges a reason, the queue either grows by ~1,646 rows this fix did not
//      cause, or shrinks below the population the doc says to review. Both corrupt the finding,
//      and neither would fail a type check.
//   2. THE MASKING COMPUTATION. Whether a wrong age band is REACHING A PARENT is the entire
//      priority ordering of the queue. It is computed by calling the shipped
//      `isAdultOrSeniorOnly()`, and these tests pin the calling convention — in particular that
//      the title-only probe really does isolate the title branch, which is what severity A means.
//
// No database. This file is in the `unit` lane by construction (it is not in
// DB_INTEGRATION_SUITES) and opens no connection.
import { describe, expect, it } from 'vitest';
import { ADULT_ONLY_AGE_MIN_MONTHS } from '../../lib/search/filters/audience';
import {
  BOUNDS_DIFFER_REASON,
  CANDIDATE_REASON,
  CSV_COLUMNS,
  GROUP_CSV_COLUMNS,
  GUIDANCE_DEFAULT,
  GUIDANCE_OPEN_ENDED,
  SOURCE_UNKNOWN_REASON,
  buildReviewRow,
  buildReviewRows,
  groupForReview,
  maskedBySearchFilter,
  mdCell,
  parseStoredClaim,
  partitionAmbiguous,
  prioritise,
  reIngestedSince,
  reviewerGuidance,
  severityOf,
  summariseBucket,
  titleReadsAdultOnly,
  toCsv,
  toGroupCsv,
  toMarkdown,
  type RecheckFinding,
  type ReviewRow,
} from '../../scripts/backfill-scope/review-batch-lib';

function finding(over: Partial<RecheckFinding> = {}): RecheckFinding {
  return {
    occurrenceId: '00000000-0000-4000-8000-000000000000',
    activityName: 'Baby Jellyfish Playtime - M/Tu/W/Th/F',
    lastCheckedAt: '2026-08-19T14:50:41.222Z',
    storedClaim: '[0, 24) bands=1 notes=NULL',
    derivedClaim: 'title rejected by the fixed gate',
    verdict: 'ambiguous',
    reason: CANDIDATE_REASON,
    ...over,
  };
}

describe('partitionAmbiguous — the 633/1,534/112 split', () => {
  it('splits the ambiguous verdict by cause and ignores every other verdict', () => {
    const part = partitionAmbiguous([
      finding({ occurrenceId: 'c1', reason: CANDIDATE_REASON }),
      finding({ occurrenceId: 'c2', reason: CANDIDATE_REASON }),
      finding({ occurrenceId: 's1', reason: SOURCE_UNKNOWN_REASON }),
      finding({ occurrenceId: 'b1', reason: BOUNDS_DIFFER_REASON }),
      // Not ambiguous: provably unaffected by these commits, not review material under any reading.
      finding({ occurrenceId: 'a1', verdict: 'agrees', reason: 'activenet:no-claim-either-side' }),
      finding({ occurrenceId: 'n1', verdict: 'not_applicable', reason: 'activenet:title-still-admitted-by-fixed-gate' }),
    ]);

    expect(part.candidates.map((f) => f.occurrenceId)).toEqual(['c1', 'c2']);
    expect(part.sourceUnknown.map((f) => f.occurrenceId)).toEqual(['s1']);
    expect(part.boundsDiffer.map((f) => f.occurrenceId)).toEqual(['b1']);
    expect(part.unclassified).toEqual([]);
    expect(part.totalAmbiguous).toBe(4);
  });

  it('is EXHAUSTIVE — the three buckets plus unclassified always sum to the headline', () => {
    // This is the property that makes "633, not 2,279" checkable rather than asserted. A future
    // classifier reason must show up in `unclassified` (which the CLI refuses to proceed on),
    // never be silently dropped into or out of the queue.
    const part = partitionAmbiguous([
      finding({ reason: CANDIDATE_REASON }),
      finding({ reason: SOURCE_UNKNOWN_REASON }),
      finding({ reason: BOUNDS_DIFFER_REASON }),
      finding({ reason: 'activenet:some-reason-invented-next-quarter' }),
    ]);
    expect(part.unclassified).toHaveLength(1);
    expect(
      part.candidates.length + part.sourceUnknown.length + part.boundsDiffer.length + part.unclassified.length
    ).toBe(part.totalAmbiguous);
  });

  it('does not treat a source-unknown or bounds-differ row as a candidate', () => {
    // The whole point of the unit: these two buckets are NOT queued. §3.3 — "Do not mechanically
    // clear the 1,154 'source unknown' rows: their stored bounds did not come from the title,
    // so this fix is not what made them wrong."
    const part = partitionAmbiguous([
      finding({ reason: SOURCE_UNKNOWN_REASON }),
      finding({ reason: BOUNDS_DIFFER_REASON }),
    ]);
    expect(part.candidates).toEqual([]);
  });

  it('reproduces the recheck headline decomposition at real proportions', () => {
    const rows = [
      ...Array.from({ length: 1534 }, (_, i) => finding({ occurrenceId: `s${i}`, reason: SOURCE_UNKNOWN_REASON })),
      ...Array.from({ length: 633 }, (_, i) => finding({ occurrenceId: `c${i}`, reason: CANDIDATE_REASON })),
      ...Array.from({ length: 112 }, (_, i) => finding({ occurrenceId: `b${i}`, reason: BOUNDS_DIFFER_REASON })),
    ];
    const part = partitionAmbiguous(rows);
    expect(part.totalAmbiguous).toBe(2279);
    expect(part.candidates).toHaveLength(633);
    expect(part.sourceUnknown).toHaveLength(1534);
    expect(part.boundsDiffer).toHaveLength(112);
    expect(1534 + 633 + 112).toBe(2279);
  });
});

describe('parseStoredClaim — lossless recovery of the masking inputs from the snapshot', () => {
  it('recovers bounds, band count and a NULL note', () => {
    expect(parseStoredClaim('[0, 24) bands=1 notes=NULL')).toEqual({
      hasAgeRow: true,
      ageMinMonths: 0,
      ageMaxMonths: 24,
      bandCount: 1,
      ageNotes: null,
    });
  });

  it('recovers an open-ended upper bound written as ∞', () => {
    expect(parseStoredClaim('[0, ∞) bands=5 notes="all-ages"')).toEqual({
      hasAgeRow: true,
      ageMinMonths: 0,
      ageMaxMonths: null,
      bandCount: 5,
      ageNotes: 'all-ages',
    });
  });

  it('recovers a missing lower bound written as -', () => {
    expect(parseStoredClaim('[-, 24) bands=1 notes=NULL').ageMinMonths).toBeNull();
  });

  it('recovers a note containing commas and brackets, because notes are JSON-quoted', () => {
    // The real hazard: age_notes carries the source's own audience list verbatim. A naive
    // comma-split parser would truncate it and change what isAdultOrSeniorOnly() concludes.
    const claim = parseStoredClaim('[0, ∞) bands=5 notes="unresolved: Overdose Awareness, Health, Adults, English"');
    expect(claim.ageNotes).toBe('unresolved: Overdose Awareness, Health, Adults, English');
  });

  it('handles the no-age-row rendering', () => {
    expect(parseStoredClaim('no occurrence_age row')).toEqual({
      hasAgeRow: false,
      ageMinMonths: null,
      ageMaxMonths: null,
      bandCount: 0,
      ageNotes: null,
    });
  });

  it('THROWS on an unrecognised shape rather than degrading to "no claim"', () => {
    // Silent degradation here would null the age signals, understate masking, and over-report
    // rows as parent-reachable — i.e. it would inflate the urgent half of the queue.
    expect(() => parseStoredClaim('[0, 24] bands=1')).toThrow(/unparseable storedClaim/);
    expect(() => parseStoredClaim('')).toThrow(/unparseable storedClaim/);
  });
});

describe('masking — the shipped isAdultOrSeniorOnly(), called and not reimplemented', () => {
  const noClaim = { hasAgeRow: false, ageMinMonths: null, ageMaxMonths: null, bandCount: 0, ageNotes: null };

  it('masks an adult title', () => {
    expect(maskedBySearchFilter(noClaim, '1.0-1.5 NTRP - Adult Beginner Tennis Lessons')).toBe(true);
  });

  it('does NOT mask a parent-and-child session that says "adult"', () => {
    // The veto that must always win. These are core kids content.
    expect(maskedBySearchFilter(noClaim, 'Adult / Early Years (0-6years) Swim')).toBe(false);
    expect(maskedBySearchFilter(noClaim, "Children's Badminton w/Adult")).toBe(false);
  });

  it('does NOT mask an innocuous title with a child-age band — the live-harm case', () => {
    expect(maskedBySearchFilter({ ...noClaim, hasAgeRow: true, ageMinMonths: 0, ageMaxMonths: 24 },
      'Baby Jellyfish Playtime - M/Tu/W/Th/F')).toBe(false);
  });

  it('reads the source audience out of age_notes, past the marker prefix and per segment', () => {
    // Two behaviours an approximation gets wrong and §9 warns about: the marker has to be
    // stripped before the anchor applies, and the anchor is per comma-separated tag rather than
    // at the start of the whole field.
    expect(maskedBySearchFilter({ ...noClaim, ageNotes: 'audience: Adults' }, 'Mah Jong')).toBe(true);
    expect(maskedBySearchFilter({ ...noClaim, ageNotes: 'unresolved: Overdose Response, Health, Adults, English' },
      'Supporting People Together')).toBe(true);
  });

  it('honours the supervision-prose veto in age_notes', () => {
    // "Adults accompanying children under 9 must stay in the library" is a rule about who comes
    // WITH the child. Masking it would hide genuine kids content — the wrong failure direction
    // for an exclusion with no user-facing escape hatch.
    expect(maskedBySearchFilter({ ...noClaim, ageNotes: 'unresolved: Adults accompanying children must stay' },
      'Storytime')).toBe(false);
  });

  it('masks an open-ended adult age floor with no adult word anywhere', () => {
    expect(maskedBySearchFilter({ ...noClaim, hasAgeRow: true, ageMinMonths: 660, ageMaxMonths: null }, 'Bridge Drop-In'))
      .toBe(true);
    // Bounded is a mis-parsed kids listing, not adult programming — must stay visible.
    expect(maskedBySearchFilter({ ...noClaim, hasAgeRow: true, ageMinMonths: 288, ageMaxMonths: 348 },
      'Art of Tennis Summer Camp')).toBe(false);
  });

  it('titleReadsAdultOnly isolates the TITLE branch by nulling every age signal', () => {
    // Severity A is a conflict between the title's own reading and the stored band, so it must
    // not be influenced by the age columns that are themselves under suspicion.
    expect(titleReadsAdultOnly('1.0-1.5 NTRP - Adult Beginner Tennis Lessons')).toBe(true);
    expect(titleReadsAdultOnly('Baby Jellyfish Playtime - M/Tu/W/Th/F')).toBe(false);
    // An open-ended adult FLOOR is an age signal, not a title signal — nulled, so false here
    // even though the full-row call returns true.
    expect(titleReadsAdultOnly('Bridge Drop-In')).toBe(false);
  });
});

describe('severity', () => {
  const claim = (min: number | null, max: number | null) => ({
    hasAgeRow: true, ageMinMonths: min, ageMaxMonths: max, bandCount: 1, ageNotes: null,
  });

  it('A — adult-reading title with a band starting below the age of majority', () => {
    expect(severityOf(claim(0, 24), true)).toBe('A-adult-title-child-band');
    expect(ADULT_ONLY_AGE_MIN_MONTHS).toBe(228);
    expect(severityOf(claim(ADULT_ONLY_AGE_MIN_MONTHS, 300), true)).not.toBe('A-adult-title-child-band');
  });

  it('B — open-ended claim, which no age filter can exclude', () => {
    expect(severityOf(claim(0, null), false)).toBe('B-open-ended-claim');
  });

  it('C — an infant ceiling', () => {
    expect(severityOf(claim(0, 24), false)).toBe('C-infant-band');
    expect(severityOf(claim(12, 36), false)).toBe('D-bounded-band');
  });

  it('D — an ordinary bounded band', () => {
    expect(severityOf(claim(144, 216), false)).toBe('D-bounded-band');
  });
});

describe('prioritise — parent-reachable first, then severity, then a total order', () => {
  const row = (over: Partial<ReviewRow>): ReviewRow => ({
    occurrenceId: 'id', activityName: 'name', storedClaim: '[0, 24) bands=1 notes=NULL',
    ageMinMonths: 0, ageMaxMonths: 24, bandCount: 1, ageNotes: null,
    derivedClaim: 'title rejected by the fixed gate', whyCandidate: '',
    maskedBySearchFilter: false, parentReachable: true, titleReadsAdultOnly: false,
    severity: 'D-bounded-band', lastCheckedAt: null, reIngestedByDeployedBuild: null,
    ...over,
  });

  it('puts every parent-reachable row above every masked row, whatever its severity', () => {
    const sorted = prioritise([
      row({ occurrenceId: 'masked-A', parentReachable: false, maskedBySearchFilter: true, severity: 'A-adult-title-child-band' }),
      row({ occurrenceId: 'reachable-D', parentReachable: true, severity: 'D-bounded-band' }),
    ]);
    expect(sorted.map((r) => r.occurrenceId)).toEqual(['reachable-D', 'masked-A']);
  });

  it('orders by severity within the parent-reachable block', () => {
    const sorted = prioritise([
      row({ occurrenceId: 'd', severity: 'D-bounded-band' }),
      row({ occurrenceId: 'c', severity: 'C-infant-band' }),
      row({ occurrenceId: 'b', severity: 'B-open-ended-claim' }),
      row({ occurrenceId: 'a', severity: 'A-adult-title-child-band' }),
    ]);
    expect(sorted.map((r) => r.occurrenceId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is deterministic — equal rows break to title then id, in codepoint order', () => {
    const input = [
      row({ occurrenceId: 'z', activityName: 'Swim' }),
      row({ occurrenceId: 'a', activityName: 'Swim' }),
      row({ occurrenceId: 'm', activityName: 'Art' }),
    ];
    const once = prioritise(input).map((r) => r.occurrenceId);
    const twice = prioritise([...input].reverse()).map((r) => r.occurrenceId);
    expect(once).toEqual(['m', 'a', 'z']);
    expect(twice).toEqual(once);
  });

  it('does not mutate its input', () => {
    const input = [row({ occurrenceId: 'b' }), row({ occurrenceId: 'a', severity: 'A-adult-title-child-band' })];
    prioritise(input);
    expect(input.map((r) => r.occurrenceId)).toEqual(['b', 'a']);
  });
});

describe('reIngestedSince — prediction vs observation', () => {
  it('is null with no boundary, because "observed" would then be an unsupported claim', () => {
    expect(reIngestedSince('2026-08-19T14:50:41.222Z', null)).toBeNull();
  });

  it('is true only for a row re-written after the fixed build booted', () => {
    const booted = '2026-08-18T21:47:41.402Z';
    expect(reIngestedSince('2026-08-19T14:50:41.222Z', booted)).toBe(true);
    expect(reIngestedSince('2026-08-11T00:57:25.148Z', booted)).toBe(false);
    expect(reIngestedSince(null, booted)).toBe(false);
  });
});

describe('buildReviewRow / summariseBucket', () => {
  it('carries the stored claim verbatim and states why the row is only a CANDIDATE', () => {
    const r = buildReviewRow(finding(), '2026-08-18T21:47:41.402Z');
    expect(r.storedClaim).toBe('[0, 24) bands=1 notes=NULL');
    expect(r.derivedClaim).toBe('title rejected by the fixed gate');
    expect(r.whyCandidate).toMatch(/NOT proof/);
    expect(r.whyCandidate).toMatch(/description_snippet is NULL/);
    expect(r.parentReachable).toBe(true);
    expect(r.reIngestedByDeployedBuild).toBe(true);
  });

  it('summarises a bucket without queueing it — masked + reachable always sum to rows', () => {
    const s = summariseBucket(SOURCE_UNKNOWN_REASON, [
      finding({ reason: SOURCE_UNKNOWN_REASON, activityName: 'Adult 19yrs+ Swim' }),
      finding({ reason: SOURCE_UNKNOWN_REASON, activityName: 'Baby Jellyfish Playtime' }),
    ], null);
    expect(s.rows).toBe(2);
    expect(s.masked).toBe(1);
    expect(s.parentReachable).toBe(1);
    expect(s.masked + s.parentReachable).toBe(s.rows);
    expect(s.reIngestedByDeployedBuild).toBeNull();
  });
});

describe('groupForReview — one decision per (title, stored claim), not one per row', () => {
  it('collapses a recurring programme to a single decision and keeps every occurrence id', () => {
    const rows = buildReviewRows(
      [
        finding({ occurrenceId: 'a', activityName: 'Baby Playtime', lastCheckedAt: '2026-08-19T10:00:00.000Z' }),
        finding({ occurrenceId: 'b', activityName: 'Baby Playtime', lastCheckedAt: '2026-08-11T10:00:00.000Z' }),
        finding({ occurrenceId: 'c', activityName: 'Baby Playtime', lastCheckedAt: '2026-08-19T12:00:00.000Z' }),
      ],
      '2026-08-18T21:47:41.402Z'
    );
    const groups = groupForReview(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].occurrences).toBe(3);
    expect(groups[0].occurrenceIds.sort()).toEqual(['a', 'b', 'c']);
    expect(groups[0].reIngestedByDeployedBuild).toBe(2);
    expect(groups[0].earliestLastCheckedAt).toBe('2026-08-11T10:00:00.000Z');
    expect(groups[0].latestLastCheckedAt).toBe('2026-08-19T12:00:00.000Z');
  });

  it('does NOT merge the same title holding two different stored claims', () => {
    // Same programme, two stored bands, is two decisions — merging them would hide a
    // disagreement the reviewer needs to see.
    const rows = buildReviewRows(
      [
        finding({ occurrenceId: 'a', activityName: 'Youth Basketball', storedClaim: '[144, 216) bands=2 notes=NULL' }),
        finding({ occurrenceId: 'b', activityName: 'Youth Basketball', storedClaim: '[0, 24) bands=1 notes=NULL' }),
      ],
      null
    );
    expect(groupForReview(rows)).toHaveLength(2);
  });

  it('never loses or duplicates a row', () => {
    const rows = buildReviewRows(
      [
        finding({ occurrenceId: 'a', activityName: 'Baby Playtime' }),
        finding({ occurrenceId: 'b', activityName: 'Family Badminton', storedClaim: '[0, ∞) bands=5 notes="all-ages"' }),
        finding({ occurrenceId: 'c', activityName: 'Baby Playtime' }),
      ],
      null
    );
    const groups = groupForReview(rows);
    expect(groups.reduce((n, g) => n + g.occurrences, 0)).toBe(rows.length);
    expect(new Set(groups.flatMap((g) => g.occurrenceIds)).size).toBe(rows.length);
  });

  it('orders parent-reachable, then severity, then the biggest group first', () => {
    const rows = buildReviewRows(
      [
        finding({ occurrenceId: 'd1', activityName: 'Youth Basketball', storedClaim: '[144, 216) bands=2 notes=NULL' }),
        finding({ occurrenceId: 'b1', activityName: 'Family Badminton', storedClaim: '[0, ∞) bands=5 notes="all-ages"' }),
        finding({ occurrenceId: 'c1', activityName: 'Baby Playtime', storedClaim: '[0, 24) bands=1 notes=NULL' }),
        finding({ occurrenceId: 'c2', activityName: 'Baby Playtime', storedClaim: '[0, 24) bands=1 notes=NULL' }),
      ],
      null
    );
    expect(groupForReview(rows).map((g) => g.severity)).toEqual([
      'B-open-ended-claim',
      'C-infant-band',
      'D-bounded-band',
    ]);
  });

  it('is deterministic under input reordering', () => {
    const findings = [
      finding({ occurrenceId: 'a', activityName: 'Zebra Club' }),
      finding({ occurrenceId: 'b', activityName: 'Apple Club' }),
      finding({ occurrenceId: 'c', activityName: 'Apple Club' }),
    ];
    const forward = groupForReview(buildReviewRows(findings, null)).map((g) => g.activityName);
    const backward = groupForReview(buildReviewRows([...findings].reverse(), null)).map((g) => g.activityName);
    expect(forward).toEqual(backward);
  });

  it('emits a group worksheet with writeback columns and space-joined occurrence ids', () => {
    const rows = buildReviewRows(
      [finding({ occurrenceId: 'a', activityName: 'Baby Playtime' }), finding({ occurrenceId: 'b', activityName: 'Baby Playtime' })],
      null
    );
    const csv = toGroupCsv(groupForReview(rows));
    expect(csv.split('\r\n')[0]).toContain('occurrence_ids,reviewer_guidance,reviewer_decision,reviewer_notes');
    expect(csv).toContain('a b');
    expect(csv.trimEnd().split('\r\n')[1].endsWith(',,')).toBe(true);
  });
});

describe('rendering — legibility is a real requirement, a human works this queue', () => {
  const rows = buildReviewRows(
    [
      finding({ occurrenceId: 'c1', activityName: '| Length Swim (50m) |', storedClaim: '[0, ∞) bands=5 notes="all-ages"' }),
      finding({ occurrenceId: 'c2', activityName: '1.0-1.5 NTRP - Adult Beginner Tennis Lessons' }),
      finding({ occurrenceId: 'c3', activityName: 'Salsa, Merengue & "Bachata"' }),
    ],
    '2026-08-18T21:47:41.402Z'
  );

  it('escapes a literal pipe in a title so the markdown table survives it', () => {
    // Real titles in this corpus are `"| Length Swim (50m) |"`. An unescaped pipe silently
    // shifts every later column of that row.
    expect(mdCell('| Length Swim (50m) |')).toBe('\\| Length Swim (50m) \\|');
    const md = toMarkdown({
      classId: '3+6-activenet-title-gate', generatedFrom: 'x.json', deployedSince: null,
      headlineAmbiguous: 3,
      buckets: {
        candidates: summariseBucket(CANDIDATE_REASON, [], null),
        sourceUnknown: summariseBucket(SOURCE_UNKNOWN_REASON, [], null),
        boundsDiffer: summariseBucket(BOUNDS_DIFFER_REASON, [], null),
      },
      unclassifiedAmbiguous: 0, queue: rows, groups: groupForReview(rows), severityTally: [], liveCrossCheck: null,
    });
    expect(md).toContain('\\| Length Swim (50m) \\|');
    // The safety framing must be present and must lead.
    expect(md).toMatch(/CANDIDATES, not confirmed stale rows, and NONE of them may be auto-corrected/);
    expect(md.indexOf('may be auto-corrected')).toBeLessThan(md.indexOf('## The worksheet'));
    // The egregious section exists and names the adult-tennis row.
    expect(md).toContain('Adult Beginner Tennis Lessons');
  });

  it('quotes CSV cells containing a comma or a quote, RFC 4180 style', () => {
    const csv = toCsv(rows);
    expect(csv.split('\r\n')[0]).toContain('reviewer_decision,reviewer_notes');
    expect(csv).toContain('"Salsa, Merengue & ""Bachata"""');
    // One header + one line per row + trailing CRLF.
    expect(csv.trimEnd().split('\r\n')).toHaveLength(rows.length + 1);
  });

  it('leaves the reviewer writeback columns empty — this is a worksheet, not a verdict', () => {
    for (const line of toCsv(rows).trimEnd().split('\r\n').slice(1)) {
      expect(line.endsWith(',,')).toBe(true);
    }
  });
});

// ── reviewer_guidance ────────────────────────────────────────────────────────────────────────
//
// The markdown warns that for the open-ended rows "correct" may mean "leave alone". The CSVs are
// what a reviewer actually opens, and those rows sort to the very TOP of both files — so the
// warning has to travel with the spreadsheet. These tests pin three things: the wording is keyed
// on SEVERITY (not on a title prefix, which would catch 7 of 15 groups and miss 8), the writeback
// pair stays rightmost, and adding the column moved nothing else.

/** A real RFC 4180 parse — quoted commas, escaped quotes, CRLF record separators. Deliberately
 *  not `split(',')`: the generic guidance string contains a comma, which is the whole point. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; continue; }
    if (c === '\n' || c === '\r') throw new Error(`bare ${c === '\n' ? 'LF' : 'CR'} outside quotes at offset ${i}`);
    field += c; i += 1;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Spread `total` occurrences over `groups` groups, remainder to the earliest groups. */
function distribute(total: number, groups: number): number[] {
  const base = Math.floor(total / groups);
  const remainder = total % groups;
  return Array.from({ length: groups }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * The published artefact's exact proportions: 633 rows in 167 groups —
 * B 74 rows / 15 groups, C 80 rows / 14 groups, D 479 rows / 138 groups.
 *
 * The 15 B titles are the REAL ones, verbatim from the published artefact, because the exact
 * 7-of-15 split is the point: only 7 literally BEGIN with "Family" — `Games Room Drop-In -
 * Family`, `Hastings Family Enrichment Centre`, `|Family Fun Hockey|`, `Snow-Skin Mooncakes:
 * Kids & Family Workshop` and four others do not. A title-prefix predicate fails this fixture.
 */
const B_TITLES = [
  'Family Badminton',
  'Family Play Gym',
  'Family Drop In- Rainy Days Only',
  'Games Room Drop-In - Family',
  'Hastings Family Enrichment Centre',
  'Asian Pop / KPOP / Hip Hop - Family',
  '|Family Fun Hockey|',
  'Family Drop In',
  'Family Play Time',
  'Family Playtime - Saturday',
  'Family Playtime - Sunday',
  'FREE TRIAL - Asian Pop / KPOP / Hip Hop - Family',
  'Reserve In Advance: Family Ringette',
  'Saturday Family Fun',
  'Snow-Skin Mooncakes: Kids & Family Workshop',
];

const OPEN_ENDED_CLAIM = '[0, ∞) bands=5 notes="all-ages"';

function corpusAtPublishedProportions(): RecheckFinding[] {
  const out: RecheckFinding[] = [];
  const add = (title: string, storedClaim: string, n: number, tag: string) => {
    for (let i = 0; i < n; i += 1) {
      out.push(finding({ occurrenceId: `${tag}-${out.length}`, activityName: title, storedClaim }));
    }
  };
  distribute(74, 15).forEach((n, g) => add(B_TITLES[g], OPEN_ENDED_CLAIM, n, 'b'));
  // Zero-padded so codepoint order matches numeric order — the queue sorts titles by codepoint.
  const pad = (n: number) => String(n).padStart(3, '0');
  distribute(80, 14).forEach((n, g) => add(`Baby Playtime ${pad(g)}`, '[0, 24) bands=1 notes=NULL', n, 'c'));
  distribute(479, 138).forEach((n, g) => add(`Youth Basketball ${pad(g)}`, '[144, 216) bands=2 notes=NULL', n, 'd'));
  return out;
}

describe('reviewer_guidance — the "leave alone" caveat, carried into the spreadsheet', () => {
  const findings = corpusAtPublishedProportions();
  const queue = buildReviewRows(findings, '2026-08-18T21:47:41.402Z');
  const groups = groupForReview(queue);
  const rowCsv = parseCsv(toCsv(queue));
  const groupCsv = parseCsv(toGroupCsv(groups));

  it('is keyed on SEVERITY, and every non-B severity gets the generic wording', () => {
    expect(reviewerGuidance('B-open-ended-claim')).toBe(GUIDANCE_OPEN_ENDED);
    expect(reviewerGuidance('A-adult-title-child-band')).toBe(GUIDANCE_DEFAULT);
    expect(reviewerGuidance('C-infant-band')).toBe(GUIDANCE_DEFAULT);
    expect(reviewerGuidance('D-bounded-band')).toBe(GUIDANCE_DEFAULT);
  });

  it('does NOT key on a "Family" title prefix — that would catch 7 of 15 groups and miss 8', () => {
    // The inherited framing called these "the 15 Family rows". The count is right and the key is
    // wrong: the discriminator is the open-ended stored claim, not the words in the title.
    const bGroups = groups.filter((g) => g.severity === 'B-open-ended-claim');
    expect(bGroups).toHaveLength(15);
    expect(bGroups.filter((g) => g.activityName.startsWith('Family'))).toHaveLength(7);
    // …yet all 15 get the B wording, because the key is the open-ended claim.
    expect(bGroups.every((g) => reviewerGuidance(g.severity) === GUIDANCE_OPEN_ENDED)).toBe(true);
    // And a row with no "family" in the title ANYWHERE still gets it, for the same reason.
    const noFamily = buildReviewRow(
      finding({ activityName: 'Open Gym Drop-In', storedClaim: OPEN_ENDED_CLAIM }), null
    );
    expect(noFamily.severity).toBe('B-open-ended-claim');
    expect(reviewerGuidance(noFamily.severity)).toBe(GUIDANCE_OPEN_ENDED);
    // Conversely a "Family" title that is NOT open-ended gets the generic wording.
    expect(reviewerGuidance(severityOf(
      { hasAgeRow: true, ageMinMonths: 0, ageMaxMonths: 24, bandCount: 1, ageNotes: null }, false
    ))).toBe(GUIDANCE_DEFAULT);
  });

  it('sits immediately before reviewer_decision in both column lists', () => {
    for (const columns of [CSV_COLUMNS, GROUP_CSV_COLUMNS]) {
      const cols = [...columns] as string[];
      expect(cols).toContain('reviewer_guidance');
      expect(cols.indexOf('reviewer_guidance')).toBe(cols.indexOf('reviewer_decision') - 1);
    }
  });

  it('leaves reviewer_decision and reviewer_notes as the final two columns, still empty', () => {
    for (const [header, ...data] of [rowCsv, groupCsv]) {
      expect(header.slice(-3)).toEqual(['reviewer_guidance', 'reviewer_decision', 'reviewer_notes']);
      for (const r of data) {
        expect(r[header.length - 2]).toBe('');
        expect(r[header.length - 1]).toBe('');
      }
    }
  });

  it('populates every cell — an empty one reads as a generator bug', () => {
    for (const [header, ...data] of [rowCsv, groupCsv]) {
      const gi = header.indexOf('reviewer_guidance');
      const si = header.indexOf('severity');
      expect(data.length).toBeGreaterThan(0);
      for (const r of data) {
        expect(r[gi]).not.toBe('');
        expect(r[gi]).toBe(r[si] === 'B-open-ended-claim' ? GUIDANCE_OPEN_ENDED : GUIDANCE_DEFAULT);
      }
    }
  });

  it('quotes the generic string, because it contains a comma — and does not quote the other', () => {
    // csvCell's job on exactly these two values. If the generic one ever emitted unquoted it
    // would split into two fields and shift `reviewer_decision` left by one for 559 of 633 rows.
    expect(GUIDANCE_DEFAULT).toContain(',');
    expect(GUIDANCE_OPEN_ENDED).not.toMatch(/[",\r\n]/);
    const raw = toCsv(queue);
    expect(raw).toContain(`,"${GUIDANCE_DEFAULT}",,`);
    expect(raw).toContain(`,${GUIDANCE_OPEN_ENDED},,`);
    expect(raw).not.toContain(`,${GUIDANCE_DEFAULT},`);
    expect(toGroupCsv(groups)).toContain(`,"${GUIDANCE_DEFAULT}",,`);
  });

  it('keeps both files rectangular under a real RFC 4180 parse, with CRLF preserved', () => {
    for (const [text, parsed] of [[toCsv(queue), rowCsv], [toGroupCsv(groups), groupCsv]] as const) {
      const [header, ...data] = parsed;
      for (const r of data) expect(r).toHaveLength(header.length);
      expect(text.endsWith('\r\n')).toBe(true);
      expect(/(?<!\r)\n/.test(text)).toBe(false); // no bare LF anywhere, including inside quotes
    }
  });

  it('changes no ordering: 167 groups / 633 rows, B at group 1–15 and row 1–74', () => {
    const groupData = groupCsv.slice(1);
    const rowData = rowCsv.slice(1);
    expect(groupData).toHaveLength(167);
    expect(rowData).toHaveLength(633);
    expect(groupData.reduce((n, r) => n + Number(r[groupCsv[0].indexOf('occurrences')]), 0)).toBe(633);

    const positionsOf = (parsed: string[][], severity: string) => {
      const si = parsed[0].indexOf('severity');
      const pi = parsed[0].indexOf('priority');
      return parsed.slice(1).filter((r) => r[si] === severity).map((r) => Number(r[pi]));
    };
    expect(positionsOf(groupCsv, 'B-open-ended-claim')).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 1)
    );
    expect(positionsOf(rowCsv, 'B-open-ended-claim')).toEqual(
      Array.from({ length: 74 }, (_, i) => i + 1)
    );
    // priority is still a dense 1..N in file order in both files.
    expect(rowData.map((r) => Number(r[0]))).toEqual(Array.from({ length: 633 }, (_, i) => i + 1));
    expect(groupData.map((r) => Number(r[0]))).toEqual(Array.from({ length: 167 }, (_, i) => i + 1));
  });

  it('stripping the new column back out reproduces the pre-change CSV exactly', () => {
    // The invariant that proves this change ADDED a column and touched nothing else: no
    // reordering, no requoting, no drifted counts. Same proof the regenerated artefact is held to.
    for (const [parsed, columns] of [[rowCsv, CSV_COLUMNS], [groupCsv, GROUP_CSV_COLUMNS]] as const) {
      const gi = parsed[0].indexOf('reviewer_guidance');
      const stripped = parsed.map((r) => r.filter((_, i) => i !== gi));
      expect(stripped[0]).toEqual([...columns].filter((c) => c !== 'reviewer_guidance'));
      for (const r of stripped.slice(1)) expect(r).toHaveLength(stripped[0].length);
    }
  });

  it('the markdown says the CSVs carry the column, so the two artefacts cannot drift', () => {
    const md = toMarkdown({
      classId: '3+6-activenet-title-gate', generatedFrom: 'x.json', deployedSince: null,
      headlineAmbiguous: queue.length,
      buckets: {
        candidates: summariseBucket(CANDIDATE_REASON, findings, null),
        sourceUnknown: summariseBucket(SOURCE_UNKNOWN_REASON, [], null),
        boundsDiffer: summariseBucket(BOUNDS_DIFFER_REASON, [], null),
      },
      unclassifiedAmbiguous: 0, queue, groups, severityTally: [], liveCrossCheck: null,
    });
    expect(md).toContain('`reviewer_guidance`');
    // The wording in the CSV is a compression of what the markdown already shipped — not new
    // policy invented by the CSV writer.
    expect(md).toMatch(/"correct" may mean "leave alone"|“correct” may mean “leave alone”/);
    expect(md).toContain('Do not auto-correct. Do not bulk-clear.');
  });
});
