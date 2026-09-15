// Registration-required classification (lib/search/filters/registration.ts).
//
// The classifier decides what leaves the DEFAULT view — everything it flags is still reachable
// via the opt-in filter — so the cost of the two error directions is asymmetric:
//   • A missed course is noise. Acceptable; the suite pins several known misses on purpose so the
//     conservatism is visible rather than accidental.
//   • A wrongly-flagged drop-in is a public swim vanishing from "what's on today". Not acceptable,
//     which is why the drop-in override exists and why most of this suite defends it.
//
// Every title is real, taken from the live staging catalogue.

import { describe, expect, it } from 'vitest';
import { hasDropInSignal, isRegistrationShaped } from '../../lib/search/filters/registration';

const listing = (activityName: string, tags: string[] = []) => ({ activityName, suitabilityTags: tags });

describe('isRegistrationShaped — flags registration-required content', () => {
  it.each([
    'Art of Tennis Summer Camp - Aug 10-14 - Garden Park',
    'Camp Parkgate Stuffy Sleepover',
    'Youth Leadership Camp - Week 6',
    'Frozen Ballet Dance Camp 3-5yrs',
  ])('a camp: %s', (title) => {
    expect(isRegistrationShaped(listing(title))).toBe(true);
  });

  it.each([
    '|Lessons|',
    'Pickleball Lessons: Beginner Level',
    'Guitar/Ukelele- Private Lessons',
    'Handpan (Hang drum) Private lessons',
  ])('a lesson programme: %s', (title) => {
    expect(isRegistrationShaped(listing(title))).toBe(true);
  });

  it.each([
    'Intro to Figure Skating',
    'Intro to Hockey (8-12yrs) Male and Non Binary',
    'Intro to Ringette (8-12yrs)',
    'Intro to Dungeons and Dragons (Tweens)',
    'Aikido Summer Kids Class',
    'Ki Aikido - Women, Queer, Trans  - Intro Class',
    'My First Dance Class: 2-4yrs',
    'Red Cross Babysitting Course',
    'Creative Math Lab Series',
    'West End Soccer Academy (5-7yrs)',
    'Youths Learn to Play Volleyball',
    'Strikewell Youth Boxing Level 1',
  ])('a named class / course: %s', (title) => {
    expect(isRegistrationShaped(listing(title))).toBe(true);
  });

  it.each([
    'Power Skate 1 (9-12yrs)',
    'Figure Skating 1',
    'Hockey 2 (18yrs+)',
  ])('a skill-programme level number: %s', (title) => {
    expect(isRegistrationShaped(listing(title))).toBe(true);
  });

  it.each([
    'Reserve in Advance: Figure Skating 8-17yrs (Level Star 2 +)',
    'Reserve In Advance: Figure Skating 16yrs+',
    'Reserve In Advance: Squash Court #1',
  ])("the vendor's own advance-booking prefix: %s", (title) => {
    expect(isRegistrationShaped(listing(title))).toBe(true);
  });
});

describe('isRegistrationShaped — a drop-in signal always wins', () => {
  it('never flags a listing carrying the persisted drop_in tag', () => {
    // Even with the strongest possible title evidence, a positive tag ends the argument.
    expect(isRegistrationShaped(listing('Summer Camp Week 3', ['drop_in']))).toBe(false);
  });

  it.each([
    // Pool-schedule rows that run lessons AND leave water open to the public. Excluding these
    // would take real drop-in swimming away from parents.
    '| Lessons/Swim Club | 1L Lengths |',
    '|Public Swim/ Lessons]',
    'Lengths | Group Lessons',
    '|Lessons and One Lane|',
    'Lessons (1 Lane only)',
  ])('keeps a mixed lesson/open-water slot: %s', (title) => {
    expect(isRegistrationShaped(listing(title))).toBe(false);
  });

  it('does not treat an audience word as evidence about booking', () => {
    // "All ages" says who may come, not whether you must book. Treating it as a drop-in signal
    // split one vendor's identical booking model on an irrelevant word: "Reserve In Advance: Table
    // Tennis All Ages" showed by default while "Reserve In Advance: Badminton (8-17yrs)" did not.
    expect(isRegistrationShaped(listing('Reserve In Advance: Table Tennis All Ages'))).toBe(true);
    expect(isRegistrationShaped(listing('Reserve In Advance: Badminton (8-17yrs)'))).toBe(true);
    // …and the audience word still does not make a non-course into one.
    expect(isRegistrationShaped(listing('All Ages Youth Drop-in'))).toBe(false);
  });

  it('keeps an advance-booking slot that is also explicitly a drop-in activity', () => {
    // The case the investigation flagged as having no clean answer: reserve-in-advance is offered,
    // but the session itself is a public swim. The default view is the drop-in view, so it stays.
    expect(isRegistrationShaped(listing('Reserve In Advance: Public Swim'))).toBe(false);
    expect(isRegistrationShaped(listing('Reserve In Advance: Family Badminton (6-13 with adult)', ['drop_in']))).toBe(false);
  });

  it.each([
    'Public Swim Delbrook Whole Pool Saturday 1:30-4:00pm',
    '$3 Open Gym 8yrs+ Parkgate Saturday 3:30-5:30pm',
    'Family Storytime',
    'Play Palace - Toddler Time',
    'Basketball Drop-in',
    'Family Skate New Harry Jerome Saturday 10:00-11:30am',
    '$2 Parent Participation Playtime 0-5yrs Delbrook Sunday 8:30am-10:30am',
    'Lane Swim Delbrook Monday 1:30-4:00pm',
  ])('keeps ordinary drop-in content: %s', (title) => {
    expect(isRegistrationShaped(listing(title))).toBe(false);
  });

  it('does not mistake an age range for a programme level', () => {
    // A bare trailing-number rule swept all of these up; the level rule must not.
    expect(isRegistrationShaped(listing('Badminton 18+ yrs (Wed)'))).toBe(false);
    expect(isRegistrationShaped(listing('Badminton 55+ - Wed'))).toBe(false);
    expect(isRegistrationShaped(listing('Youth Swim 8-14yrs Karen Magnussen Saturday 6:00-8:00pm'))).toBe(false);
  });

  it('does not treat a number in a title as a level', () => {
    // Real row. A free outdoor film screening is exactly the drop-in content that must not vanish.
    expect(isRegistrationShaped(listing('Outdoor Movie at West Point Grey - Zootopia 2'))).toBe(false);
    expect(isRegistrationShaped(listing('3v3 Basketball'))).toBe(false);
  });
});

describe('isRegistrationShaped — documented conservative misses', () => {
  it('leaves registered programmes whose titles carry no signal at all', () => {
    // These ARE courses. Catching them needs the persisted registration data the pipeline already
    // downloads and discards — not a looser regex, which is what would start deleting public swims.
    // Pinned so the gap stays a known limit rather than an assumption.
    expect(isRegistrationShaped(listing('Sportball Multisport  (3-5 yrs)'))).toBe(false);
    expect(isRegistrationShaped(listing('Indoor T-Ball (3-5 yrs)'))).toBe(false);
    expect(isRegistrationShaped(listing('Adventures in Music for Babies'))).toBe(false);
  });
});

describe('hasDropInSignal', () => {
  it('reads the tag from either tag collection', () => {
    expect(hasDropInSignal({ activityName: 'Anything', suitabilityTags: ['drop_in'] })).toBe(true);
    expect(hasDropInSignal({ activityName: 'Anything', categoryTags: ['drop_in'] })).toBe(true);
    expect(hasDropInSignal({ activityName: 'Anything' })).toBe(false);
  });
});

// ── Option A: the persisted source fact (supabase/migrations/0027) ─────────────────────
//
// The module header above says this classifier is "sized to be replaced by a real column".
// This block is the first half of that replacement landing: where a row carries the source's
// OWN answer, it is read instead of guessed. Every case here changes an outcome — a suite
// that only asserted "null still uses the heuristic" would pass with the new branch deleted.
describe('isRegistrationShaped — a persisted source fact overrides the title', () => {
  it('flags a drop-in-SHAPED title the source says you must register for', () => {
    // Real shape: a BiblioCommons "Baby Storytime" whose registrationInfo requires a login.
    // The title vocabulary says drop-in and is WRONG; the library's own booking system is not.
    expect(isRegistrationShaped(listing('Baby Storytime'))).toBe(false); // heuristic alone
    expect(isRegistrationShaped({ activityName: 'Baby Storytime', registrationRequired: true })).toBe(true);
    // Beats the explicit drop_in TAG too, not just the title regex.
    expect(
      isRegistrationShaped({ activityName: 'Baby Storytime', suitabilityTags: ['drop_in'], registrationRequired: true })
    ).toBe(true);
  });

  it('keeps a course-SHAPED title in the default view when the source says no booking is needed', () => {
    // The shape under test: a record sitting on a '**Drop-In Schedules' calendar (BookingType 2)
    // whose TITLE carries course vocabulary the heuristic cannot help but flag. The string is
    // illustrative — what is being pinned is the precedence, not this particular wording — and
    // this is the direction of error the module header calls the expensive one, so the fact
    // has to be able to rescue it.
    expect(isRegistrationShaped(listing('Skating Level 1'))).toBe(true); // heuristic alone
    expect(isRegistrationShaped({ activityName: 'Skating Level 1', registrationRequired: false })).toBe(false);
    expect(hasDropInSignal({ activityName: 'Skating Level 1', registrationRequired: false })).toBe(true);
  });

  it('leaves the heuristic completely untouched when the source said nothing', () => {
    // null AND undefined both mean silence — the state ~99% of rows are in today, including
    // every activenet row. Any behaviour change here would be a regression, not a feature.
    for (const silent of [null, undefined] as const) {
      expect(isRegistrationShaped({ activityName: 'Frozen Ballet Dance Camp 3-5yrs', registrationRequired: silent })).toBe(true);
      expect(isRegistrationShaped({ activityName: 'Public Swim - Family', registrationRequired: silent })).toBe(false);
      expect(isRegistrationShaped({ activityName: 'Sportball Multisport  (3-5 yrs)', registrationRequired: silent })).toBe(false);
      expect(hasDropInSignal({ activityName: 'Anything At All', registrationRequired: silent })).toBe(false);
    }
  });

  it('does not let the two facts contradict each other', () => {
    // true wins over false is not a case that can arise (one column), but the ordering inside
    // isRegistrationShaped must be checked explicitly: the fact is read BEFORE hasDropInSignal,
    // otherwise a `false` fact would short-circuit a `true` one via the drop-in veto.
    expect(isRegistrationShaped({ activityName: 'Public Swim', registrationRequired: true })).toBe(true);
    expect(isRegistrationShaped({ activityName: 'Summer Camp', registrationRequired: false })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-15 VOCABULARY PATCH — the martial-arts and ballerina gap.
//
// Jon read a real Friday text carrying "Olympic Style TaeKwonDo (11-16 yrs)" and "Little
// Ballerinas". Both are multi-week registration programmes; both have registration_required NULL
// in production, so both fell to this file's title heuristic, and the heuristic had no word for
// either. "taekwondo" was absent from the vocabulary entirely, and neither title carries a bare
// trailing level digit or a duration word.
//
// Every title below is a real production title, and the change was audited the way this file's
// header requires rather than patched to the two examples: run against 3,692 distinct live
// activity names (28,821 occurrences) with scripts/registration-vocabulary-probe.sh, 195 titles /
// 1,358 occurrences moved from drop-in to registration, ZERO moved the other way, and zero titles
// moved that were not one of the terms below.
// ─────────────────────────────────────────────────────────────────────────────

describe('martial-arts programmes — a named discipline is a curriculum, digit or no digit', () => {
  it.each([
    'Olympic Style TaeKwonDo (11-16 yrs)', // the reported title
    'Olympic Style TaeKwonDo (4-6yrs)',
    'Taekwondo - White Belt to Yellow Belt',
    'Taekwondo All Levels - Young Adult',
    'Tae Kwon Do',
  ])('taekwondo, in every spelling the catalogue uses: %s', (title) => {
    expect(isRegistrationShaped(listing(title))).toBe(true);
  });

  it.each([
    // These three WERE in the vocabulary and were almost entirely inert, because PROGRAM_LEVEL
    // required a bare trailing digit that a parenthesised age range or month is not.
    'Karate - Advanced (Full Month) AUG',
    'Seiyu Karate - Blue Belt to Yellow Belt (No Beginner)',
    'Aikido (August)',
    'Parent & Kids Aikido (4-6yrs)',
    // …and these were never in it at all. Found by auditing the catalogue for the same shape,
    // not by reading the two titles in Jon's text. `capoeira` alone is 63 live titles.
    'Axe Capoeira - Beginner mini kids (3-6yrs) SEPT',
    'Kids Capoeira',
    'Kung Fu: Choy Lee Fut (Oct)',
    'Gentle Method Toddler Jiu Jitsu (3-6yrs)',
    'Muay Thai Kickboxing',
    'Britannia Boxing (SEPT)',
    'Children/Preteens - RC Boxing',
    'I Liq Chuan (Martial Arts of Awareness) - Beginners',
  ])('the rest of the family, which the audit found and the report did not: %s', (title) => {
    expect(isRegistrationShaped(listing(title))).toBe(true);
  });

  it('BOXING DAY IS A DATE, NOT A DISCIPLINE', () => {
    // The catalogue holds no Boxing Day content in September and will in December. A Boxing Day
    // family event is exactly the genuine weekend content this file exists to keep visible, so
    // the lookahead is load-bearing rather than defensive decoration.
    expect(isRegistrationShaped(listing('Boxing Day Public Skate'))).toBe(false);
    expect(isRegistrationShaped(listing('Boxing Day Family Swim'))).toBe(false);
  });

  it('still loses to a drop-in signal, like every other term in this file', () => {
    // The veto is not weakened by any of this: the registration signal is still a GUESS, and a
    // positive drop-in signal still beats it.
    expect(isRegistrationShaped(listing('Drop-in Karate'))).toBe(false);
    expect(isRegistrationShaped({ activityName: 'Capoeira', registrationRequired: false })).toBe(false);
    expect(isRegistrationShaped(listing('Open Gym Boxing', ['drop_in']))).toBe(false);
  });
});

describe('dance programmes without a level digit — the narrow half of the patch', () => {
  it.each([
    'Little Ballerinas', // the reported title
    'Little Ballerinas: 3-5yrs',
    'Endorphin Rush: Little Ballerinas (4-6 yrs)',
    'Creative Ballet (3-5yrs)',
    'Children Creative Ballet',
    'Creative Dance',
    'Collaborative Creative Dance for Older Adults (55+ yrs)',
  ])('%s', (title) => {
    expect(isRegistrationShaped(listing(title))).toBe(true);
  });

  it('WHY THIS IS NOT JUST "ballet" — the measured false positive that rule would have caused', () => {
    // A bare `\bballet\b` would have been the obvious, tidier rule and it is wrong: the catalogue
    // holds a genuine ballet PERFORMANCE, which is a weekend outing rather than a course. Pinned
    // so the tidier rule cannot be reintroduced without this failing.
    expect(isRegistrationShaped(listing("Goh Ballet's The Nutcracker"))).toBe(false);
    // Likewise `\bdance\b`: these are events, not programmes.
    expect(isRegistrationShaped(listing('Coastal First Nations Dance Festival'))).toBe(false);
    expect(isRegistrationShaped(listing('All Over The Map: Outdoor Dance Performances'))).toBe(false);
    expect(isRegistrationShaped(listing('Collingwood Lunar New Year Lion Dance'))).toBe(false);
  });

  it('A SKILL-LEVEL WORD IS NOT A REGISTRATION SIGNAL — rejected on evidence, pinned so it stays rejected', () => {
    // 281 live titles carry "Beginner"/"Intermediate"/"All Levels" and it looked like the
    // highest-yield generic rule available. These three are why it was not taken: drop-in
    // community-centre sessions labelled by skill.
    expect(isRegistrationShaped(listing('Adult Sports: Badminton - All Levels'))).toBe(false);
    expect(isRegistrationShaped(listing('Badminton Intermediate Play'))).toBe(false);
    expect(isRegistrationShaped(listing('Ball Hockey (Co-ed) - All Levels'))).toBe(false);
  });
});

describe('a vendor programme-series brand — the sibling gap the first patch left open', () => {
  // The 2026-09-15 vocabulary patch caught six of this family's ten titles via `ballerinas?` and
  // `creative dance`, and left four. QA found the gap the expensive way: removing "Little
  // Ballerinas" PROMOTED its sibling "Hip Hop Breakers" into a real subscriber's direct-linked
  // slot, so the half-fixed family became MORE visible rather than less.
  //
  // Audited like every other rule here: over all 3,693 live production titles the brand matches
  // 10, of which 6 were already classified — so the delta is exactly these 4 (34 occurrences),
  // with no event, performance, festival or showcase among them.
  it.each([
    'Endorphin Rush: Hip Hop Breakers',
    'Endorphin Rush: Hip Hop Breakers (4-7 yrs)',
    'Endorphin Rush: Mini Hip Hop Breakers',
    'Endorphin Rush: Jazz / Ballet',
  ])('%s', (title) => {
    expect(isRegistrationShaped(listing(title))).toBe(true);
  });

  it('is why the brand is the signal and `ballet` still is not', () => {
    // "Jazz / Ballet" is the sharpest case for the brand rule: it is this vendor's class, while
    // the art form's name also belongs to genuine performances. Both facts survive together only
    // because the BRAND does the work and `\bballet\b` is still refused.
    expect(isRegistrationShaped(listing('Endorphin Rush: Jazz / Ballet'))).toBe(true);
    expect(isRegistrationShaped(listing("Goh Ballet's The Nutcracker"))).toBe(false);
  });

  it('still loses to a drop-in signal, like every other term in this file', () => {
    expect(isRegistrationShaped({ activityName: 'Endorphin Rush: Open Gym', registrationRequired: false })).toBe(false);
    expect(isRegistrationShaped(listing('Endorphin Rush: Hip Hop Breakers', ['drop_in']))).toBe(false);
  });
});
