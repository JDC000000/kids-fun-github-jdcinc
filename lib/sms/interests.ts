// lib/sms/interests.ts — the optional interest checkboxes on the SMS signup form.
//
// DRAFT (SMS pivot). Pure data + one predicate.
//
// THE VOCABULARY IS THE CATALOGUE'S OWN, not a new one. Every key below is a `category.key` from
// supabase/seeds/categories_tags.sql, which is what `ListingRecord.primaryCategoryKey` and
// `categoryTags` actually hold — so `matchesInterests` (lib/sms/weekly-picks.ts) compares like
// with like. A friendlier parallel vocabulary here would have to be mapped to those keys
// somewhere, and that mapping is exactly the thing that goes stale when the taxonomy is seeded
// with a new category.
//
// The LABELS are the seed's labels, lightly reworded for a parent filling in a form rather than
// an admin reading a taxonomy. Labels are display-only and may drift; the KEYS may not.
//
// ── TWO DELIBERATE OMISSIONS FROM THE SEEDED LIST ────────────────────────────────────────
//
// 1. `class_program` ("Class / Program") IS OMITTED, and this is the interesting one. The
//    selection module inherits the engine's `includeRegistration: false` default, so titles
//    reading as classes, lessons, camps, courses or workshops are dropped before the interest
//    filter ever runs (lib/search/filters/registration.ts). Offering "Classes & programs" as an
//    interest would therefore offer a box that is close to unmatchable — a parent ticks it, the
//    filter narrows to a category the pipeline has already excluded, and the most likely outcome
//    is the interest-drop retry firing every single week for them.
//    THIS IS DOWNSTREAM OF PRD §8, WHICH IS STILL OPEN. If Jon decides registration-required
//    activities should be included in the SMS, this key should be added back — it is one line,
//    and this comment is the reason it is not here today.
//
// 2. `miniature_train` and `tobogganing` are omitted because the seed marks them
//    `is_primary_eligible = false` — they are secondary tags, not things a listing is primarily
//    about. `matchesInterests` does read `categoryTags`, so ticking one WOULD match; they are
//    left off for form length and because a seasonal tobogganing box in August is a worse
//    experience than no box. Not a technical constraint — a judgement, recorded as one.

/** One interest checkbox. `key` is a real `category.key`; `label` is display-only. */
export interface SmsInterestOption {
  key: string;
  label: string;
}

/** The checkboxes, in the order the form renders them. */
export const SMS_INTEREST_OPTIONS: readonly SmsInterestOption[] = [
  { key: 'public_swim', label: 'Swimming' },
  { key: 'skate', label: 'Skating' },
  { key: 'open_gym', label: 'Open gym & drop-in sports' },
  { key: 'indoor_play', label: 'Indoor play' },
  { key: 'storytime', label: 'Storytime & libraries' },
  { key: 'outdoor_park', label: 'Parks, nature & farms' },
  { key: 'museum_venue', label: 'Museums & cultural venues' },
  { key: 'attraction', label: 'Attractions' },
  { key: 'festival_event', label: 'Festivals & one-off events' },
] as const;

/** The accepted keys — the allowlist the API route validates a submission against. */
export const SMS_INTEREST_KEYS: readonly string[] = SMS_INTEREST_OPTIONS.map((o) => o.key);

/** Is this a key the form could actually have offered? */
export function isKnownInterestKey(key: string): boolean {
  return SMS_INTEREST_KEYS.includes(key);
}
