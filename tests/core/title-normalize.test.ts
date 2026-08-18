// tests/core/title-normalize.test.ts — unit lane, no database.
//
// P1-3: worker/core/title.ts strips source packaging out of a listing title at ingest. Two
// obligations are tested here, and the second matters at least as much as the first:
//
//   1. the junk really goes (pipes/brackets, $-marked price, weekday+clock time), and
//   2. NOTHING ELSE DOES. A title is an activity's name, and the numbers inside one are
//      overwhelmingly not prices or times — they are ages ("8yrs+", "0-12 yrs"), program
//      levels ("Level 2", "Swim 3") and rec-centre skill ratings ("3.0+"). Every one of
//      those is read by a live consumer (worker/core/age.ts via the adapters,
//      lib/search/filters/registration.ts's PROGRAM_LEVEL heuristic), so a normaliser that
//      ate them would break working features to tidy a string.
import { describe, it, expect } from 'vitest';
import { normalizeTitle, withNormalizedTitle } from '../../worker/core/title';
import type { StructuredRecord } from '../../worker/core/adapter';
import { extractAgeText } from '../../worker/adapters/activenet/parse';
import { parseAgeText } from '../../worker/core/age';

describe('normalizeTitle — the junk this ticket is about', () => {
  // Left column: real wording observed on these sources (the `|Public Swim|` in the bug
  // report, and PerfectMind EventNames already used as fixtures in tests/adapters/*).
  const CASES: Array<[raw: string, expected: string]> = [
    ['|Public Swim|', 'Public Swim'],
    ['|Parent and Tot|', 'Parent and Tot'],
    ['[Open Gym]', 'Open Gym'],
    ['Public Swim | $3 | Thursday 3:30-5:00pm', 'Public Swim'],
    ['$3 Open Gym 8yrs+ Delbrook Thursday 3:30-5:00pm', 'Open Gym 8yrs+ Delbrook'],
    ['$3 Open Gym 8yrs+ Delbrook', 'Open Gym 8yrs+ Delbrook'],
    ['$3.00 Family Skate', 'Family Skate'],
    ['Family Skate $0.00 - $8.75', 'Family Skate'],
    ['Family Swim (Mon 3:00-4:00pm)', 'Family Swim'],
    ['Toddler Time 9:00 am - 10:00 am', 'Toddler Time'],
    ['Lane Swim Mondays & Wednesdays 6-7pm', 'Lane Swim'],
    ['Drop-in Basketball Tues/Thurs 7:00pm', 'Drop-in Basketball'],
    ['Preschool Play 10am', 'Preschool Play'],
    // worker/core/age.ts's own worked example. The clock goes; the word "Adult" — which is
    // the adult-signal audit rules' entire evidence for this listing — stays.
    ['Adult Swim 6:00-7:00pm', 'Adult Swim'],
  ];

  it.each(CASES)('normalises %j → %j', (raw, expected) => {
    expect(normalizeTitle(raw)).toBe(expected);
  });

  it('removes the delimiter characters but never the words between them', () => {
    // The pipe is the junk; "Public Swim" is the name. A rule that dropped bracketed
    // CONTENT would silently delete half the catalogue's titles.
    expect(normalizeTitle('Swim | Lessons')).toBe('Swim Lessons');
    expect(normalizeTitle('[Youth] Open Gym')).toBe('Youth Open Gym');
  });
});

describe('normalizeTitle — what it must not touch', () => {
  // These are not stylistic preferences. Each entry names the consumer that would break.
  const PRESERVED: Array<[title: string, why: string]> = [
    ['Open Gym 8yrs+', 'age wording — activenet extractAgeText / parseAgeText read it'],
    ['Play Palace - 0-12 yrs', 'age range; the digits are ages, not a clock'],
    ['Youth (13-18yrs) Open Gym', 'parenthesised age range'],
    ['Badminton All Ages', 'the literal "all ages" claim'],
    ['Swim Level 2', 'program level — registration.ts REGISTRATION_TITLE keys on (level|stage|star)\\s*\\d'],
    ['Skating Star 3', 'program level'],
    ['Gymnastics Session 4', 'session number'],
    ['Pickleball - 3.0+', 'rec-centre skill rating; age.ts has a whole decimal guard for these'],
    ['Grades K-7 Homework Club', 'grade range'],
    ['Swim 3', 'registration.ts PROGRAM_LEVEL reads exactly this shape'],
    ['Monday Funday', 'a bare weekday with no time is a real program NAME'],
    ['Saturday Club', 'ditto'],
    ['Sunday Skate', 'ditto'],
    ['Baby & Me 2:1 Ratio', 'not a clock time — a colon needs two following digits'],
    ['Cooking 101', 'a bare number is never a price'],
    ['March Break Camp', 'no weekday, no time, no currency marker'],
    // activity_name is the audit layer's `title` evidence field
    // (lib/audit/rules/adult-age-band.ts EVIDENCE_FIELDS). Its patterns key on words and on
    // &/and/+ separators, none of which this normaliser removes — asserted, not assumed.
    ['Adult & Child Swim', 'CAREGIVER_PROGRAMME_RE evidence — the & separator must survive'],
    ['Parent and Tot', 'CAREGIVER_PROGRAMME_RE evidence'],
    ['Board Games for Adults and Teens', 'mixed-audience evidence'],
    ['Prenatal Yoga 19+', 'adult-signal evidence; the "19+" is not a price or a clock'],
  ];

  it.each(PRESERVED)('leaves %j alone (%s)', (title) => {
    expect(normalizeTitle(title)).toBe(title);
  });

  it('never returns an empty title, even when every rule fires', () => {
    // activity_name is NOT NULL, and a blank card is worse than a noisy one. A title that
    // was ONLY packaging falls back to the trimmed original.
    expect(normalizeTitle('$3 Thursday 3:30-5:00pm')).toBe('$3 Thursday 3:30-5:00pm');
    expect(normalizeTitle('|||')).toBe('|||');
  });

  it('is idempotent — re-ingesting an already-clean title changes nothing', () => {
    const once = normalizeTitle('$3 Open Gym 8yrs+ Delbrook Thursday 3:30-5:00pm');
    expect(normalizeTitle(once)).toBe(once);
  });

  it('handles the empty/whitespace title without throwing', () => {
    expect(normalizeTitle('')).toBe('');
    expect(normalizeTitle('   ')).toBe('');
  });
});

describe('withNormalizedTitle — the raw wording survives', () => {
  const record = (title: string): StructuredRecord => ({
    sourceRecordId: 'rec-1',
    title,
    ageText: '$3 8yrs+ Thursday 3:30-5:00pm', // deliberately junk-shaped; must be untouched
    ageAudienceLabels: ['Toddlers', 'Preschool Age Children'],
    categoryHint: 'open_gym',
    sourceUrl: 'https://example.org/rec-1',
  });

  it('keeps the source wording in sourceTitle while title is cleaned', () => {
    const raw = '$3 Open Gym 8yrs+ Delbrook Thursday 3:30-5:00pm';
    const out = withNormalizedTitle(record(raw));
    expect(out.title).toBe('Open Gym 8yrs+ Delbrook');
    expect(out.sourceTitle).toBe(raw);
  });

  it('sets sourceTitle even when normalisation changed nothing', () => {
    // Unconditional on purpose — see migration 0032's null-semantics note. If this were
    // conditional, a null source_title would mean either "unchanged" or "pre-0032" and no
    // reader could tell which.
    const out = withNormalizedTitle(record('Open Gym'));
    expect(out.sourceTitle).toBe('Open Gym');
  });

  it('does not overwrite a sourceTitle an adapter already set', () => {
    const out = withNormalizedTitle({ ...record('|Public Swim|'), sourceTitle: 'adapter-supplied raw' });
    expect(out.title).toBe('Public Swim');
    expect(out.sourceTitle).toBe('adapter-supplied raw');
  });

  it('changes NOTHING on the record except title and sourceTitle', () => {
    // The scope assertion. age.ts's inputs (`ageText`, `ageAudienceLabels`) travel through
    // this hop byte-identical, which is what makes the sequenced age ticket independent of
    // this one.
    const before = record('|$3 Open Gym| Thursday 3:30-5:00pm');
    const after = withNormalizedTitle(before);
    for (const key of Object.keys(before) as Array<keyof StructuredRecord>) {
      if (key === 'title') continue;
      expect(after[key], `${key} must be untouched`).toEqual(before[key]);
    }
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), 'sourceTitle'].sort());
  });
});

describe('pipeline order — age extraction still reads the RAW title', () => {
  // worker/core/ingest.ts runs withNormalizedTitle AFTER adapter.extract(), and this is why
  // that ordering is a correctness constraint rather than a preference: activenet derives
  // `ageText` from the title inside extract(). Proven against the real extractor, not a
  // restatement of the rule.
  const event = {
    title: '$3 Youth (13-18yrs) Open Gym Thursday 3:30-5:00pm',
    description: '',
  };

  it('activenet still captures the whole raw title as its age claim', () => {
    const ageText = extractAgeText(event as Parameters<typeof extractAgeText>[0]);
    expect(ageText).toBe(event.title);
  });

  it('normalising afterwards leaves that captured ageText and its parse identical', () => {
    const ageText = extractAgeText(event as Parameters<typeof extractAgeText>[0]);
    const before = parseAgeText(ageText);

    const out = withNormalizedTitle({
      sourceRecordId: 'activenet-1',
      title: event.title,
      ageText,
      sourceUrl: 'https://example.org/activenet-1',
    });

    expect(out.title).toBe('Youth (13-18yrs) Open Gym');
    expect(out.ageText).toBe(ageText);
    expect(parseAgeText(out.ageText)).toEqual(before);
  });

  it('the age claim survives normalisation even if a future caller re-parsed the clean title', () => {
    // Belt-and-braces on the conservatism rule: the age range is still IN the normalised
    // title, so a consumer that reads the title rather than ageText resolves the same band.
    const normalized = normalizeTitle(event.title);
    expect(parseAgeText(normalized)).toEqual(parseAgeText(event.title));
  });
});
