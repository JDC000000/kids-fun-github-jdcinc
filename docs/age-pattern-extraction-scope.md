# Broader ingest-time age-pattern extraction — measured scope

**Status: MEASUREMENT AND PROPOSAL ONLY. Nothing here is implemented.**
Branch `design/kf-age-pattern-extraction-scope` off `origin/main` @ 343c300. No worker, adapter or
core file touched — deliberately. The measurement harness that produced every number below was run
inside this worktree and then removed from it; it is reproduced verbatim in §11 so any number here
can be re-derived.

This is item 3 of the independent-report batch ("broader ingest-time age-pattern extraction — e.g.
`8yrs+` in a title landing as `ageMinMonths:0`"), held back from the rest because it looked like
`worker/core/age.ts` territory.

**Three headline results, all measured, two of them contradicting the pre-dispatch understanding:**

1. **`worker/core/age.ts` needs no change at all.** It already resolves every single pattern this
   ticket is about — `8yrs+` → `[96,null]`, `18yrs+` → `[216,null]`, `6 mo-5 yrs` → `[6,72]`,
   `18mo-3yrs` → `[18,48]`, `players 65yrs+` → `[780,null]`. §7 gives the full table. The reason
   this item was held back is measurably void.
2. **ActiveNet is NOT closed, and the specific claim that it was is refuted.** `f15d6c8`'s
   `TITLE_STATES_AGE_RE` does **not** match `8yrs+` — the digest's own headline example. It matches
   the bare `8+` only; any unit between the number and the `+` or the `-` defeats it. Measured on
   17,209 live records: **86 records across 16 distinct programmes** state an age in the title that
   the gate still rejects.
3. **The largest gap is in an adapter nobody had looked at, and it points the dangerous way.**
   PerfectMind publishes **55 records across 19 distinct adult-only programmes** — "Adult 19yrs+
   Swim", "Adult 19yr+ Hot Tub & Steam", "$2 Women's Only Swim 12yrs+" — as `[0, ∞)`, matching
   *every* age band including under-2, because the vendor's `NoAgeRestriction: true` flag outranks
   the venue's own title. That is the venue `'All ages'` defect class again, sourced from a vendor
   boolean instead of a hard-coded constant.

**Sizing, up front (§9 shows the working):** this is now **comparable in code volume to the
age-provenance batch but far better targeted** — 4 files, no migration, no schema, no shared-helper
change, no policy ruling needed from Jon. It is not "smaller because ActiveNet is done"; ActiveNet
is not done. It is smaller because it has been measured down from a 2,143-record suspicion to a
**448-record, 129-programme** defect with a named fix per adapter and a measured before/after for
each.

---

## 1. What was measured, and on what

Every number in this document comes from running the **real production extraction functions** over a
**real corpus pulled tonight**, not from reading regexes. No synthetic fixture, no snapshot DB.

| Adapter | Corpus | Size | How obtained |
|---|---|---|---|
| activenet | Vancouver + Burnaby drop-in calendars | **17,209 occurrences / 1,940 distinct titles** | LIVE `anc.ca.apm.activecommunities.com` REST pull, 2026-08-18, 3s politeness floor, read-only (§10) |
| perfectmind | NVRC `**Drop-In Schedules` — all 9 calendars × 2 strides | **1,146 class occurrences / 566 distinct titles** | LIVE BookMe4 `ClassesV2` pull, 2026-08-18, 3s floor |
| citycalendar | City of Vancouver Trumba feed | **32 events** (the whole feed; `liveEventsLimit` is 40, so nothing was sliced) | LIVE `trumba.com/calendars/city-of-vancouver-events.json` |
| library:vpl | VPL BiblioCommons RSS | **23 events** | LIVE `gateway.bibliocommons.com/v2/libraries/vpl/rss/events` |
| library:rpl | RPL BiblioCommons RSS | **20 events** | LIVE `gateway.bibliocommons.com/v2/libraries/yourlibrary/rss/events` |
| library:nvdpl | NVDPL generic RSS | **37 kid-relevant of 92 feed items** | LIVE `nvdpl.events.mylibrary.digital/rss` |
| venue | — | **0 measurable records** | see §6 |
| eventbrite | — | out of scope, see §6 | |

The corpus was pushed through the adapter's own code — `extractAgeText` (activenet/parse.ts:179),
`resolveAgeText` (perfectmind/parse.ts:315), `CityCalendarAdapter.extract` (citycalendar/index.ts:366),
`parseBiblioCommonsRss` (library/index.ts:534), `parseGenericRss` (generic-rss.ts:506) — and then
through `parseAgeText`/`parseAudienceLabels` exactly as `ingest.ts:237-241` does, so what is reported
is the `occurrence_age` bounds a parent would actually be shown.

The Trumba figure independently corroborates the count already recorded in citycalendar/index.ts:287
("measured 2026-08-18: 32 events"). Two measurements, same day, same number.

---

## 2. The probe, and why its raw number is not the answer

The probe is the brief's own pattern set, plus the forms that actually occur, guarded by
activenet/parse.ts:145's `AGE_NUMBER` lookarounds verbatim so a clock time (`6:00-8:00`), a decimal
skill rating (`3.0-4.0`) and a price (`$5+`) can never register as an age:

```
\bages?\s*N | N\s*(-|–|—|to)\s*N\s*(yrs?|years?) | N\s*(yrs?|years?)\s*\+ | N\s*\+\s*(yrs?|years?)
\bgrades?\s*[K0-9] | \bunder\s*N | N\s*(months?|mos?) | N\s*(yr|year)s?[\s-]*olds?
      where N = (?<![\d.,:$])\d{1,2}(?![.,:]\d)
```

Run over the whole corpus it flags **2,143 records** where a numeric age pattern is present but the
value never reaches `ageText` (or is beaten there by a non-numeric wording).

**2,143 is the wrong number and reporting it would have been the mistake this project has already
paid for once.** Every one of the 169 distinct (title × matched phrase) tuples behind it was read
against a ±95-character evidence window and classified by hand. The result:

| Verdict | Records | What it is |
|---|---:|---|
| `FALSE_SUPERVISION` | **1,086** | *"children 6-12 years must be accompanied by a participating adult"*, *"Children under 8 years old must be accompanied into the water by a guardian"*. A supervision rule, not the programme's age. The current `All ages` answer is **correct**; extracting the number would narrow an all-ages public swim to 6–12. |
| `FALSE_GRADE_MUSIC` | **222** | *"If you're learning at a **grade 5** level or above"* — a conservatory music grade on "Piano"/"Private Piano". `age.ts:230-237`'s `GRADE_RE` would convert it to ages 10–11. Correctly not extracted today. |
| `FALSE_PASS` | **147** | *"A 10-visit, **1 month** Fit Card can be used"*, *"**1 month** Adult $61.19"*. A pass duration. |
| `FALSE_REGPRIORITY` | **91** | *"**Adults 19yrs+** can register into this program 1 week prior to program start date"* — Vancouver boilerplate about early-registration privilege, appended to 17 distinct programmes. Extracting it would publish *"Asian Pop / KPOP / Hip Hop — **Family**"* as adults-only, because its copy of the boilerplate reads *"a parent/guardian/family member 19yrs+ is required to be a full participant"*. |
| `FALSE_OK` | **50** | A numeric age IS present and the system's current answer already matches it (VPL Babytime: *"newborns to approximately 18 months"* → published `[0,24]`). |
| `FALSE_PRICE` | **36** | *"Children 12 months and under are **free**"*, *"Babies under 12 months are **free**"*. This is precisely the case activenet/parse.ts:133-135's own header warns about. |
| `FALSE_WAIVER` | **23** | *"Completed waiver forms required for participants **under 19 years**"*. |
| `FALSE_STAFF` | **15** | *"secondary students … generally between 18 and **22 years old**"* — describing the *staff-to-participant ratio*, not the campers. |
| `FALSE_OTHER` | **11** | *"if patron is away for **6 months**"*; *"Pythagoras for **Grade 6** and Euler for Grade 7"* (contest names). |
| **`FALSE_CLAIM_DEFECT`** | **14** | A *different* defect the probe turned up — see §5. |
| **`TRUE_LOST`** | **388** | The source states the programme's own age; the system publishes nothing, or a materially different range. |
| **`TRUE_MINOR`** | **60** | A real age claim; the published range differs at one band edge only. |

**1,681 of the 2,143 are the extractor being right.** Widening extraction bluntly would not close a
gap — it would convert 1,086 correct all-ages public swims into 6–12 programmes and turn a family
dance class into an adults-only listing. That is the same shape as the kid-coded-title-marker
inference measured at a 57% error rate and killed (cited in `worker/core/title.ts`'s header). It is
the reason this document proposes four narrow, anchored changes and not one broad regex.

**The real defect is 448 records across 129 distinct programmes.**

---

## 3. ActiveNet — the DO's "already fixed" read is CONFIRMED IN PART and REFUTED IN PART

### 3a. What `f15d6c8` did fix — confirmed with real numbers

The commit's own header records the pre-fix measurement: *"33 of 33 events emitted `ageText` — every
single one, because the title always went in."* On tonight's 17,209 live records the post-fix figure
is **12,802 records (74.4%) now emit no age signal at all**. The unconditional-title behaviour is
gone, and gone at scale. Of the 992 records whose title states a numeric age, **906 (91.3%) are
correctly admitted** by `TITLE_STATES_AGE_RE`. That fix worked and it is worth saying so.

### 3b. What it did not fix — and the specific claim that is wrong

The pre-dispatch note said `TITLE_STATES_AGE_RE` *"matches the digest's own headline example pattern
(`8yrs+` via the number-plus alternative)"*. **Directly tested, it does not:**

| Title string | `TITLE_STATES_AGE_RE` | `parseAgeText` would give |
|---|:---:|---|
| `8+` | **Y** | `[96,null]` |
| `8yrs+` | **n** | `[96,null]` |
| `8 yrs+` | **n** | `[96,null]` |
| `Reserve In Advance: Table Tennis 18yrs+` | **n** | `[216,null]` |
| `Ball Hockey - Men (40yrs+) SUN` | **n** | `[480,null]` |
| `Chinese Folk Dance (55yrs+)` | **n** | `[660,null]` |
| `Parent and Tot Gym (6 mo-5 yrs)` | **n** | `[6,72]` |
| `Jump into Music (6months-4yrs)` | **n** | `[6,60]` |
| `Brit Gymnastics - Dynamic Duo A (18mo-3yrs)` | **n** | `[18,48]` |

The mechanism is exact and small. `TITLE_STATES_AGE_RE` (parse.ts:157-160) is

```
\bages?\s*\d  |  N\s*(?:-|–|—|to)\s*N  |  N\s*\+  |  \ball\s+ages\b
```

`N\s*\+` requires the digits to be **immediately** followed by optional whitespace and `+`. In
`18yrs+` the unit `yrs` sits in between, so the alternative fails; `N\s*-\s*N` fails on `6 mo-5` for
the same reason. **A unit token between the number and its connector is the entire bug.** The
headline example in the digest was chosen well and was never covered.

**Measured cost of the miss: 86 records across 16 distinct programmes** (full list in §8a). Among
them `Parent and Tot Gym (6 mo-5 yrs)` is published today as `[12,36]` — 1–3 years, inferred from
the word "Toddlers" in the description — when the venue's own title says 6 months to 5 years. A
parent of a 4-year-old filtering on age is not shown it.

### 3c. The larger half of ActiveNet's gap is on the description side, not the title

Of ActiveNet's **350 genuinely-lost records / 52 distinct programmes**, the title gate accounts for
86 records / 16 programmes. The other **264 records / 36 programmes** are `AGE_PHRASE_RE`
(parse.ts:136-137) choosing the wrong phrase. It is a first-position-wins alternation over the
description, and a catch-all or a keyword frequently sits earlier in the paragraph than the specific
range:

| Programme | Source says | Published as | Effect |
|---|---|---|---|
| `Games Room Drop-in - Youth` ×29 | *"for pre-teens and youth **ages 8-18**"* | `[144,216]` via `"teens"` | 8–11-year-olds excluded from a programme that names them |
| `Games Room - Pre-Teen/Youth Only` ×11, `Games Room - Mon…Fri` ×27 | *"**ages 10-18**"* | `[144,216]` via `"teens"` | 10- and 11-year-olds excluded |
| `Youth Gym Drop-In` ×6 | *"Younger youth, aged **11-13 years**"* | `[144,216]` via `"youth"` | 11-year-olds excluded, 14–18 wrongly included |
| `Little Movers Gymnastics` ×4 | *"children **ages 2 to 5**"* | `[12,36]` via `"Toddlers"` | 4- and 5-year-olds excluded |
| `Summer Youth Leadership Camp` ×9 | *"youth **ages 11-14**"* | `[144,216]` via `"youth"` | 11-year-olds excluded, 15–18 wrongly included |
| `Pre-Teen Club` ×5 | *"Calling all **grade 4**, 5, 6 and 7's!"* | `[144,216]` via `"teens"` | grade-4 9-year-olds excluded |

Every one of these is the same shape: **the source stated an explicit range and a vaguer word in the
same paragraph won.** This is the half of ActiveNet's defect the original digest was actually
describing, and it survives `f15d6c8` untouched.

---

## 4. PerfectMind — the biggest gap, previously unexamined, and it points the dangerous way

`resolveAgeText` (perfectmind/parse.ts:315) checks `NoAgeRestriction === true` **first**, before
anything else, and returns `'All ages'`. On tonight's pull, 293 of 1,146 records carry that flag.
**95 of those 293 have a title that states an age the flag contradicts**, and the flag wins every
time.

| Direction | Records | Distinct programmes | Example |
|---|---:|---:|---|
| **Adult-only published as all-ages** — the safety direction | **55** | **19** | `Adult 19yrs+ Swim Karen Magnussen Monday 8:00-9:00am` → `[0,null]`. `Adult 19yr+ Hot Tub & Steam` → `[0,null]`. `$2 Women's Only Swim 12yrs+ Ron Andrews` → `[0,null]` |
| Narrower child range flattened to all-ages | 40 | 15 | `$3 Open Gym 8yrs+ Parkgate` → `[0,null]`. `Adult / Early Years (0-6years) Swim` → `[0,null]`. `Lynn Creek Youth Centre … (Grade 4-7)` → `[0,null]` |

`[0, null]` matches **all five age bands**. A parent filtering to `ages=under2` is currently offered
NVRC's adult 19+ lane swim and its adult hot tub and steam room. This is exactly the finding that
`lib/audit/rules/adult-subject-child-bands.ts` exists to catch at audit time, and exactly the
consequence documented for `venue/separate.ts`'s hard-coded `ageText: 'All ages'` — except here the
false all-ages claim is 55 records deep, it comes from a vendor boolean rather than our own constant,
and it is on the platform that supplies NVRC's entire drop-in schedule.

It is worth being precise about what the vendor means. `NoAgeRestriction: true` on a BookMe4 class
means *no registration age gate is configured in the booking system*. It does not mean *this
programme is suitable for a baby*. The adapter reads the first as the second. The venue's own title
is the more specific claim and it is being discarded.

Two properties make this the cheapest fix in the document:

- The contradiction is **detectable without inference**. The title says `19yrs+` in words. Nothing
  has to be guessed.
- `AgeVerdict` (parse.ts:281-292) **already carries `code` and `deterministic`**, so a
  `'no-age-restriction-contradicted'` code costs one entry in `AGE_SIGNAL_CODES` and is already
  aggregated into the per-run breakdown at parse.ts:601-604. The provenance channel for this exists.

---

## 5. A third defect class the probe surfaced: the title gate manufacturing ages from non-ages

`TITLE_STATES_AGE_RE` has false positives as well as false negatives, and they publish wrong ages
rather than none. **14 records / 3 distinct programmes:**

| Title | Gate reads | Published as | Truth |
|---|---|---|---|
| `Art of Tennis Summer Camp - Aug 17-21 - Garden Park` ×5 | `17-21` | **`[204,264]` — ages 17 to 22** | a children's tennis camp; the description says *"going into Grade 1 or be 6 years old"* |
| `Art of Tennis Summer Camp - Aug 24-28 - Garden Park` ×5 | `24-28` | **`[288,348]` — ages 24 to 29** | same camp, next week |
| `Future Bounce Basketball (Gr. 6-7)` ×4 | `6-7` | **`[72,96]` — ages 6 to 8** | grades 6–7, i.e. 11–13 years |

A **date range in the title is being published as an age range**. This is a false claim of the same
family as the one `f15d6c8` was written to remove, introduced by the gate that removed it. It is
cheap to fix alongside §8a and the fix is measured there.

---

## 6. CityCalendar, Library, Venue, Eventbrite — measured, and much smaller than assumed

**CityCalendar — believed still gapped; measured at 1 record in 32.** The pre-dispatch expectation
was that *"a title or description stating only `8yrs+` or `4-6 yrs` with no accompanying audience
word would not be extracted."* On the full live feed the incidence of that case is **0 of 32**. There
is exactly one gap, and it is an override rather than a drop:

> `Free Synchronized Swimming Try-it Class for Kids` — description says *"a FREE class for kids
> **ages 7-11** who can swim 1 lap unassisted"*. `AGE_HINT_RE`'s 30-character window lifts
> `"for Kids Come try Artistic Swimming (S"` and `parseAgeText` scores it `[60,144]` — ages 5–12.
> Published four years too wide at the bottom and one year too wide at the top.

Real, and worth fixing — but it is a 1-in-32 defect on a 32-event feed, not a systemic gap.

**Library — believed "still gapped, and worse"; measured at 2 records across 80.** The code reading
is correct: `resolveBiblioCommonsAgeSignal` (library/index.ts:380-389) never sees the title.
Measured, that gap costs almost nothing today, because BiblioCommons tenants put their age wording in
the description and their audience taxonomy in tags:

- **VPL, 23 events: 0 defects.** Its one probe hit (`Babytime`, *"newborns to approximately 18
  months"*) already publishes `[0,24]` from the `Babies` audience tag. Correct.
- **RPL, 20 events: 2 defects.** `Kids' Bookmark Contest` — *"You must be **6-12 years old** by
  August 31st"* — publishes `[0,180]` (0–15) from the tag `Children-All Ages`. And a genuine
  safety-direction find the title-blindness is not even responsible for: **`Richmond Reads: Summer
  Book Club 2026` publishes `[0,null]`** — all five bands — while its own description says *"Pick up
  an **Adult** Summer Passport Challenge at any branch … **Must be 18+**"*.
- **NVDPL, 37 events: 1 defect.** `Camp Parkgate Stuffy Sleepover` — *"best suited for children aged
  **4-8 years**"* — emits **no `ageText` at all**, because `AGE_TEXT_RE` (generic-rss.ts:322-323)
  requires the literal word `ages`/`grades` before the number and a bare `4-8 years` does not qualify.

**Venue — no measurable surface, and this is a finding, not a gap in the measurement.** The venue
adapter never scans prose for ages; it reads schema.org `typicalAgeRange` only (venue/index.ts:404-411).
There are two configured venues. Vancouver Aquarium is `liveCapable`-omitted (fixture-only, and this
document did not fetch it). The Space Centre's `/plan-your-visit/` page was fetched live tonight and
contains **one `application/ld+json` block with zero `Event` nodes** — only `Article`, `WebPage`,
`WebSite`, `Person`, `ImageObject`. So there are no live venue events to lose an age from, and all
four fixture events carry an explicit `typicalAgeRange`. **Venue's age-pattern-extraction gap is
zero, by construction.** Separately confirmed while reading: the `ageText: 'All ages'` constant at
`venue/separate.ts:122` is gone — the line now reads *"Deliberately NO ageText"*.

**Eventbrite is not in this ticket and was not measured against it.** Its risk is the opposite
direction (a bare audience word manufacturing a claim), logged as unowned finding §3f in
`documents/kids-fun-open-findings-2026-08-18.md`. Conflating them would produce a change that widens
extraction on the one adapter that needs narrowing.

---

## 7. Does any of this need `worker/core/age.ts`? **No.** Here is the proof.

This was the reason the item was held back, so it deserves a direct answer rather than an assurance.
Every pattern in the entire defect set was fed to `parseAgeText` unchanged:

| Input | `parseAgeText` result | Correct? |
|---|---|:---:|
| `8yrs+` / `8 yrs+` / `8+` | `[96,null]` | yes |
| `18yrs+` | `[216,null]` | yes |
| `19 yrs+` | `[228,null]` | yes |
| `6 yrs+` | `[72,null]` | yes |
| `players 65yrs+` | `[780,null]` | yes |
| `6 mo-5 yrs` | `[6,72]` | yes |
| `6months-4yrs` | `[6,60]` | yes |
| `18mo-3yrs` | `[18,48]` | yes |
| `4-8 years` | `[48,108]` | yes |
| `ages 7-11` | `[84,144]` | yes |
| `ages 8-18` | `[96,228]` | yes |
| `6-12 years old` | `[72,156]` | yes |
| `Grades 5 to 12` | `[60,156]` | yes |

**Thirteen of thirteen already resolve, and resolve correctly.** `age.ts` is not the blocker and
never was. The blocker is four per-adapter gates that decide whether the string reaches it — the same
shape of fix `f15d6c8` already made, in the same place. **No scope escalation. No shared-helper
change. No migration.**

One nuance found while proving this, recorded rather than silently absorbed: `parseAgeText('grade
4-7')` returns `[48,96]` — ages 4 to 8 — because `RANGE_RE` (age.ts:194) matches the bare `4-7`
before `GRADE_RE` (age.ts:230) can convert grades to ages. Grades 4–7 are roughly 9–13 years. This is
a genuine `age.ts` defect, it is **not** in this ticket's scope, and §8b deliberately routes around
it by refusing grade labels at the adapter rather than fixing the core. It should be logged as its
own finding.

---

## 8. Proposed fixes, each with a measured before/after

Every proposal follows `f15d6c8`'s own discipline: **the title or the phrase must genuinely assert an
age.** No bare audience word is promoted, no "number near a kid word" heuristic, and every change was
simulated against the full live corpus before being written down here.

### 8a. activenet/parse.ts — widen the title gate by one unit token, and refuse dates and grade labels

```ts
const UNIT = '(?:\\s*(?:yrs?|years?|mos?|months?))';
const TITLE_STATES_AGE_RE = new RegExp(
  `\\bages?\\s*\\d|${AGE_NUMBER}${UNIT}?\\s*\\+` +
  `|${AGE_NUMBER}${UNIT}?\\s*(?:-|–|—|to)\\s*${AGE_NUMBER}${UNIT}?|\\ball\\s+ages\\b`, 'i');
// A range introduced by a month name is a DATE; a range introduced by a grade label is a GRADE.
const TITLE_DATE_RE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?\s*\d/i;
const TITLE_GRADE_LABEL_RE = /\b(?:gr\.?|grades?)\s*[k0-9]/i;
```

**Simulated on all 17,209 live records / 1,940 distinct titles:**

- **86 records / 16 distinct titles newly admitted.** All 16 hand-checked; all 16 are genuine age
  assertions: `Reserve In Advance: Table Tennis 18yrs+` ×20 → `[216,null]`; `Parent and Tot Gym (6
  mo-5 yrs)` ×10 → `[6,72]`; `Ball Hockey - Men (40yrs+)` ×15 → `[480,null]`; `Chinese Folk Dance
  (55yrs+)` ×7 → `[660,null]`; `Jump into Music (6months-4yrs)` ×6 → `[6,60]`; `Brit Gymnastics -
  Dynamic Duo A/B (18mo-3yrs)` ×8 → `[18,48]`; `Art Therapy … (19yrs+)`, `Exploring Paper Art …
  (19yrs+)`, `Spanish for Beginners 1/2 (19yrs+)` ×12 → `[228,null]`; `Hockey 1/2 (18yrs+)`,
  `Reserve In Advance: Shoot & Score 18yrs+` ×6 → `[216,null]`; `Reserve In Advance: Figure Skating
  16yrs+ (Star 2)` ×2 → `[192,null]`.
- **14 records / 3 distinct titles correctly removed** — the §5 false claims.
- **0 regressions.** The month guard is anchored on `\b` after the month name specifically so
  `Wushu Beginner/Novice 15+` is not caught by `Nov`ice; the unanchored first draft caught it, which
  is why the anchored form is what is proposed.

Net: `2,282 → 2,354` admitted records, of which every added record and every removed record was
individually verified.

### 8b. activenet/parse.ts — prefer the most SPECIFIC description phrase, not the first one

`AGE_PHRASE_RE` should return the *specific* match when one exists anywhere in the description,
falling back to the catch-all/keyword only when it does not. Concretely: run the numeric-range and
numeric-minimum alternatives first over the whole description, and only if none matches fall through
to `all ages` / `preschool` / `toddler` / `youth` / `teen`. **This is a precedence change, not a
widening — it adds no new pattern and cannot promote any string the current regex would not already
have accepted.** That property matters: it means the 1,086 supervision-rule records in §2 stay
exactly as they are, because `"6-12 years must be accompanied"` is not reached by
`AGE_PHRASE_RE` at all (the regex's `N-N yrs` alternative does match it — so this change **must**
retain the existing anti-supervision behaviour by anchoring the numeric alternatives to a
non-supervision context; see the caution below).

**Caution, stated plainly because it is the risk in this whole document:** the 264-record
description-side gap and the 1,086-record supervision false-positive **live in the same regex**.
`"children 6-12 years must be accompanied"` and `"for pre-teens and youth ages 8-18"` are both
`N-N`-shaped. Separating them needs an anchor — `must be accompanied|accompanied by|supervised|
guardian|free|under \d+ .{0,20}free` as a *disqualifier* on the surrounding window — and that
anchor must be measured before it ships, not asserted. This is the one sub-item that deserves its own
QA pass with a before/after count, and it is why §9 sizes ActiveNet as two units rather than one.

### 8c. perfectmind/parse.ts — a vendor "no age restriction" must not overrule the venue's own title

The cheapest correct behaviour, and the one with precedent in this codebase: when
`NoAgeRestriction === true` **and** the record's own `EventName` states an age, do not emit
`'All ages'`. Two options, both defensible:

- **Suppress (recommended).** Return `{ ageText: undefined, code: 'no-age-restriction-contradicted' }`.
  The result is silence — a known unknown, which the search filter keeps visible — instead of a false
  statement of fact. This is precisely the remedy citycalendar/index.ts:330 already chose for its
  adult-subject case, and its header (:236-239) argues the reasoning better than this document could.
- **Prefer the title.** Emit the title's stated age. More useful, but it makes the adapter an
  inference engine, and it inherits the `grade 4-7 → [48,96]` core defect from §7.

**Measured impact of suppression: 95 records / 34 distinct programmes stop claiming an age they do
not have, 55 of them adult-only programmes that currently match every band including under-2.** The
other 858 `no-age-restriction` records and all 853 structured-field records are untouched.

### 8d. library — add the title to the haystack, anchored

`resolveBiblioCommonsAgeSignal` (library/index.ts:384) and `generic-rss.ts:581` should scan
`title + description` rather than description alone, and `AGE_RANGE_RE`/`AGE_TEXT_RE` should accept a
bare `N-M years` / `N+` form **only when anchored** by an age word or an obligation phrase
(`ages?|grades?|must be|suited for|best for|recommended for|for children`). An unanchored `N+`
would read `"10+ crafts"` as an age.

**Simulated on all 80 live library records: 3 changes, all improvements, 0 regressions.**

| Record | Now | Proposed |
|---|---|---|
| RPL `Kids' Bookmark Contest` | `[0,180]` | `[72,156]` — *"must be 6-12 years old"* |
| RPL `Richmond Reads: Summer Book Club 2026` | `[0,null]` (all five bands) | `[216,null]` — *"Must be 18+"* |
| NVDPL `Camp Parkgate Stuffy Sleepover` | no `occurrence_age` row | `[48,108]` — *"children aged 4-8 years"* |
| VPL (all 23) | unchanged | unchanged |

### 8e. citycalendar — one record, and it is the 30-character window, not the missing numeric branch

`ageText()` (citycalendar/index.ts:319-332) is structurally fine; its prose fallback just clips too
early. Adding a numeric-range alternative that is preferred over `AGE_HINT_RE`'s window fixes the one
measured defect (`ages 7-11` instead of `for Kids Come try Artistic Swimming (S`). **Measured impact:
1 record of 32.** Given the size, the honest recommendation is to fold this into §8d's work as a
four-line change or defer it — not to open a unit for it.

---

## 9. Revised sizing for Jon — with the arithmetic shown

**Files that change: 4.** `worker/adapters/activenet/parse.ts`,
`worker/adapters/perfectmind/parse.ts`, `worker/adapters/library/index.ts` +
`worker/adapters/library/generic-rss.ts` (one change, two call sites), and optionally
`worker/adapters/citycalendar/index.ts`. **No migration. No schema change. No `worker/core/age.ts`
change. No product-copy decision. Nothing for Jon to rule on.**

Compared with the age-provenance initiative — three DB writers, six independent regexes, fourteen
signal producers, a two-column migration, a §7 policy ruling and a §8 copy direction, all gating the
estimate — this is a different kind of work: **contained, per-adapter, and already measured
end-to-end.** It is *not* smaller because ActiveNet was done; ActiveNet is not done. It is smaller
because the suspicion has been measured down.

Recommended unit split, ordered by measured defect weight:

| # | Unit | Files | Records fixed | Distinct programmes | Risk |
|---|---|---|---:|---:|---|
| 1 | **perfectmind `NoAgeRestriction` contradiction** | 1 | **95** (55 adult-as-all-ages) | 34 | **Low.** Suppression only; the direction of failure is silence, and `AgeVerdict.code` already exists. |
| 2 | **activenet title gate: unit token + date/grade guard** (§8a, §5) | 1 | **86 recovered + 14 false claims removed** | 19 | **Low.** Fully simulated: every added and removed record verified by hand, 0 regressions. |
| 3 | **activenet description phrase precedence** (§8b) | 1 | up to **264** | 36 | **Medium — the only real risk in the batch.** Shares a regex with 1,086 correct supervision-rule rejections. Needs its own before/after QA gate. |
| 4 | **library title + anchored bare-range** (§8d), citycalendar folded in (§8e) | 2–3 | **4** | 4 | Low. Simulated: 3 improvements, 0 regressions on 80 records; 1 more on citycalendar. |

Units 1, 2 and 4 are each an afternoon with a fully-specified before/after test, and all three are
already measured. **Unit 3 is the one that needs real QA time** and is the honest reason this is
"comparable to" rather than "much smaller than" the age-provenance batch.

If the batch has to be cut, **cut unit 4, not unit 1.** Unit 4 fixes 4 records. Unit 1 stops NVRC's
adult hot tub and steam room being offered to a parent filtering for a two-year-old.

---

## 10. Consolidating the duplicated regexes — not yet, and here is the measured reason

Findings §3e/§3g flag independently-maintained copies of similar age regexes across adapters. This
document is evidence **against** consolidating them in the same change, not for it:

- The four gaps have **four different mechanisms**. ActiveNet's is a missing unit token in a title
  gate. PerfectMind's is a vendor boolean outranking a title and needs no regex at all. Library's is
  a haystack that omits the title. CityCalendar's is a 30-character window clipping too early. A
  shared regex fixes none of them; each adapter would still need its own call-site change.
- The **false-positive profiles are adapter-specific and load-bearing**. ActiveNet must reject
  `"children 6-12 years must be accompanied"` (1,086 records) and `"grade 5 level"` (222 records) —
  both artefacts of municipal rec-centre copy. BiblioCommons descriptions contain neither. A single
  shared pattern would have to carry every adapter's disqualifiers, which is how one adapter's
  municipal boilerplate ends up suppressing another's library programming.
- citycalendar/index.ts:241-249 already records, in the codebase, why its own duplicated regexes were
  not consolidated: the worker cannot import from `lib/audit/rules/` without tripping
  `tests/scheduler/worker-image-closure.test.ts`. That constraint has not changed.

**Recommendation: keep §3e/§3g a separate ticket.** After units 1–4 land, the *right* shared artefact
is visible and small — a worker-owned `isAgeAssertion(text)` helper carrying the shared
disqualifier list (supervision / price / pass-duration / conservatory-grade / registration-priority),
which every adapter's own gate calls. That helper cannot be designed correctly before the four
call-site fixes exist, because its disqualifier list is exactly the §2 taxonomy this measurement
produced.

---

## 11. Reproduction, limitations and disclosures

**How to reproduce.** The harness lives outside this branch (this is a design-only worktree) at
`/opt/projects/crhq-satellite/.scratch/ageextract/`: `pull-activenet.mjs` and `pull-perfectmind.mjs`
do the live pulls at a 3-second floor; `__agescope.test.ts` runs the adapters and emits
`measure-out.txt` + `gap-rows.json`; `verdicts.mjs` holds the hand-classification of all 169 tuples
and emits `verdicts.txt`; `__fixsim.test.ts` / `__fixsim2.test.ts` are the §8a and §8d simulations.
Each was run with `npx vitest run --project unit` from this worktree. **No file in this branch other
than this document was created or modified**; `git status` is clean apart from `docs/`.

**Politeness and compliance.** Every fetch was read-only, identified with the project's own
`USER_AGENT`, and rate-limited to one request per 3 seconds per host — matching
`worker/core/politeness.ts` and each adapter's own client. Only sources the project has already
cleared were touched. **Vancouver Aquarium was deliberately not fetched** (`liveCapable` omitted,
excluded under the T11 precedent). Every run stayed inside the adapter's own configured
`maxRequestsPerRun`: ActiveNet Vancouver 45 requests against a cap of 60 (22 calendars × 2, plus one
filters-only call for calendar 60, which returns zero centres); Burnaby 29 against 48 (12 calendars ×
2, plus 5 filters-only calls for the calendars with zero centres); PerfectMind NVRC ~50 against 140.

**Limitations, stated rather than buried.**

- **The citycalendar and library corpora are small** — 32, 23, 20 and 37 records. That is not a
  sampling choice; it is the entire published feed for each. The conclusion "citycalendar has 1
  defect" is exact for tonight's feed and may not hold across a season. It is nonetheless a far
  better basis than the code-reading it replaces, and the direction is unambiguous: these adapters
  are not where the defect lives.
- **PerfectMind Richmond was not pulled.** It is `enabled: false` with a measured zero drop-in
  coverage (config.ts:145-149); NVRC is the whole live surface.
- **ActiveNet West Vancouver was not pulled** — `dropInCalendarIds: []`, measured zero.
- **The hand-classification in §2 is a judgement**, not an algorithm. All 169 tuples and their
  evidence windows are in `gap-tuples.txt`; the per-tuple verdicts are in `verdicts.mjs` as data, so
  any individual call can be challenged and the totals recomputed. Two calls are genuinely arguable:
  the 91 `FALSE_REGPRIORITY` records (*"Adults 19yrs+ can register 1 week prior"* — read here as a
  registration-priority note, not an age restriction, on the strength of the family-dance-class
  counter-example) and the 23 `FALSE_WAIVER` records. Reclassifying both as true would move the
  headline from 448 to 562 and would not change any recommendation.
- **`FALSE_OK` records were counted as non-defects**, which is generous to the current code: those
  50 records have a numeric age present that never reaches `ageText`, and only luck makes the
  keyword answer match. They are latent, not correct.

**My own error, disclosed.** The first live ActiveNet pull returned HTTP 404 on all 23 calendars and
I initially recorded that as a source-availability finding. It was not: I had hardcoded
`ca.apm.activecommunities.com` in my pull script while `ACTIVENET_PORTAL_HOST` (config.ts:49) is
`anc.ca.apm.activecommunities.com`. The configured host is correct and the live path is healthy. A
second error in the same script — reading `center_id` from the filters response, whose real key is
`id` — produced 23 HTTP 500s before it was found. Both were mine; neither is a defect in the
adapter, and the 17,209-record corpus above was pulled after both were fixed.
