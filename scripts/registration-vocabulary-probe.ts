// scripts/registration-vocabulary-probe.ts — READ-ONLY: what the registration heuristic says about
// the REAL catalogue, title by title.
//
// WHY THIS EXISTS. lib/search/filters/registration.ts opens with a promise: "Every rule below was
// audited against all 9,988 live staging occurrences before landing." That audit was a one-off,
// and the file has since been changed by hand more than once. On 2026-09-15 Jon rated four real
// Friday previews and two titles in them — "Olympic Style TaeKwonDo (11-16 yrs)" and "Little
// Ballerinas" — turned out to be multi-week registration programmes that the heuristic read as
// drop-in, because `registration_required` is NULL on both and neither title carries a word or a
// trailing level digit the regexes look for.
//
// Patching those two titles alone would be the wrong fix, and the file's own header says why:
// vocabulary is audited against the catalogue, not against the example that exposed it. This
// script is that audit, made repeatable — run it before and after any edit to the vocabulary and
// diff the two `--json` outputs to see EVERY title whose classification moved, not just the ones
// you were aiming at.
//
// ── WHAT MAKES IT TRUSTWORTHY ────────────────────────────────────────────────────────────────
// It imports the REAL predicates — `isRegistrationShaped`, `hasDropInSignal` and the SMS gate
// `isWeeklyPickEligible` — and never restates a pattern. A probe that mirrors the logic it
// measures cannot detect that logic changing; scripts/search-cap-probe.ts's header documents
// three separate reviews in this repo that each measured a different population than they claimed.
//
// ── THE INPUT IS AN EXPORT, NOT A CONNECTION ─────────────────────────────────────────────────
// It takes a TSV on stdin or `--titles <file>` rather than opening a database, so it needs no
// credentials, runs against a snapshot or a staging export identically, and the population it
// measured is a file a reviewer can read. Produce the export with:
//
//   psql "$DATABASE_URL" -At -F $'\t' -c "
//     SELECT ao.activity_name,
//            count(*)                                                        AS occurrences,
//            bool_or(ao.registration_required IS TRUE)                       AS any_reg_true,
//            bool_or(ao.registration_required IS FALSE)                      AS any_reg_false,
//            bool_or(ao.registration_required IS NULL)                       AS any_reg_null,
//            bool_or(s.recurrence_rule IS NOT NULL)                          AS any_rrule,
//            string_agg(DISTINCT coalesce(c.key,'(none)'), ',')              AS category_keys,
//            string_agg(DISTINCT src.name, ',')                              AS sources
//       FROM activity_occurrence ao
//       JOIN activity_series s   ON s.id  = ao.series_id
//       JOIN source src          ON src.id = s.source_id
//       LEFT JOIN category c     ON c.id  = ao.primary_category_id
//      GROUP BY 1 ORDER BY 1" > titles.tsv
//
// Usage:
//   bash scripts/registration-vocabulary-probe.sh --titles titles.tsv
//   bash scripts/registration-vocabulary-probe.sh --titles titles.tsv --json > after.json
//   bash scripts/registration-vocabulary-probe.sh --titles titles.tsv --grep 'taekwondo|ballerina'
//
// NOTE ON `registrationRequired`. The probe classifies each title BOTH ways — once with the
// persisted flag as the catalogue actually holds it, and once with it forced to null. The second
// is what isolates the TITLE HEURISTIC, which is the only thing a vocabulary edit can move, and
// it is the column to diff when auditing a regex change.

import { readFileSync } from 'node:fs';
import { hasDropInSignal, isRegistrationShaped } from '../lib/search/filters/registration';
import { isMultiSessionCommitment } from '../lib/sms/registration';
import type { ListingRecord } from '../lib/search/types';

interface Row {
  activityName: string;
  occurrences: number;
  anyRegTrue: boolean;
  anyRegFalse: boolean;
  anyRegNull: boolean;
  anyRrule: boolean;
  categoryKeys: string;
  sources: string;
}

interface Verdict extends Row {
  /** Title heuristic ONLY — `registrationRequired` forced null. What a vocabulary edit moves. */
  titleRegistrationShaped: boolean;
  titleDropInSignal: boolean;
  /** The SMS weekly-picks gate on the title alone: would this be offered in a Friday text? */
  titleWeeklyPickEligible: boolean;
}

function parseBool(v: string): boolean {
  return v === 't' || v === 'true' || v === 'TRUE';
}

function parseRows(tsv: string): Row[] {
  const rows: Row[] = [];
  for (const line of tsv.split('\n')) {
    if (line.trim() === '') continue;
    const f = line.split('\t');
    if (f.length < 2) continue;
    rows.push({
      activityName: f[0],
      occurrences: Number(f[1]) || 0,
      anyRegTrue: parseBool(f[2] ?? ''),
      anyRegFalse: parseBool(f[3] ?? ''),
      anyRegNull: parseBool(f[4] ?? ''),
      anyRrule: parseBool(f[5] ?? ''),
      categoryKeys: f[6] ?? '',
      sources: f[7] ?? '',
    });
  }
  return rows;
}

/**
 * The minimal listing the two predicates read. Tags are empty because the export carries none —
 * so this measures the TITLE VOCABULARY in isolation, which is exactly what is under audit. A row
 * whose real `suitability_tags` carry `drop_in` is vetoed in production regardless of its title,
 * and that veto is not something a regex edit can take away.
 */
function asListing(row: Row, registrationRequired: boolean | null): ListingRecord {
  return {
    activityName: row.activityName,
    suitabilityTags: [],
    categoryTags: [],
    registrationRequired,
  } as unknown as ListingRecord;
}

function classify(row: Row): Verdict {
  const titleOnly = asListing(row, null);
  const titleRegistrationShaped = isRegistrationShaped(titleOnly);
  return {
    ...row,
    titleRegistrationShaped,
    titleDropInSignal: hasDropInSignal(titleOnly),
    titleWeeklyPickEligible: !isMultiSessionCommitment(titleOnly),
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const asJson = argv.includes('--json');
  const file = arg('--titles');
  const grep = arg('--grep');

  const tsv = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  let verdicts = parseRows(tsv).map(classify);
  if (grep) {
    const re = new RegExp(grep, 'i');
    verdicts = verdicts.filter((v) => re.test(v.activityName));
  }

  if (asJson) {
    // Sorted by title so two runs diff cleanly with `diff`, not just with a JSON differ.
    const sorted = [...verdicts].sort((a, b) => a.activityName.localeCompare(b.activityName));
    for (const v of sorted) {
      process.stdout.write(
        `${v.titleRegistrationShaped ? 'REG ' : 'open'}\t` +
          `${v.titleWeeklyPickEligible ? 'sms-eligible' : 'sms-excluded'}\t` +
          `${v.occurrences}\t${v.activityName}\n`
      );
    }
    return;
  }

  const titles = verdicts.length;
  const occurrences = verdicts.reduce((n, v) => n + v.occurrences, 0);
  const regTitles = verdicts.filter((v) => v.titleRegistrationShaped);
  const eligible = verdicts.filter((v) => v.titleWeeklyPickEligible);
  const pct = (n: number, d: number) => (d === 0 ? '0.0' : ((n / d) * 100).toFixed(1));

  console.log(`registration-vocabulary-probe — ${titles} distinct titles, ${occurrences} occurrences`);
  console.log('');
  console.log(`title reads as registration : ${regTitles.length} titles (${pct(regTitles.length, titles)}%), ` +
    `${regTitles.reduce((n, v) => n + v.occurrences, 0)} occurrences`);
  console.log(`weekly-pick eligible (title): ${eligible.length} titles (${pct(eligible.length, titles)}%), ` +
    `${eligible.reduce((n, v) => n + v.occurrences, 0)} occurrences`);
  console.log('');
  console.log('Rows the catalogue itself could answer but does not (registration_required IS NULL only):');
  const onlyNull = verdicts.filter((v) => v.anyRegNull && !v.anyRegTrue && !v.anyRegFalse);
  console.log(`  ${onlyNull.length} titles (${pct(onlyNull.length, titles)}%), ` +
    `${onlyNull.reduce((n, v) => n + v.occurrences, 0)} occurrences — these ride on the title alone.`);
}

main();
