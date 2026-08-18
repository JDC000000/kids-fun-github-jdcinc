// tests/llm/age-provenance.test.ts — the age fallback must not destroy the source's own age
// wording when it resolves a row.
//
// WHY THIS SUITE EXISTS. `occurrence_age.age_notes` is read by two very different consumers:
//   1. lib/search/filters/audience.ts — the adult/senior HARD exclusion. It treats this field as
//      the source's own stated audience ("…, Adults, English"), which for a whole family of
//      library rows is the ONLY adult signal that exists (no adult word in the title, no parsed
//      age at all).
//   2. app/preview/_components/ActivityDetail.tsx — "From the source: {ageNotes}", shown to a
//      parent as a quotation of the source.
// The apply branch used to overwrite the field with `llm-resolved: <the model's own reason>`,
// which broke both at once: the source's "Adults" was gone, so the hard exclusion stopped
// firing for exactly the rows the LLM had touched, and the detail page quoted model prose to a
// parent as if the source had written it.
//
// Everything below runs against the REAL filter (isAdultOrSeniorOnly), never a copy of its
// regexes — the point is that the stamped format survives that code, not that it survives a
// restatement of it.
import { describe, expect, it } from 'vitest';
import { stampAgeNotes } from '../../lib/llm/age-fallback';
import { isAdultOrSeniorOnly } from '../../lib/search/filters/audience';

/** A row with no title signal and no parsed age: `ageNotes` is the only evidence it carries. */
const noted = (activityName: string, ageNotes: string) => ({
  activityName,
  ageMinMonths: null,
  ageMaxMonths: null,
  ageNotes,
});

/** Raw wordings the deterministic parser leaves as `unresolved: <raw>` and the filter excludes. */
const ADULT_RAW_WORDINGS = [
  'Adults',
  'International Overdose Awareness Day, Health, Life Skills and Personal Growth, Adults, English',
  'Digital Essentials, Computer & Technology Training, Adults, Seniors, English',
  'Older Adults',
];

describe('stampAgeNotes — the source wording survives the stamp', () => {
  it('keeps the raw text first and verbatim, and marks the row as LLM-touched', () => {
    expect(stampAgeNotes('Adults', 'apply')).toBe('Adults (llm-resolved)');
    expect(stampAgeNotes('see poster for details', 'no_op')).toBe('see poster for details (llm-unresolved)');
  });

  it('leads with the source text, so ActivityDetail\'s "From the source:" really quotes the source', () => {
    // The UI renders this string raw. Leading with the source wording is what makes that line
    // honest; the old format led with (and contained only) the model's reasoning.
    for (const raw of ADULT_RAW_WORDINGS) {
      expect(stampAgeNotes(raw, 'apply').startsWith(raw)).toBe(true);
      expect(stampAgeNotes(raw, 'no_op').startsWith(raw)).toBe(true);
    }
  });

  it('truncates the RAW text, never the marker, so a stamped row stays identifiable', () => {
    const stamped = stampAgeNotes('x'.repeat(900), 'apply');
    expect(stamped.length).toBeLessThanOrEqual(500);
    expect(stamped.endsWith(' (llm-resolved)')).toBe(true);
  });

  it('degrades to the bare marker when the source said nothing at all', () => {
    expect(stampAgeNotes('   ', 'apply')).toBe('llm-resolved');
    expect(stampAgeNotes('', 'no_op')).toBe('llm-unresolved');
  });

  it('never leaves the row on the `unresolved:%` worklist it was just taken off', () => {
    for (const raw of [...ADULT_RAW_WORDINGS, 'ages unclear', '']) {
      expect(stampAgeNotes(raw, 'apply').startsWith('unresolved:')).toBe(false);
      expect(stampAgeNotes(raw, 'no_op').startsWith('unresolved:')).toBe(false);
    }
  });
});

describe('a stamped row is still read by the adult/senior hard exclusion', () => {
  it.each(ADULT_RAW_WORDINGS)('apply branch — source said %s → still excluded', (raw) => {
    // THE CENTRAL CASE. Before: `unresolved: Adults` → excluded. The LLM resolves the age →
    // the row must STILL be excluded, because the source's claim has not changed.
    expect(isAdultOrSeniorOnly(noted('Zero Waste Ambassador Program', `unresolved: ${raw}`))).toBe(true);
    expect(isAdultOrSeniorOnly(noted('Zero Waste Ambassador Program', stampAgeNotes(raw, 'apply')))).toBe(true);
  });

  it.each(ADULT_RAW_WORDINGS)('no_op branch — source said %s → still excluded', (raw) => {
    expect(isAdultOrSeniorOnly(noted('Zero Waste Ambassador Program', stampAgeNotes(raw, 'no_op')))).toBe(true);
  });

  it('holds even when the LLM writes a confidently WRONG kids age range onto the row', () => {
    // The bounds the model wrote are not a defence: audience wording is checked before the
    // structured-age signal, so a mis-resolved "Adults" row is still removed from a kids app.
    expect(
      isAdultOrSeniorOnly({
        activityName: 'Supporting People Together: The Basics of Overdose Response',
        ageMinMonths: 24,
        ageMaxMonths: 60,
        ageNotes: stampAgeNotes('International Overdose Awareness Day, Health, Adults, English', 'apply'),
      })
    ).toBe(true);
  });

  it('adds no false exclusions: an ordinary row stamped with the marker stays visible', () => {
    // The marker itself must not read as an audience tag, and must not split one.
    expect(isAdultOrSeniorOnly(noted('Act, Dance, Sing FUN! Camp', stampAgeNotes('Act, Dance, Sing FUN! Camp', 'apply')))).toBe(false);
    expect(isAdultOrSeniorOnly(noted('Storytime', stampAgeNotes('Storytimes, Preschool Age Children, Toddlers, English', 'apply')))).toBe(false);
    expect(isAdultOrSeniorOnly(noted('Family Movie Night', stampAgeNotes('Babies, Adults', 'apply')))).toBe(false);
    expect(isAdultOrSeniorOnly(noted('Story Time', stampAgeNotes('Adults accompanying children under 9 must stay in the library', 'apply')))).toBe(false);
  });
});

describe('the formats this one was chosen over (regression pins, not hypotheticals)', () => {
  const REASON = 'Source names an adult audience and gives no age range.';

  it('the old format — model reason replaces the source wording — is invisible to the filter', () => {
    // The bug, pinned. Nothing in this string starts a tag with adult wording, and
    // AGE_NOTES_MARKER does not step over `llm-resolved:`, so the exclusion silently stops.
    expect(isAdultOrSeniorOnly(noted('Zero Waste Ambassador Program', `llm-resolved: ${REASON}`))).toBe(false);
  });

  it('appending the raw text after the reason only works if the join is a tag SEPARATOR', () => {
    // Worth pinning because it is a genuinely sharp edge. `|` is in AUDIENCE_TAG_SEPARATOR, so
    // "…reason | Adults" does split into a leading "Adults" segment and IS detected — but any
    // join the source's tag grammar does not know about (an em dash, " / ", " — see source")
    // buries the tag mid-segment where the anchor can never see it. A provenance format whose
    // correctness turns on the punctuation between the two halves is a trap; leading with the
    // raw text removes the question.
    expect(isAdultOrSeniorOnly(noted('Zero Waste Ambassador Program', `llm-resolved: ${REASON} | Adults`))).toBe(true);
    expect(isAdultOrSeniorOnly(noted('Zero Waste Ambassador Program', `llm-resolved: ${REASON} — Adults`))).toBe(false);
    expect(isAdultOrSeniorOnly(noted('Zero Waste Ambassador Program', `llm-resolved: ${REASON} / Adults`))).toBe(false);
  });

  it('carrying the model\'s reason alongside the raw text re-opens the hole from the other side', () => {
    // Both vetoes are applied to the WHOLE field before any tag is read, so ordinary reasoning
    // prose flips the answer even with the source's tag leading the string. This is why the
    // reason stays on the llm_batch_decision audit row and out of age_notes.
    expect(isAdultOrSeniorOnly(noted('Zero Waste Ambassador Program', 'Adults (llm-resolved: no children\'s ages are given)'))).toBe(false);
    expect(isAdultOrSeniorOnly(noted('Zero Waste Ambassador Program', 'Adults (llm-resolved: participants must be 19+)'))).toBe(false);
  });
});
