// Adult/senior-only exclusion (lib/search/filters/audience.ts).
//
// This filter is a HARD exclusion with no user-facing escape hatch, so its whole risk profile is
// false positives: anything it gets wrong becomes unreachable. Every title below is a real one
// from the live staging catalogue, and the two halves of the suite carry the weight:
//   • "excludes" pins that the adult/senior programming a facility calendar drags in really goes.
//   • "keeps" pins the things that must survive — above all the parent-and-child sessions that
//     say "Adult" in the title, and the mis-parsed age data that would otherwise take real kids
//     content with it.

import { describe, expect, it } from 'vitest';
import { ADULT_ONLY_AGE_MIN_MONTHS, isAdultOrSeniorOnly } from '../../lib/search/filters/audience';

const listing = (activityName: string, ageMinMonths: number | null = null, ageMaxMonths: number | null = null) => ({
  activityName,
  ageMinMonths,
  ageMaxMonths,
});

/** A row carrying the source's own audience wording in `ageNotes` and nothing else to go on. */
const noted = (activityName: string, ageNotes: string) => ({
  activityName,
  ageMinMonths: null,
  ageMaxMonths: null,
  ageNotes,
});

describe('isAdultOrSeniorOnly — excludes adult/senior-only programming', () => {
  it.each([
    'Adult 19yrs+ Swim Karen Magnussen Sunday 8:00-9:00am',
    'Adult 19yr+ Hot Tub & Steam Karen Magnussen Wednesday 3:30-7:15pm',
    'Adult Swim 19yrs+ Delbrook Leisure Pool Monday 9:00-10:00pm',
    'Adult Open Gym (19+)',
    '|Adult Skate|',
    'Adult Tennis Camp - Beginner',
    'Reserve In Advance: Adult Basketball',
    'Reserve in Advance: Basketball Adult',
  ])('an explicit adult title: %s', (title) => {
    expect(isAdultOrSeniorOnly(listing(title))).toBe(true);
  });

  it.each([
    'Smart Device Workshop for Seniors',
    'Ballroom Standards Dance Class for Seniors',
    'Reserve In Advance:  Active Aging Yoga & Core',
  ])('an explicit senior title: %s', (title) => {
    expect(isAdultOrSeniorOnly(listing(title))).toBe(true);
  });

  it.each([
    'Reserve In Advance: Badminton 65+',
    'Badminton 55+ - Wed',
    'Public Swim 19yrs+ Ron Andrews Thursday 8:30-10:00pm',
  ])('an age marker at or above the age of majority: %s', (title) => {
    expect(isAdultOrSeniorOnly(listing(title))).toBe(true);
  });

  it('catches senior-centre programming whose title says nothing at all, via its open-ended age floor', () => {
    // No adult/senior word anywhere — the age column is the ONLY signal these carry.
    expect(isAdultOrSeniorOnly(listing('Mah Jong', 660))).toBe(true);
    expect(isAdultOrSeniorOnly(listing('Cardiac Coffee', 660))).toBe(true);
    expect(isAdultOrSeniorOnly(listing('Bridge Drop-In', 660))).toBe(true);
    expect(isAdultOrSeniorOnly(listing('Community Lunch Program', ADULT_ONLY_AGE_MIN_MONTHS))).toBe(true);
  });

  it('trusts the title even when the stored age contradicts it', () => {
    // Both are real rows whose age parse failed outright; without the title rule they would show
    // to parents as kids content.
    expect(isAdultOrSeniorOnly(listing('Adult 19yrs+ Swim Karen Magnussen Monday 8:00-9:00am', 0))).toBe(true);
    expect(isAdultOrSeniorOnly(listing('Lane Swim 19yrs+ Delbrook Wednesday 9:00-10:00pm', 96))).toBe(true);
  });
});

describe("isAdultOrSeniorOnly — reads the SOURCE's own stated audience (ageNotes)", () => {
  it('excludes the overdose-response talk that was returned to a search for ages 2-4', () => {
    // The reported severity-3 bug, verbatim from live production (f975a40): an adult harm-
    // reduction talk with no adult word in its title, no parsed age at all — and therefore no
    // age bands, which is what let it through matchesAge's "unknown → don't hide" rule — but
    // the library's own audience taxonomy says "Adults" and always did.
    expect(
      isAdultOrSeniorOnly(
        noted(
          'Supporting People Together: The Basics of Overdose Response',
          'unresolved: International Overdose Awareness Day, Health, Life Skills and Personal Growth, Adults, English'
        )
      )
    ).toBe(true);
  });

  it.each([
    ['Immigration Pathways to Canada: Express Entry & BC PNP', 'unresolved: BC Newcomer Services Program, Canadian Citizenship, Newcomer Programs, Adults, English'],
    ['ESL Conversation Practice', 'unresolved: ESL Conversation Practice, Meetups, Adults, ESL Learners, Newcomers, Seniors, English'],
    ['Tech Help', 'unresolved: Digital Essentials, Computer & Technology Training, Adults, Seniors, English'],
    ['Zero Waste Ambassador Program - Training Workshop', 'unresolved: Adults'],
  ])('an adult audience tag anywhere in the source\'s tag list: %s', (title, notes) => {
    expect(isAdultOrSeniorOnly(noted(title, notes))).toBe(true);
  });

  it('reads the same claim after a re-ingest rewrites the notes as a resolved audience', () => {
    // Today's rows were ingested before worker/core/age.ts's audience-tag path existed, so they
    // carry `unresolved: <raw>`. Re-ingesting the SAME rows rewrites them as `audience: <tags>`
    // (parseAudienceLabels). Both markers must be stepped over or this fix would silently stop
    // working the day the backfill lands.
    expect(isAdultOrSeniorOnly(noted('Tech Help', 'audience: Adults, Seniors'))).toBe(true);
    expect(isAdultOrSeniorOnly(noted('Digitization Orientation', 'audience: Adults'))).toBe(true);
  });

  it('does NOT exclude on supervision prose that merely mentions adults', () => {
    // The exact failure worker/core/age.ts:245-250 warns about. An unanchored /adults?/ over
    // this field hides genuine kids content, which is the worse direction for a hard exclusion.
    expect(
      isAdultOrSeniorOnly(noted('Story Time', 'Adults accompanying children under 9 must stay in the library'))
    ).toBe(false);
    // Real product data (app/preview/_data/fixtures.ts) — an "adult" that is a supervision ratio.
    expect(
      isAdultOrSeniorOnly(
        noted('Parent & Tot Swim Lesson', 'Swim Safe ratio: children under 6 must be within arm’s reach of an adult in the water.')
      )
    ).toBe(false);
    // Reworded so the parent-and-child veto alone would NOT catch it: the sentence SHAPE must.
    expect(isAdultOrSeniorOnly(noted('Drop-in Craft', 'Adults accompanying under-9s must remain on site'))).toBe(false);
  });

  it('does not exclude when the source names a child audience alongside the adult one', () => {
    expect(isAdultOrSeniorOnly(noted('Family Movie Night', 'audience: Babies, Adults'))).toBe(false);
    expect(isAdultOrSeniorOnly(noted('Drop-in Lego', 'unresolved: Adults, Preschool Age Children, English'))).toBe(false);
  });

  it.each([
    ['Toddler Time', 'audience: Toddlers'],
    ['Storytime', 'unresolved: Storytimes, Preschool Age Children, Toddlers, English'],
    ['Open Swim', 'all-ages'],
    // The ActiveNet families echo the TITLE back into age_notes; an unanchored match over that
    // would re-derive the title signal with none of the title rule's care.
    ['Act, Dance, Sing FUN! Camp', 'unresolved: Act, Dance, Sing FUN! Camp'],
    ['Gentle Mat, Pilates and Stretch', 'unresolved: Gentle Mat, Pilates and Stretch'],
  ])('leaves an ordinary listing alone: %s', (title, notes) => {
    expect(isAdultOrSeniorOnly(noted(title, notes))).toBe(false);
  });

  it('treats absent/empty notes as silence, not as a claim either way', () => {
    expect(isAdultOrSeniorOnly({ activityName: 'Playtime', ageNotes: null })).toBe(false);
    expect(isAdultOrSeniorOnly({ activityName: 'Playtime', ageNotes: '   ' })).toBe(false);
    expect(isAdultOrSeniorOnly({ activityName: 'Playtime' })).toBe(false);
  });

  it('still lets the title\'s parent-and-child framing win over an adult audience tag', () => {
    // PARENT_AND_CHILD is checked on the title FIRST and is unconditional — a mis-tagged
    // family session must never be deleted by this filter.
    expect(isAdultOrSeniorOnly(noted('Family Badminton (6-13 with adult)', 'audience: Adults'))).toBe(false);
    expect(isAdultOrSeniorOnly(noted('Adult / Early Years (0-6years) Swim', 'audience: Adults'))).toBe(false);
    expect(isAdultOrSeniorOnly(noted("Children's Badminton w/Adult", 'unresolved: Adults, English'))).toBe(false);
  });
});

describe('isAdultOrSeniorOnly — keeps everything a child could attend', () => {
  it.each([
    'Adult / Early Years (0-6years) Swim Karen Magnussen Tuesday 9:00am-12:45pm',
    'Reserve In Advance: Children with Adult Basketball',
    "Reserve In Advance: Children's Badminton w/Adult",
    'Reserve In Advance: Family Badminton (6-13 with adult)',
    'Reserve In Advance: Family Pickleball (6-13 with adult)',
  ])('a parent-and-child session, even though it says "adult": %s', (title) => {
    expect(isAdultOrSeniorOnly(listing(title))).toBe(false);
  });

  it.each([
    'Fitness Studio Workout 15yrs+ Lynn Creek Saturday 1:30-5:30pm',
    "$2 Women's Only Swim 12yrs+ Ron Andrews Sunday 8:15-9:45pm",
    'Reserve In Advance: Figure Skating 16yrs+',
    'Power Skate 1 18+',
    'Youth Swim 8-14yrs Karen Magnussen Saturday 6:00-8:00pm',
  ])('a teen-inclusive age marker below the age of majority: %s', (title) => {
    expect(isAdultOrSeniorOnly(listing(title))).toBe(false);
  });

  it('keeps a BOUNDED high age range — that shape is a mis-parse, not an adult programme', () => {
    // Real row: a kids tennis camp whose ages were parsed as 24–29 years. A genuine adult/senior
    // listing is open-ended ("19+", "65+"); requiring ageMax to be null is what stops a bad parse
    // from silently deleting kids content.
    expect(isAdultOrSeniorOnly(listing('Art of Tennis Summer Camp - Aug 24-28 - Garden Park', 288, 348))).toBe(false);
  });

  it('needs the age floor to actually clear the age of majority', () => {
    expect(isAdultOrSeniorOnly(listing('Water Walking Delbrook Sunday 7:00-9:00am', 192))).toBe(false);
    expect(isAdultOrSeniorOnly(listing('Some Programme', ADULT_ONLY_AGE_MIN_MONTHS - 1))).toBe(false);
  });

  it.each([
    'Public Swim Delbrook Whole Pool Saturday 1:30-4:00pm',
    '$3 Open Gym 8yrs+ Parkgate Saturday 3:30-5:30pm',
    'Family Storytime',
    'Teen Summer Reading Club 2026',
  ])('ordinary kids content: %s', (title) => {
    expect(isAdultOrSeniorOnly(listing(title))).toBe(false);
  });
});
