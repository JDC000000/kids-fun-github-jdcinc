// tests/sms/registration.test.ts — Jon's §8 Q1 line: multi-session commitments out, one-off
// bookings in (PRD v2.8 §2.2 step 2).
//
// EVERY TITLE BELOW IS A REAL ONE. They are taken from
// tests/search/registration-filter.test.ts, which pins the shared classifier against titles
// audited across all 9,988 live staging occurrences. Inventing plausible-looking titles would test
// the regex I wrote rather than the catalogue it has to survive.
import { describe, expect, it } from 'vitest';
import { makeListing } from '@/lib/search/__fixtures__/factory';
import { isRegistrationShaped } from '@/lib/search/filters/registration';
import type { ListingRecord } from '@/lib/search/types';
import {
  hasBookingMechanismWording,
  isMultiSessionCommitment,
  isWeeklyPickEligible,
  stripBookingMechanismWording,
} from '@/lib/sms/registration';

function listing(activityName: string, over: Partial<ListingRecord> = {}): ListingRecord {
  return makeListing({ activityName, ...over });
}

/** Real multi-session programmes, from the shared filter's own fixtures. */
const COMMITMENTS = [
  'Art of Tennis Summer Camp - Aug 10-14 - Garden Park',
  'Camp Parkgate Stuffy Sleepover',
  'Youth Leadership Camp - Week 6',
  'Frozen Ballet Dance Camp 3-5yrs',
  'Pickleball Lessons: Beginner Level',
  'Guitar/Ukelele- Private Lessons',
  'Aikido Summer Kids Class',
  'Ki Aikido - Women, Queer, Trans  - Intro Class',
  'My First Dance Class: 2-4yrs',
  'Strikewell Youth Boxing Level 1',
  'Reserve in Advance: Figure Skating 8-17yrs (Level Star 2 +)',
];

/**
 * Real BOOKING-ONLY titles: they require booking, and say nothing about duration. These are
 * exactly what Jon's ruling reinstates — the shared classifier excludes all three today.
 */
const BOOKING_ONLY = [
  'Reserve In Advance: Table Tennis All Ages',
  'Reserve In Advance: Badminton (8-17yrs)',
  'Reserve In Advance: Squash Court #1',
];

describe('the vocabulary split', () => {
  it('recognises booking-mechanism wording, and strips it cleanly', () => {
    expect(hasBookingMechanismWording('Reserve In Advance: Table Tennis All Ages')).toBe(true);
    expect(hasBookingMechanismWording('Registration Required: Pottery')).toBe(true);
    expect(hasBookingMechanismWording('Aikido Summer Kids Class')).toBe(false);

    // The dangling prefix punctuation goes with it — "Reserve In Advance: X" must not leave ": X".
    expect(stripBookingMechanismWording('Reserve In Advance: Table Tennis All Ages')).toBe(
      'Table Tennis All Ages'
    );
    expect(stripBookingMechanismWording('Aikido Summer Kids Class')).toBe('Aikido Summer Kids Class');
  });
});

describe('multi-session commitments stay OUT', () => {
  it('excludes every real course, camp, lesson and levelled programme', () => {
    for (const title of COMMITMENTS) {
      expect(isMultiSessionCommitment(listing(title)), title).toBe(true);
      expect(isWeeklyPickEligible(listing(title)), title).toBe(false);
    }
  });

  it('still excludes them when the booking wording is what made them registration-shaped too', () => {
    // 'Reserve in Advance: Figure Skating (Level Star 2 +)' carries BOTH signals. Stripping the
    // booking half leaves "Level Star 2", which is a commitment — so it stays out.
    const both = listing('Reserve in Advance: Figure Skating 8-17yrs (Level Star 2 +)');
    expect(hasBookingMechanismWording(both.activityName)).toBe(true);
    expect(isMultiSessionCommitment(both)).toBe(true);
  });
});

describe('one-off bookings now come IN — the behaviour Jon asked for', () => {
  it('lets a book-in-advance one-off through, where the shared classifier excludes it', () => {
    for (const title of BOOKING_ONLY) {
      // The shared filter — correctly, for /search — treats these as registration content.
      expect(isRegistrationShaped(listing(title)), title).toBe(true);
      // The SMS rule reads the same title and asks the different question Jon posed.
      expect(isMultiSessionCommitment(listing(title)), title).toBe(false);
      expect(isWeeklyPickEligible(listing(title)), title).toBe(true);
    }
  });

  it('lets a registration-FLAGGED one-off through — the biggest change here', () => {
    // A BiblioCommons event whose registrationInfo says you must log in to register is very often
    // a single Saturday session. The shared classifier's flag outranks even its drop-in veto,
    // correctly, because it answers "must you book?". That is not the question this asks.
    const flagged = listing('Lantern Making Drop-In', { registrationRequired: true });
    expect(isRegistrationShaped(flagged)).toBe(true); // shared: yes, you must book
    expect(isMultiSessionCommitment(flagged)).toBe(false); // ours: but it is one afternoon
    expect(isWeeklyPickEligible(flagged)).toBe(true);
  });

  it('does NOT let the flag rescue something the title says is a course', () => {
    const flagged = listing('Frozen Ballet Dance Camp 3-5yrs', { registrationRequired: true });
    expect(isMultiSessionCommitment(flagged)).toBe(true);
  });
});

describe('everything the shared classifier already lets through is untouched', () => {
  it('never excludes a listing that was not registration-shaped in the first place', () => {
    for (const title of [
      'Public Swim',
      'Reserve In Advance: Public Swim', // drop-in veto in the shared filter
      'Family Skate',
      'Preschool Storytime',
      'Open Gym',
      'Trout Lake Splash Park',
    ]) {
      expect(isRegistrationShaped(listing(title)), title).toBe(false);
      expect(isWeeklyPickEligible(listing(title)), title).toBe(true);
    }
  });

  it('honours an explicit registrationRequired: false, same as the shared filter', () => {
    // The vendor said no booking needed. That is a drop-in signal and it wins.
    const explicit = listing('Skating Level 1', { registrationRequired: false });
    expect(isRegistrationShaped(explicit)).toBe(false);
    expect(isWeeklyPickEligible(explicit)).toBe(true);
  });

  it('honours the drop_in suitability tag', () => {
    const tagged = listing('Summer Camp Week 3', { suitabilityTags: ['drop_in'] });
    expect(isRegistrationShaped(tagged)).toBe(false);
    expect(isWeeklyPickEligible(tagged)).toBe(true);
  });
});

describe('the rule is a NARROWING of the shared classifier, never a widening', () => {
  it('nothing the shared filter admits is newly excluded', () => {
    // The whole design: `isMultiSessionCommitment` returns false immediately unless
    // `isRegistrationShaped` already said true. So the SMS exclusion set is a strict SUBSET of the
    // site's. If this ever fails, the SMS text has started hiding drop-in content the website
    // shows — the expensive direction.
    const everything = [...COMMITMENTS, ...BOOKING_ONLY, 'Public Swim', 'Family Skate', 'Open Gym'];
    for (const title of everything) {
      const l = listing(title);
      if (!isRegistrationShaped(l)) {
        expect(isMultiSessionCommitment(l), title).toBe(false);
      }
    }
  });

  it('a term added to the shared vocabulary later is treated as a COMMITMENT by default', () => {
    // The re-run inherits REGISTRATION_TITLE wholesale, so anything new in it keeps being
    // excluded. Demonstrated with a term already in that list but not in the booking-mechanism
    // set: only the four booking terms fall on the "keep" side, everything else on the "exclude"
    // side, without this file having to enumerate them.
    for (const title of ['Pottery Workshop', 'Skating Clinic', 'Junior Academy', 'Swim Series']) {
      expect(isMultiSessionCommitment(listing(title)), title).toBe(true);
    }
  });
});
