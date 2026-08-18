// tests/audit/rules.test.ts — the two patterns, and (mostly) their false-positive guards.
//
// The guard cases outnumber the positive cases on purpose. A rule that fires on the two real
// incidents is easy; a rule that fires on those and NOT on "Indoor Playground", "Parkgate
// Community Centre", "Parent & Tot Swim" or the documented "Adults accompanying children under
// 9 must stay in the library" is the difference between a report people act on and one they
// filter to a folder. Every guard below is pinned to a real shape from the live catalogue.
import { describe, expect, it } from 'vitest';
import { outdoorIndoorRule } from '@/lib/audit/rules/outdoor-indoor';
import {
  adultAgeBandRule,
  audienceTagsAreAdultOnly,
  exposedToChildSearch,
  structuredTags,
} from '@/lib/audit/rules/adult-age-band';
import { adultSubjectChildBandsRule } from '@/lib/audit/rules/adult-subject-child-bands';
import type { AuditListing } from '@/lib/audit/types';

function listing(overrides: {
  title?: string;
  description?: string;
  ageWording?: string;
  venueName?: string;
  openHoursLabel?: string;
  suitabilityTags?: string[];
  categoryTags?: string[];
  primaryCategoryKey?: string;
  ageBandMatches?: string[];
  ageMinMonths?: number | null;
  ageMaxMonths?: number | null;
}): AuditListing {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    seriesId: null,
    organisation: 'Test Org',
    sourceUrl: null,
    source: {
      title: overrides.title ?? '',
      description: overrides.description ?? '',
      ageWording: overrides.ageWording ?? '',
      venueName: overrides.venueName ?? '',
      openHoursLabel: overrides.openHoursLabel ?? '',
    },
    derived: {
      suitabilityTags: overrides.suitabilityTags ?? [],
      categoryTags: overrides.categoryTags ?? ['class_program'],
      primaryCategoryKey: overrides.primaryCategoryKey ?? 'class_program',
      ageBandMatches: overrides.ageBandMatches ?? [],
      ageMinMonths: overrides.ageMinMonths ?? null,
      ageMaxMonths: overrides.ageMaxMonths ?? null,
    },
  };
}

describe('pattern 1 — outdoor source, indoor tag', () => {
  it('fires on the real tester-reported instance, with strong evidence', () => {
    // Verbatim from production: /api/search?q=sportball
    const signal = outdoorIndoorRule.detect(
      listing({
        title: 'Sportball Outdoor Soccer (5-7yrs) Rain/Shine',
        suitabilityTags: ['outdoor', 'indoor'],
        ageBandMatches: ['5-9'],
      })
    );
    expect(signal).not.toBeNull();
    const quotes = signal!.evidence.map((e) => e.quote.toLowerCase());
    expect(quotes).toContain('outdoor');
    expect(quotes.some((q) => q.includes('rain'))).toBe(true);
    expect(signal!.evidence.every((e) => e.strength === 'strong')).toBe(true);
    // The both-tags fact is context, not evidence.
    expect(signal!.derivedClaim).toContain('BOTH');
  });

  it('does not fire when the listing is not tagged indoor', () => {
    expect(
      outdoorIndoorRule.detect(listing({ title: 'Outdoor Soccer', suitabilityTags: ['outdoor'] }))
    ).toBeNull();
  });

  it('GUARD: does not fire when the source calls itself indoor', () => {
    // "Indoor Playground" would otherwise trip the weak `playground` marker on every indoor
    // play centre in the catalogue.
    expect(
      outdoorIndoorRule.detect(listing({ title: 'Indoor Playground Drop-In', suitabilityTags: ['indoor'] }))
    ).toBeNull();
    expect(
      outdoorIndoorRule.detect(
        listing({
          title: 'Family Play',
          description: 'Our indoor park is open rain or shine.',
          suitabilityTags: ['indoor'],
        })
      )
    ).toBeNull();
  });

  it('GUARD: "parking" is not "park"', () => {
    expect(
      outdoorIndoorRule.detect(
        listing({ title: 'Toddler Time', description: 'Free parking available.', suitabilityTags: ['indoor'] })
      )
    ).toBeNull();
  });

  it('GUARD: a venue name is never evidence', () => {
    // "Parkgate Community Centre" is indoors. Venue text is not scanned at all.
    expect(
      outdoorIndoorRule.detect(
        listing({ title: 'Toddler Time', venueName: 'Parkgate Community Centre', suitabilityTags: ['indoor'] })
      )
    ).toBeNull();
  });

  it('a bare "park" in the title is a WEAK candidate, not a finding', () => {
    const signal = outdoorIndoorRule.detect(
      listing({ title: 'Park Board Youth Program', suitabilityTags: ['indoor'] })
    );
    expect(signal).not.toBeNull();
    expect(signal!.evidence.every((e) => e.strength === 'weak')).toBe(true);
  });
});

describe('pattern 2 — adult source, child age exposure', () => {
  it('fires on the real tester-reported instance (no bands → every age filter)', () => {
    // Verbatim age_notes from production for "Supporting People Together: The Basics of
    // Overdose Response" — the listing that came back from an ages=2-4 search.
    const signal = adultAgeBandRule.detect(
      listing({
        title: 'Supporting People Together: The Basics of Overdose Response',
        ageWording:
          'International Overdose Awareness Day, Health, Life Skills and Personal Growth, Adults, English',
        ageBandMatches: [],
        suitabilityTags: ['free', 'indoor'],
      })
    );
    expect(signal).not.toBeNull();
    expect(signal!.evidence.some((e) => e.field === 'ageWording' && e.strength === 'strong')).toBe(true);
    expect(signal!.derivedClaim).toContain("empty → don't hide");
  });

  it('fires on prenatal programming that carries no bands', () => {
    const signal = adultAgeBandRule.detect(listing({ title: 'Prenatal Yoga', ageBandMatches: [] }));
    expect(signal).not.toBeNull();
    expect(signal!.evidence.some((e) => e.strength === 'strong')).toBe(true);
  });

  it('fires when an adults-only source carries an actual child band', () => {
    const signal = adultAgeBandRule.detect(
      listing({ title: 'Adults Only Badminton (19+)', ageBandMatches: ['2-4', '5-9'] })
    );
    expect(signal).not.toBeNull();
    expect(signal!.derivedClaim).toContain('2-4');
  });

  it('GUARD: the documented trap — "Adults accompanying children…" is not adult programming', () => {
    // worker/core/age.ts:245-250 names this exact sentence. It begins with "Adults", so the
    // shipped ADULT_AUDIENCE_RE (anchored at ^) resolves it to 18+ if it is ever treated as a
    // structured tag. structuredTags() must refuse to treat it as one.
    const trap = 'Adults accompanying children under 9 must stay in the library';
    expect(structuredTags(trap)).toEqual([]);
    expect(audienceTagsAreAdultOnly(trap)).toBe(false);
    expect(adultAgeBandRule.detect(listing({ title: 'Storytime', ageWording: trap, ageBandMatches: ['2-4'] }))).toBeNull();
    expect(
      adultAgeBandRule.detect(listing({ title: 'Storytime', description: trap, ageBandMatches: ['2-4'] }))
    ).toBeNull();
  });

  it('GUARD: other supervision phrasings are also not audience claims', () => {
    for (const prose of [
      'Children must be accompanied by an adult at all times',
      'Adult supervision required for all participants',
      'Parent participation required',
    ]) {
      expect(
        adultAgeBandRule.detect(listing({ title: 'Open Gym', description: prose, ageBandMatches: ['5-9'] }))
      ).toBeNull();
    }
  });

  it('GUARD: caregiver-attended children programmes are not adult programmes', () => {
    for (const title of [
      'Parent & Tot Swim',
      'Adult and Child Skate',
      'Family Storytime',
      'Caregiver and Baby Yoga',
    ]) {
      expect(adultAgeBandRule.detect(listing({ title, ageBandMatches: ['under2', '2-4'] }))).toBeNull();
    }
  });

  it('GUARD: a MIXED audience tag list is not an adult-only claim', () => {
    // parseAudienceLabels unions the tags, so "Adults" beside a children's audience resolves
    // below the adult floor — which is the correct reading, not a bug to work around.
    expect(audienceTagsAreAdultOnly('Storytimes, Preschool Age Children, Adults, English')).toBe(false);
  });

  it('GUARD: an adult listing that only reaches teen/adult bands is not exposed', () => {
    expect(
      adultAgeBandRule.detect(listing({ title: 'Adults Only Badminton (19+)', ageBandMatches: ['10-14', '15+'] }))
    ).toBeNull();
  });

  it('exposure classification distinguishes the two ways a child search reaches a listing', () => {
    expect(exposedToChildSearch(['2-4'])!.why).toContain('child age band');
    expect(exposedToChildSearch([])!.why).toContain("empty → don't hide");
    expect(exposedToChildSearch(['15+'])).toBeNull();
  });

  it('a bare "adults" in free text with no supervision context is a WEAK candidate only', () => {
    const signal = adultAgeBandRule.detect(
      listing({ title: 'Board Games for Adults and Teens', ageBandMatches: [] })
    );
    expect(signal).not.toBeNull();
    expect(signal!.evidence.every((e) => e.strength === 'weak')).toBe(true);
  });
});

describe('pattern 3 — adult SUBJECT, affirmatively-claimed child band', () => {
  /** Verbatim from production 2026-08-18, id 97670289-a949-4ebb-8f47-d33adf92d404. */
  const overdose = () =>
    listing({
      title: 'International Overdose Awareness',
      // NOT source text. `age_notes` keeps the RAW wording only for rows that stayed
      // unresolved; this row resolved, so the field holds our own verdict. The rule must not
      // be able to excuse itself with it — see the guard test below.
      ageWording: 'all-ages',
      ageBandMatches: ['under2', '2-4', '5-9', '10-14', '15+'],
      ageMinMonths: 0,
      ageMaxMonths: null,
    });

  it('fires on the real live instance, with strong evidence', () => {
    const signal = adultSubjectChildBandsRule.detect(overdose());
    expect(signal).not.toBeNull();
    expect(signal!.evidence.map((e) => e.quote.toLowerCase())).toContain('overdose');
    expect(signal!.evidence.some((e) => e.field === 'title' && e.strength === 'strong')).toBe(true);
    // The report has to say the claim was MADE, not merely not-hidden — that is the whole
    // difference between this pattern and pattern 2.
    expect(signal!.derivedClaim).toContain('AFFIRMATIVELY');
    expect(signal!.derivedClaim).toContain('under2');
  });

  it('pattern 2 cannot see it, which is why this rule exists', () => {
    // Not "pattern 2 ignores resolved rows" — it handles both exposure shapes. It has no
    // ADULT AUDIENCE wording to read here, because resolving the age destroyed it.
    expect(adultAgeBandRule.detect(overdose())).toBeNull();
  });

  it('does NOT fire on the empty-band case — that is pattern 2\'s row, not a second finding', () => {
    expect(
      adultSubjectChildBandsRule.detect(
        listing({ title: 'The Basics of Overdose Response', ageBandMatches: [] })
      )
    ).toBeNull();
  });

  it('does NOT fire when the claimed bands are teen/adult only', () => {
    expect(
      adultSubjectChildBandsRule.detect(
        listing({ title: 'Naloxone Training', ageBandMatches: ['10-14', '15+'] })
      )
    ).toBeNull();
  });

  it('GUARD: a derived age string can never excuse a derived age claim', () => {
    // If `ageWording` were scanned by the child-audience guard, the literal string "all-ages"
    // this codebase wrote would drop the finding — the bug would be its own alibi.
    const signal = adultSubjectChildBandsRule.detect(overdose());
    expect(signal).not.toBeNull();
  });

  it('GUARD: the source naming a young audience drops the listing outright', () => {
    for (const title of [
      'Grief Support for Children and Families',
      'Youth Mental Health First Aid',
      'Teen Naloxone Training',
      'Overdose Awareness — All Ages Welcome',
    ]) {
      expect(
        adultSubjectChildBandsRule.detect(listing({ title, ageBandMatches: ['5-9'] })),
        title
      ).toBeNull();
    }
  });

  it('GUARD: caregiver-attended programmes are dropped, same guard as pattern 2', () => {
    expect(
      adultSubjectChildBandsRule.detect(
        listing({ title: 'Parent & Tot Swim', description: 'Naloxone kits available on site.', ageBandMatches: ['under2'] })
      )
    ).toBeNull();
  });

  it('an ambiguous subject is a WEAK candidate, never an unreviewed finding', () => {
    // Verbatim live title, also tagged all five bands. "Support Group" is real signal with an
    // innocent reading (groups for parents of a child, run with childcare), so it earns a
    // candidate for adjudication and nothing more.
    const signal = adultSubjectChildBandsRule.detect(
      listing({ title: 'Kitsilano MS Support Group', ageBandMatches: ['under2', '2-4', '5-9', '10-14', '15+'] })
    );
    expect(signal).not.toBeNull();
    expect(signal!.evidence.every((e) => e.strength === 'weak')).toBe(true);
  });

  it('after the Level-1-2 ingest fix, the level rows are not a pattern-3 finding', () => {
    // Part C makes parseAgeText leave these unresolved, so the affirmative precondition fails.
    // (Production still serves the pre-fix bands until the rows are re-ingested — this pins the
    // post-fix SHAPE, which is the only thing a rule test can honestly assert.)
    for (const title of ['Balanced Body Pilates (Level 1-2)', 'Pickleball Lesson – Skills & Drills Level (1-2)']) {
      expect(adultSubjectChildBandsRule.detect(listing({ title, ageBandMatches: [] })), title).toBeNull();
    }
  });
});
