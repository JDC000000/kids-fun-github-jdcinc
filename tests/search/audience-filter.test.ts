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
