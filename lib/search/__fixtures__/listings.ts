// lib/search/__fixtures__/listings.ts — Fixture listing dataset (Metro Vancouver kids activities).
//
// Hand-authored to exercise the search/geo/ranking ACs while live ingestion (M1) is
// not yet available. Times are July 2026 (America/Vancouver = PDT, UTC-7); reference
// "now" for tests is 2026-07-13T12:00:00-07:00.
//
// Geo layout vs an East-Van origin (49.26,-123.07) with a 10km radius:
//   van / van-east / van-westside / North Van / Burnaby  → within 10km
//   Richmond                                             → outside 10km (~11km)
//
// AGE BOUNDS ARE STATED, NOT IMPLIED (added 2026-08-16 with the P0 age fix). Every listing
// here used to declare `ageBandMatches` and NOTHING ELSE, leaving `ageMinMonths`/`ageMaxMonths`
// at the factory's null default — a state the real pipeline never produces, because
// worker/core/age.ts derives the bands FROM the bounds and writes the two together or not at
// all. The gap was invisible while app/preview/_data/search-api.ts silently substituted 0–18
// for a null, which is exactly the fabrication that P0 removed.
//
// It was not harmless. KPI #5 "card completeness" (evals/scenarios/kpi-launch-gate.test.ts)
// requires `ageMin != null && ageMax != null` and reported 100% MET over this catalogue — on
// 16 of 16 listings that carried no age data whatsoever. The KPI was measuring the substitution
// rather than the data. Each bound below is derived from that listing's own declared bands
// (lowest band's lower bound → highest band's upper bound, null when the set reaches 15+), so
// the pair round-trips exactly back through computeAgeBandMatches to the bands already stated.

import type { ListingRecord } from '../types';
import { makeListing } from './factory';
import { REGION_IDS } from './regions';

// Approximate venue points.
const P = {
  eastVan: { lat: 49.26, lng: -123.07 },
  westSide: { lat: 49.25, lng: -123.16 },
  stanleyPark: { lat: 49.3, lng: -123.14 },
  northVan: { lat: 49.32, lng: -123.07 },
  northShoreMtn: { lat: 49.37, lng: -123.0 },
  burnaby: { lat: 49.2488, lng: -122.98 },
  richmond: { lat: 49.1666, lng: -123.1336 },
};

export const FIXTURE_LISTINGS: ListingRecord[] = [
  // --- open_gym cluster (FR-02 relevance, typo tolerance, radius) ---
  makeListing({
    id: 'l-opengym-van',
    activityName: 'Open Gym Drop-In',
    primaryCategoryKey: 'open_gym',
    categoryTags: ['drop_in'],
    venueName: 'Britannia Community Centre',
    organisation: 'Vancouver Parks',
    descriptionSnippet: 'Family open gym with mats and ride-on toys.',
    suitabilityTags: ['indoor', 'drop_in'],
    startDatetimeUtc: '2026-07-13T17:00:00Z', // 10:00 local (morning)
    endDatetimeUtc: '2026-07-13T19:00:00Z', // 12:00 local
    costStatus: 'free',
    statusState: 'bookable_open',
    confidenceLabel: 'official_recent',
    lastCheckedAtUtc: '2026-07-12T00:00:00Z',
    ageBandMatches: ['under2', '2-4', '5-9'],
    ageMinMonths: 0,
    ageMaxMonths: 120,
    geo: P.eastVan,
    municipalityId: REGION_IDS.vancouver,
    displayArea: REGION_IDS.vanEast,
    neighbourhood: 'Grandview-Woodland',
    // Fixture phones use the NANP 555-01xx block reserved for fiction — the demo shell is a
    // real, reachable surface and must never dial a real front desk. Live numbers come from
    // `venue.phone` in database mode only.
    venuePhone: '(604) 555-0142',
    bookingUrl: 'https://example.org/book/open-gym',
  }),
  makeListing({
    id: 'l-gymplay-nvan',
    activityName: 'Gymnasium Play Session',
    primaryCategoryKey: 'open_gym',
    categoryTags: ['drop_in'],
    venueName: 'North Shore Rec Centre',
    descriptionSnippet: 'Gymnasium play for toddlers and kids.',
    suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-13T21:00:00Z', // 14:00 local (afternoon)
    endDatetimeUtc: '2026-07-13T23:00:00Z', // 16:00 local
    costStatus: 'known',
    costMinCad: 5,
    costMaxCad: 5,
    statusState: 'confirmed',
    confidenceLabel: 'official',
    lastCheckedAtUtc: '2026-07-11T00:00:00Z',
    ageBandMatches: ['2-4', '5-9'],
    ageMinMonths: 24,
    ageMaxMonths: 120,
    geo: P.northVan,
    municipalityId: REGION_IDS.northVan,
  }),
  makeListing({
    id: 'l-familydropin-bby',
    activityName: 'Family Drop-In Gym',
    primaryCategoryKey: 'open_gym',
    categoryTags: ['drop_in'],
    venueName: 'Burnaby Community Centre',
    descriptionSnippet: 'Drop-in gym for families with young children.',
    suitabilityTags: ['indoor', 'drop_in'],
    startDatetimeUtc: '2026-07-14T17:00:00Z', // next day 10:00 local
    endDatetimeUtc: '2026-07-14T19:00:00Z',
    costStatus: 'known',
    costMinCad: 3,
    costMaxCad: 3,
    statusState: 'bookable_open',
    confidenceLabel: 'official',
    lastCheckedAtUtc: '2026-07-10T00:00:00Z',
    ageBandMatches: ['under2', '2-4'],
    ageMinMonths: 0,
    ageMaxMonths: 60,
    geo: P.burnaby,
    municipalityId: REGION_IDS.burnaby,
  }),
  makeListing({
    id: 'l-opengym-stale',
    activityName: 'Open Gym (unverified schedule)',
    primaryCategoryKey: 'open_gym',
    venueName: 'Old Hall Gym',
    descriptionSnippet: 'Open gym listing pending re-check.',
    suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-13T18:00:00Z', // 11:00 local
    endDatetimeUtc: '2026-07-13T20:00:00Z',
    costStatus: 'unknown',
    statusState: 'stale',
    confidenceLabel: 'stale',
    lastCheckedAtUtc: '2026-06-01T00:00:00Z',
    ageBandMatches: ['5-9'],
    ageMinMonths: 60,
    ageMaxMonths: 120,
    geo: P.eastVan,
    municipalityId: REGION_IDS.vancouver,
    displayArea: REGION_IDS.vanEast,
  }),

  // --- Clean status-boost pair (G-T19-2): identical except status/confidence ---
  makeListing({
    id: 'l-rank-confirmed',
    activityName: 'Rank Test Gym',
    primaryCategoryKey: 'open_gym',
    venueName: 'Test Centre',
    suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-13T21:00:00Z',
    endDatetimeUtc: '2026-07-13T23:00:00Z',
    costStatus: 'known',
    costMinCad: 5,
    costMaxCad: 5,
    statusState: 'bookable_open',
    confidenceLabel: 'official_recent',
    lastCheckedAtUtc: '2026-07-12T00:00:00Z',
    ageBandMatches: ['5-9'],
    ageMinMonths: 60,
    ageMaxMonths: 120,
    geo: P.eastVan,
    municipalityId: REGION_IDS.vancouver,
    displayArea: REGION_IDS.vanEast,
  }),
  makeListing({
    id: 'l-rank-stale',
    activityName: 'Rank Test Gym',
    primaryCategoryKey: 'open_gym',
    venueName: 'Test Centre',
    suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-13T21:00:00Z',
    endDatetimeUtc: '2026-07-13T23:00:00Z',
    costStatus: 'known',
    costMinCad: 5,
    costMaxCad: 5,
    statusState: 'stale',
    confidenceLabel: 'stale',
    lastCheckedAtUtc: '2026-07-12T00:00:00Z',
    ageBandMatches: ['5-9'],
    ageMinMonths: 60,
    ageMaxMonths: 120,
    geo: P.eastVan,
    municipalityId: REGION_IDS.vancouver,
    displayArea: REGION_IDS.vanEast,
  }),

  // --- public_swim ---
  makeListing({
    id: 'l-publicswim-van',
    activityName: 'Family Public Swim',
    primaryCategoryKey: 'public_swim',
    venueName: 'Kitsilano Pool',
    descriptionSnippet: 'Leisure swim for all ages.',
    suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-13T22:00:00Z', // 15:00 local (afternoon)
    endDatetimeUtc: '2026-07-14T00:00:00Z', // 17:00 local
    costStatus: 'known',
    costMinCad: 2,
    costMaxCad: 2,
    statusState: 'bookable_open',
    confidenceLabel: 'official_recent',
    lastCheckedAtUtc: '2026-07-12T00:00:00Z',
    ageBandMatches: ['under2', '2-4', '5-9', '10-14', '15+'],
    ageMinMonths: 0,
    ageMaxMonths: null,
    geo: P.westSide,
    municipalityId: REGION_IDS.vancouver,
    displayArea: REGION_IDS.vanWestSide,
    // The one ActiveNet rendering shape that carries a country code; kept verbatim on purpose.
    venuePhone: '+1 (604) 555-0177',
  }),
  makeListing({
    id: 'l-swim-nvan-evening',
    activityName: 'Leisure Swim',
    primaryCategoryKey: 'public_swim',
    venueName: 'North Van Aquatic',
    suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-14T01:00:00Z', // 18:00 local 07-13 (evening)
    endDatetimeUtc: '2026-07-14T03:00:00Z',
    costStatus: 'known',
    costMinCad: 2,
    costMaxCad: 2,
    statusState: 'full',
    confidenceLabel: 'official',
    lastCheckedAtUtc: '2026-07-09T00:00:00Z',
    ageBandMatches: ['5-9', '10-14', '15+'],
    ageMinMonths: 60,
    ageMaxMonths: null,
    geo: P.northVan,
    municipalityId: REGION_IDS.northVan,
  }),

  // --- skate (Richmond → outside 10km radius from East Van) ---
  makeListing({
    id: 'l-skate-rmd',
    activityName: 'Public Skate',
    primaryCategoryKey: 'skate',
    venueName: 'Richmond Ice Centre',
    suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-15T23:00:00Z', // 16:00 local
    endDatetimeUtc: '2026-07-16T01:00:00Z',
    costStatus: 'known',
    costMinCad: 4,
    costMaxCad: 4,
    statusState: 'confirmed',
    confidenceLabel: 'official',
    lastCheckedAtUtc: '2026-07-08T00:00:00Z',
    ageBandMatches: ['2-4', '5-9', '10-14', '15+'],
    ageMinMonths: 24,
    ageMaxMonths: null,
    geo: P.richmond,
    municipalityId: REGION_IDS.richmond,
  }),

  // --- storytime (free + unknown-cost variants for cost tests) ---
  makeListing({
    id: 'l-storytime-van',
    activityName: 'Toddler Storytime',
    primaryCategoryKey: 'storytime',
    venueName: 'West Side Library',
    descriptionSnippet: 'Songs and stories for toddlers.',
    suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-13T16:30:00Z', // 09:30 local (morning)
    endDatetimeUtc: '2026-07-13T17:30:00Z', // 10:30 local
    costStatus: 'free',
    statusState: 'confirmed',
    confidenceLabel: 'official',
    lastCheckedAtUtc: '2026-07-12T00:00:00Z',
    ageBandMatches: ['under2', '2-4'],
    ageMinMonths: 0,
    ageMaxMonths: 60,
    geo: P.westSide,
    municipalityId: REGION_IDS.vancouver,
    displayArea: REGION_IDS.vanWestSide,
  }),
  makeListing({
    id: 'l-storytime-unknown',
    activityName: 'Family Storytime (check branch)',
    primaryCategoryKey: 'storytime',
    venueName: 'East Van Library',
    suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-14T17:00:00Z', // tomorrow 10:00 local
    endDatetimeUtc: '2026-07-14T18:00:00Z',
    costStatus: 'unknown',
    statusState: 'confirmed',
    confidenceLabel: 'editorial',
    lastCheckedAtUtc: '2026-07-05T00:00:00Z',
    ageBandMatches: ['under2', '2-4', '5-9'],
    ageMinMonths: 0,
    ageMaxMonths: 120,
    geo: P.eastVan,
    municipalityId: REGION_IDS.vancouver,
    displayArea: REGION_IDS.vanEast,
  }),

  // --- indoor_play ---
  makeListing({
    id: 'l-indoorplay-bby',
    activityName: 'Indoor Playground Open Play',
    primaryCategoryKey: 'indoor_play',
    venueName: 'Burnaby Play Centre',
    descriptionSnippet: 'Soft play and climbing for little ones.',
    suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-13T20:00:00Z', // 13:00 local (afternoon)
    endDatetimeUtc: '2026-07-13T22:00:00Z',
    costStatus: 'known',
    costMinCad: 12,
    costMaxCad: 12,
    statusState: 'bookable_open',
    confidenceLabel: 'official',
    lastCheckedAtUtc: '2026-07-11T00:00:00Z',
    ageBandMatches: ['under2', '2-4', '5-9'],
    ageMinMonths: 0,
    ageMaxMonths: 120,
    geo: P.burnaby,
    municipalityId: REGION_IDS.burnaby,
  }),

  // --- open-hours attraction (miniature_train) — no fixed occurrence times ---
  makeListing({
    id: 'l-minitrain-van',
    activityName: 'Miniature Train Ride',
    primaryCategoryKey: 'miniature_train',
    venueName: 'Stanley Park',
    descriptionSnippet: 'Seasonal miniature railway through the park.',
    suitabilityTags: ['outdoor'],
    openHours: true,
    openHoursLocal: { startMin: 10 * 60, endMin: 17 * 60 }, // 10:00–17:00 local
    costStatus: 'known',
    costMinCad: 6,
    costMaxCad: 6,
    statusState: 'seasonal_active',
    confidenceLabel: 'official',
    lastCheckedAtUtc: '2026-07-10T00:00:00Z',
    ageBandMatches: ['under2', '2-4', '5-9', '10-14', '15+'],
    ageMinMonths: 0,
    ageMaxMonths: null,
    geo: P.stanleyPark,
    municipalityId: REGION_IDS.vancouver,
  }),

  // --- open-hours indoor attraction (aquarium) — open 09:00–17:00 local ---
  makeListing({
    id: 'l-aquarium-van',
    activityName: 'Aquarium Daily Visit',
    primaryCategoryKey: 'aquarium',
    venueName: 'Vancouver Aquarium',
    descriptionSnippet: 'Ocean exhibits open daily.',
    suitabilityTags: ['indoor'],
    openHours: true,
    openHoursLocal: { startMin: 9 * 60, endMin: 17 * 60 }, // 09:00–17:00 local
    costStatus: 'known',
    costMinCad: 40,
    costMaxCad: 40,
    statusState: 'confirmed',
    confidenceLabel: 'official_recent',
    lastCheckedAtUtc: '2026-07-12T00:00:00Z',
    ageBandMatches: ['under2', '2-4', '5-9', '10-14', '15+'],
    ageMinMonths: 0,
    ageMaxMonths: null,
    geo: P.stanleyPark,
    municipalityId: REGION_IDS.vancouver,
  }),

  // --- expected/seasonal (out of season in July) → separate broadening section ---
  makeListing({
    id: 'l-toboggan-seasonal',
    activityName: 'Tobogganing Hill',
    primaryCategoryKey: 'tobogganing',
    venueName: 'Mount Seymour',
    descriptionSnippet: 'Winter tobogganing and snow tubing.',
    suitabilityTags: ['outdoor'],
    costStatus: 'unknown',
    statusState: 'seasonal_out_of_season',
    confidenceLabel: 'inferred',
    lastCheckedAtUtc: '2026-05-01T00:00:00Z',
    ageBandMatches: ['2-4', '5-9', '10-14', '15+'],
    ageMinMonths: 24,
    ageMaxMonths: null,
    geo: P.northShoreMtn,
    municipalityId: REGION_IDS.northVan,
  }),

  // --- hidden (never surfaced) ---
  makeListing({
    id: 'l-cancelled-gym',
    activityName: 'Cancelled Gym Session',
    primaryCategoryKey: 'open_gym',
    venueName: 'Britannia Community Centre',
    suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-13T18:00:00Z',
    endDatetimeUtc: '2026-07-13T20:00:00Z',
    costStatus: 'free',
    statusState: 'cancelled',
    confidenceLabel: 'official',
    lastCheckedAtUtc: '2026-07-12T00:00:00Z',
    ageBandMatches: ['under2', '2-4', '5-9'],
    ageMinMonths: 0,
    ageMaxMonths: 120,
    geo: P.eastVan,
    municipalityId: REGION_IDS.vancouver,
    displayArea: REGION_IDS.vanEast,
  }),
];
