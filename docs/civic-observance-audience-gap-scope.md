# CityCalendar — civic-observance gap in the adult-subject ingest guard: scope

**Status: SCOPING AND CHARACTERISATION ONLY. No guard code was changed.**
Branch `design/kf-civic-observance-scope`, off `origin/main` @ `bdd3ad0`. Recorded as
`kids-fun-3h-citycalendar-civic-observance-adult-subject-gap-2026-08-19`.

`ADULT_SUBJECT_RE`, `namesAdultOnlySubject`, `CHILD_AUDIENCE_RE`, `CAREGIVER_PROGRAMME_RE` and
every other ingest guard are **byte-identical to `bdd3ad0`**. This document recommends a
mechanism; it does not implement one. The recommendation in §7 is **awaiting Operator sign-off**
and must not be actioned without it.

Measurements dated **2026-08-19**. Production counts are read-only via
`scripts/backfill-scope/readonly-db.ts` (`BEGIN TRANSACTION READ ONLY`, SELECT/WITH only). Feed
counts are from the captured `bdd3ad0` artefact plus two read-only GETs of the public Trumba feed.

---

## 1. Headline findings

1. **The mechanism hypothesis is CONFIRMED.** The all-ages signal comes from the structured
   `Audiences` tag; the prose contains no young-audience word; so both vetoes pass and the *sole*
   reason suppression fails is that `ADULT_SUBJECT_RE` names no civic-observance subject. Measured
   per-row in §3, not inferred.

2. **The "Violence Against Women" near-miss is CONFIRMED as a regex fact and REFUTED as a
   story.** The phrase does match neither alternative of the existing domestic/IPV branch. But it
   is *already in the vocabulary* — `lib/audit/rules/adult-subject-child-bands.ts:126-130` carries
   `/\b(?:violence\s+against\s+women|gender[\s-]based\s+violence)\b/i` as a **`weak`** marker whose
   stated reason is, verbatim, *"gender-based-violence content, **which public commemorations do
   hold as all-ages events**"*. This is not an oversight in the vocabulary. It is a prior author
   anticipating this exact case and deciding, in writing, that it must not suppress unreviewed.
   §7 does not get to ignore that.

3. **It is four rows, not five.** Five rows in the feed share the template; the fifth
   (`150181808` International Overdose Awareness) is the flagship `f59cd71` row and **is correctly
   suppressed today**. Four leak. See §2.

4. **The real blast radius is 9 distinct observances a year, not 5** — measured, §4. The four in
   the store are the four that happen to be inside today's ~4.5-month feed window. Five more are
   already visible further out, including one the mourning-vocabulary fix would *not* catch.

5. **The false-positive cost is smaller than assumed, in a way that matters.** Suppression yields
   silence, and `lib/search/filters/age.ts:17` admits an empty band list under **every** age
   filter — *"all-ages / unknown → don't hide"*. A wrongly-suppressed listing is not muted; it
   moves from the confirmed section to the `ageUnconfirmed` section (`filters/age.ts:42-45`:
   *"Nothing is excluded either way — this decides which heading a listing appears under, never
   whether it appears"*). The asymmetry runs the other way from the intuition: **not** suppressing
   publishes a false statement of fact into `ages=under2` as a *confirmed* match.

6. **No candidate pattern can be validated to this codebase's own standard, and that is the
   binding constraint.** `adult-subject-child-bands.ts:84-86` requires each entry be checked
   "against a live sweep". Production stores a **non-empty** `description_snippet` on **0 of
   15,050** live rows (§5) — i.e. the column is empty on every row. The guard reads title *and
   description*. The sweep that would validate a widening therefore cannot see the guard's input.
   Every false-positive number below is title-only.

---

## 2. Mechanism, verified

### 2.1 The control flow

`worker/adapters/citycalendar/index.ts:343-360`, `ageText()`:

```ts
const hay = `${decodeEntities(event.title)} ${decodeEntities(event.description ?? '')}`;
const wording =
  customField(event, 'Audiences') ??                 // ← structured tag wins
  AGE_RANGE_RE.exec(hay)?.[0]?.trim() ??
  AGE_HINT_RE.exec(hay)?.[0]?.trim();
if (!wording) return undefined;
if (isCatchAllAudience(wording) && namesAdultOnlySubject(hay)) return undefined;   // :358
return wording;
```

`namesAdultOnlySubject` (`:337-341`) is three tests in order:

```ts
if (CHILD_AUDIENCE_RE.test(sourceText)) return false;        // :338  veto
if (CAREGIVER_PROGRAMME_RE.test(sourceText)) return false;   // :339  veto
return ADULT_SUBJECT_RE.test(sourceText);                    // :340  require
```

`sourceText` is `hay` — **title + description only, never the `Audiences` field**. The header at
`:324-336` gives the reason and it is a good one: letting the value under suspicion satisfy the
guard that would excuse it makes the check unfalsifiable, *"the bug becomes its own alibi"*.
Confirmed: the guard genuinely never reads `Audiences`.

`isCatchAllAudience` (`:315-322`) defers to `parseAgeText(t).notes === 'all-ages'` rather than
carrying a fourth copy of `ALL_AGES_RE`, and requires **every** semicolon/comma-separated tag to
be a catch-all.

### 2.2 The verification method, and its positive control

The three regexes are not exported. Rather than retype them — the transcription error that would
have invalidated everything below — the probe **parses the literals out of the source file at
runtime** and rebuilds `ageText()` from them, then proves the reconstruction faithful against the
real `CityCalendarAdapter.extract()`:

```
=== POSITIVE CONTROL: replica vs shipped extract() ===
  suppression FIRED (shipped): 150181808 "International Overdose Awareness" Audiences="All ages"
  events extracted: 30, replica mismatches: 0, live suppressions observed: 1
  CONTROL PASSES (faithful + non-vacuous)
```

Non-vacuous matters as much as faithful: a replica that suppressed *nothing* would agree with a
misimported predicate that also suppressed nothing. On the wider 37-event window the control
reports `mismatches: 0, suppressions: 2`.

A second predicate needed the same treatment and failed it first. `age_band_matches` stores
**band UUIDs, not band keys**, so the obvious `bands ∩ {under2,2-4,5-9}` filter returned **0 rows
out of 15,050** — a clean false negative. After resolving ids through `age_band`, the true count
is **5,148**, consistent in order with `docs/safety-auditor.md`'s 2,090-of-4,530 sweep on a
smaller catalogue. Recorded here because the brief's discipline note is right: a predicate that
returns 0 everywhere is a misimport until proven otherwise.

---

## 3. The rows

The `bdd3ad0` captured feed and today's live base-URL fetch agree exactly: **30 events, 5 sharing
the half-mast template, all tagged `Audiences: All ages`, all `Event type: Community`.**

| eventID | date | title | Audiences | `ageText` | stored |
|---|---|---|---|---|---|
| `150181808` | 2026-08-31 | International Overdose Awareness | All ages | `undefined` | **suppressed** — no age row |
| `150182023` | 2026-09-13 | Police and Peace Officers' National Memorial Day | All ages | `"All ages"` | `[0, ∞)` bands=5 |
| `150182228` | 2026-09-27 | Firefighters' National Memorial Day | All ages | `"All ages"` | `[0, ∞)` bands=5 |
| `150182437` | 2026-11-11 | Remembrance Day | All ages | `"All ages"` | `[0, ∞)` bands=5 |
| `150182640` | 2026-12-06 | National Day of Remembrance and Action on Violence Against Women | All ages | `"All ages"` | `[0, ∞)` bands=5 |

Occurrence ids: `3be9b5a1-389a-48e2-825b-82157931089d`, `79f75c76-f639-49cf-9074-57c0afb85cbf`,
`9aaa8fa3-1ac6-4fbe-b749-89fb211360d5`, `1ce1d314-4769-43a9-b027-04a0a8f78bb4`; the suppressed
flagship is `97670289-a949-4ebb-8f47-d33adf92d404`.

Descriptions, verbatim, entity-decoded:

```
150181808  City Hall's flag will be at half-mast in honour of International Overdose Awareness.
150182023  Citywide, flags will be at half-mast in honour of Police and Peace Officers' National Memorial Day.
150182228  Citywide, flags will be at half-mast in honour of Firefighters' National Memorial Day.
150182437  Citywide, flags will be at half-mast in honour of Remembrance Day.
150182640  Citywide, flags will be at half-mast in honour of National Day of Remembrance and Action on Violence Against Women.
```

### 3.1 Per-row predicate trace

Each of the four leaking rows, measured:

```
  id=150182023  Audiences="All ages"  catchAll=true
  CHILD_AUDIENCE_RE  -> false  null
  CAREGIVER_PROG_RE  -> false  null
  ADULT_SUBJECT_RE   -> false  null
  => shipped ageText = "All ages"  (suppressed=false)
```

— identical shape for `150182228`, `150182437`, `150182640`. And the row that works:

```
  id=150181808  Audiences="All ages"  catchAll=true
  ADULT_SUBJECT_RE   -> true  "Overdose"      alt[0] MATCHES: "Overdose"
  => shipped ageText = undefined  (suppressed=true)
```

**Hypothesis confirmed exactly as stated.** Neither veto fires on any of the four; the catch-all
test passes; `ADULT_SUBJECT_RE` is the only failing term.

### 3.2 The near-miss, run rather than reasoned

The branch under test is `index.ts:285`,
`/\b(?:domestic|intimate[\s-]partner)\s+violence\b|\bsexual\s+assault\b/i`:

```
  NO MATCH  "National Day of Remembrance and Action on Violence Against Women"
  NO MATCH  "Citywide, flags will be at half-mast in honour of National Day of Remembrance…"
  NO MATCH  "violence against women"
  NO MATCH  "gender-based violence"
  MATCH     "domestic violence"
  MATCH     "intimate partner violence"
  MATCH     "intimate-partner violence"
  MATCH     "sexual assault"
```

Confirmed as a regex fact. **But see §1.2 and §6** — the phrase already exists in the audit copy
as a deliberate `weak` marker. The near-miss is not a hole in the vocabulary; it is the visible
edge of a tier decision.

### 3.3 What else carries a catch-all tag, and why it does not leak

Seven live rows carry `Audiences: All ages`. Two are not observances and one is instructive:

- `206479248` **Port Day** — genuinely a family event. Suppression is blocked by
  `CHILD_AUDIENCE_RE` matching `"family"` in the description. It is saved *by one word of prose*.
  Any candidate pattern's safety margin here is thinner than the FP counts in §5 suggest.
- `206159025` **All Candidates Meeting** — a municipal-election candidates' meeting resolving
  `[0, ∞)` all-ages. Not an observance, not covered by any option below, and arguably a real
  instance of the same class of defect. Out of scope; noted so it is not rediscovered as new.

---

## 4. Blast radius

**Number: 9 distinct civic observances per year, of which 8 leak. In the current feed window, 4
leaking rows are in production today. Within a 400-day horizon, 11 occurrences of 9 distinct
observances, 9 of them leaking.**

### 4.1 Method

`config.ts` sets `liveEventsLimit: 40` and the adapter slices to `DEFAULT_LIMIT = 40`
(`index.ts:22, 453`), so ingest only ever sees the feed's own default forward window, first 40
events. Measured today, that window is **30 events spanning 2026-08-19 → 2027-01-01** — about
4.5 months. That is why only four observances are in the store: the rest have not rolled in yet.

To see past the window I fetched the public feed with a wider parameter (read-only, one GET). It
returned **37 events spanning 2026-08-19 → 2027-09-12**. Replaying the *shipped* `extract()`
over it:

```
half-mast events: 11
  SUPPRESSED     150181808  2026-08-31  International Overdose Awareness
  LEAKS [0,inf)  150182023  2026-09-13  Police and Peace Officers' National Memorial Day
  LEAKS [0,inf)  150182228  2026-09-27  Firefighters' National Memorial Day
  LEAKS [0,inf)  150182437  2026-11-11  Remembrance Day
  LEAKS [0,inf)  150182640  2026-12-06  National Day of Remembrance and Action on Violence Against Women
  LEAKS [0,inf)  150182886  2027-04-09  National Day of Remembrance of the Battle of Vimy Ridge
  LEAKS [0,inf)  150181193  2027-04-14  BC Provincial Health Officer's Declaration of a Public Health Emergency
  LEAKS [0,inf)  150181401  2027-04-28  Day of Mourning for Persons Killed or Injured in the Workplace
  LEAKS [0,inf)  150181605  2027-06-23  National Day of Remembrance for Victims of Terrorism
  SUPPRESSED     150181809  2027-08-31  International Overdose Awareness
  LEAKS [0,inf)  150182024  2027-09-12  Police and Peace Officers' National Memorial Day
  LEAKING: 9 of 11 ; distinct observances: 9
```

The event ids corroborate the structure: `150181193, 150181401, 150181605, 150181808/9,
150182023/4, 150182228, 150182437, 150182640, 150182886` — one authored series, ~200 apart, with
consecutive pairs where the same observance recurs the following year.

### 4.2 Error bars, stated honestly

- **9 is a lower bound on the annual set, not an upper one.** The 400-day window still ends
  2027-09-12, so an observance falling in the uncovered remainder would be missed. The City's
  flag-lowering protocol is the authoritative list and I did not obtain it. **A future
  implementer should get that list rather than trust 9.**
- **Two observances appear twice** (2026 and 2027 instances). Per-year the distinct count is 9;
  the *occurrence-row* count over 13 months is 11.
- **Rate, not stock, is the useful figure.** With a ~4.5-month window and 9 observances a year,
  roughly one new leaking row enters the store every ~6 weeks. The 4 in production today are not
  a backlog that stops growing.
- **The wider fetch used a parameter the endpoint does not document.** Supplying an unrecognised
  parameter made Trumba return a *different calendar entirely* (200 events, 2016–2017, a
  `calendarlabs.com` holiday feed). That response is not the City's data and is used below only
  as an adversarial FP corpus, clearly labelled. The 37-event response *is* City data — every id
  in it is in the same series as the 5 in the base window — but the parameter is unsupported, so
  treat 400 days as "a window I could see", not "the window Trumba promises".
- **Only city_calendar is in scope for the adapter guard.** Production holds 49 live
  `city_calendar` rows, 18 with an age row, 10 all-ages `[0, ∞)`, of which 4 are the leaks. A
  change to the *audit* copy has a different, much larger exposure — 5,148 rows carry an affirmed
  child band. §6.

---

## 5. Candidate patterns, with measured false positives

Corpora used, and what each can and cannot show:

| corpus | n | has descriptions? |
|---|---|---|
| production, all live rows | 15,050 (2,727 distinct titles) | **no** — non-empty `description_snippet` on 0/15,050 |
| production, all-ages rows | 2,172 | no |
| production, affirmed-child-band rows | 5,148 | no |
| captured Trumba window (`bdd3ad0`) | 30 | yes |
| live Trumba window (today, 400d) | 37 | yes |
| adversarial public holiday calendar | 200 | yes |

**The description gap is the headline caveat.** The guard reads title + description; the only
description-bearing corpora available anywhere in this repo or in production total 267 documents,
30 of which are the City's. Every FP number below is therefore a *floor*.

### 5.1 Coverage and FPs on the City corpus (37 live events; 11 half-mast, 26 other)

| pattern | option | covers | FP on the other 26 | misses |
|---|---|---|---|---|
| `/\bflags?\s+will\s+be\s+at\s+half[\s-]?mast\b/i` | (c) | **11/11** | **0** | — |
| `/\bhalf[\s-]?mast\b/i` | (c) loose | **11/11** | **0** | — |
| `/\b(?:remembrance\|memorial\s+day\|day\s+of\s+mourning\|in\s+memoriam)\b/i` | (a) | 8/11 | 0 | Overdose ×2, **BC PHO Declaration** |
| above + `commemorat\w+\|vigil\|victims\s+of` | (a) wide | 8/11 | 0 | same |
| `/\b(?:violence\s+against\s+(?:women\|persons\|children)\|gender[\s-]based\s+violence\|femicide)\b/i` | (b) | **1/11** | 0 | 10 |
| shipped `ADULT_SUBJECT_RE` | baseline | 2/11 | 0 | 9 |

**Option (a) does not close the gap.** Widening the mourning vocabulary to its comfortable limit
still misses *"BC Provincial Health Officer's Declaration of a Public Health Emergency"* — the
observance of the overdose emergency, i.e. arguably the most adult-only item in the set, carrying
no mourning word at all. A subject-vocabulary fix leaves the two hardest rows behind.

### 5.2 FPs across production (title-only)

Over all three production corpora, every candidate in §5.1 scored **0 false positives** — and
that result is close to worthless. The catalogue's 2,727 distinct titles are overwhelmingly
rec-centre and library programme names; civic-observance vocabulary does not collide with
"Preschool Skate". Two naive variants were run specifically to find a collision and did not find
one either (`/\bmemorial\b/` → 2 hits, both targets; `/\bviolence\b/` → 1 hit, the target).

The one measurement that *is* informative is negative: `/\bhalf[\s-]?mast\b/` scores **0 hits on
every production corpus** including the four target rows — because the phrase lives in the
description, which production does not store. **Option (c) is invisible to any stored-data
validation and can only be exercised at ingest.** That is a real cost of (c), and it is also
direct evidence for §1.6.

### 5.3 Failure modes — synthetic, and labelled as such

Hand-written counterfactuals in shapes the City and Park Board demonstrably publish. **Not a
measured corpus**; included only to characterise *how* each option fails, which the real corpora
are too small to reveal.

| case | want | (a) mourning | (b) VAW | (c) half-mast |
|---|---|---|---|---|
| Remembrance Day *(the flag notice)* | suppress | ok | miss | ok |
| Remembrance Day Ceremony at Victory Square | **keep** | **FALSE+** | ok | ok |
| Remembrance Day Ceremony | **keep** | **FALSE+** | ok | ok |
| Firefighters' Memorial Day Open House | **keep** | **FALSE+** | ok | ok |
| Vimy Ridge Commemoration Walk | **keep** | **FALSE+** | ok | ok |
| Culture Days: Commemorative Mural Painting | **keep** | **FALSE+** | ok | ok |
| Candlelight Vigil for MMIWG | suppress | ok | miss | miss |
| Day of Mourning Ceremony | suppress | ok | miss | miss |

This is the brief's tension made concrete, and it resolves cleanly: **(a) fails on exactly the
class of event the Operator was worried about** — real, attendable, all-ages civic ceremonies —
because it teaches the guard that *mourning ⇒ adult-only*. (c) never makes that inference,
because it is not reasoning about the subject at all. (c)'s misses are the honest kind: it
declines to judge attendable sombre events, which is the audit layer's job (§6).

---

## 6. The two-copy consistency problem

### 6.1 The copies are real and the constraint is structural

`worker/adapters/citycalendar/index.ts:265-273` records it, and it checks out. The worker cannot
import `lib/audit/rules/adult-signals.ts` because that file's line 21 is
`import { parseAudienceLabels } from '@/worker/core/age'`, and `worker/tsconfig.json` documents
that it has **no `@/*` alias, deliberately**: *"tsc type-checks a path alias but emits the
specifier verbatim, so `require("@/lib/...")` would blow up under bare node in the container"*.
`tests/scheduler/worker-image-closure.test.ts` fails if a `@/` specifier reappears in the
worker's module closure (12 tests, passing).

### 6.2 Measured relationship between the copies

Compared programmatically, not by eye:

```
adapter alternatives: 7   rule markers: 10 (strong 7, weak 3)
adapter set === rule STRONG set (order-sensitive, byte-exact)?  true
CHILD_AUDIENCE_RE       adapter === audit ?  true
CAREGIVER_PROGRAMME_RE  adapter === audit ?  true
```

So the copies are **in sync today**, and — the important part — the adapter copy is a
**deliberate strict subset**: the seven `strong` markers, none of the three `weak` ones.
`index.ts:275-279` states the contract: *"acting on a weak marker here would silently mute real
listings with nobody reviewing the decision."*

**Consistency here does not mean identity.** Any fix must preserve a *tiered* relationship, not a
byte-equal one. A naive "keep them in sync" instruction to an implementer would import the weak
tier into ingest and destroy the property the header exists to protect.

### 6.3 What a fix has to do about it

1. **Decide which copy owns the change first.** A subject-vocabulary change (a/b) belongs in the
   audit rule, where tiers and an adjudicator exist, and is then *selectively* promoted to the
   adapter only if it is `strong`. A notice-shape change (c) belongs **only** in the adapter: it
   is a property of the feed record, and stored data has no description for the audit layer to
   read (§5.2), so an audit-side copy would be dead code.
2. **Add a drift test.** The subset relationship is currently maintained by nothing but care.
   A test asserting *"every alternative in the adapter's `ADULT_SUBJECT_RE` appears as a `strong`
   marker in `ADULT_SUBJECT_MARKERS`, and no `weak` marker appears in the adapter"* is
   cheap, needs no import from `lib/` into the worker's *runtime* closure (a test may import
   both freely — it does not ship in the container), and converts a silent drift into a red
   build. **This is worth doing regardless of which option is chosen.**
3. **Do not consolidate as part of this fix.** Moving the vocabulary into a worker-owned module
   that `lib/` imports is the correct long-term shape and is already logged as a follow-up. It is
   a separately-QA'd change to the audit layer; smuggling it in behind a four-row defect inverts
   the risk ratio.

---

## 7. Options, trade-offs, and a recommendation

### (a) Broaden `ADULT_SUBJECT_RE` with civic-observance vocabulary
- **For:** smallest diff, uses the existing seam, needs no new concept.
- **Against:** covers only **8/11**, missing the BC PHO Declaration entirely (§5.1). False-positives
  on every attendable civic ceremony tested (§5.3). It promotes vocabulary the audit layer already
  classified `weak`, with a written reason naming this exact case, into a `strong` ingest-time
  suppressor with no adjudicator — inverting a documented decision without new evidence.
  Unvalidatable against a live sweep (§1.6).
- **Verdict: reject.** It is the option that most looks like a fix and least is one.

### (b) Fix the "violence against women" phrasing gap only
- **For:** minimal; addresses the literal near-miss; already the audit rule's own phrasing.
- **Against:** **1/11 coverage** — it fixes one row and leaves eight. And it is the *same*
  inversion as (a) in miniature: promoting a marker whose `why` is literally *"which public
  commemorations do hold as all-ages events"* from `weak` to a strong ingest suppressor is
  overturning that judgement, not honouring it.
- **Verdict: reject as a fix.** Worth keeping as an *audit-side* observation.

### (c) Treat the half-mast **notice** as not an attendable event
- **For:** **11/11 coverage, 0 measured FPs**, and 0 FPs in the synthetic ceremony set. It is a
  different axis — event *shape*, not subject — so it cannot teach the guard that mourning ⇒
  adult-only, and it leaves genuine all-ages ceremonies alone by construction. It is also simply
  the honest reading: "Citywide, flags will be at half-mast" is a municipal notice, not
  programming; nobody attends it, at any age.
- **Against:** see the recommendation's counter-argument below.
- **Verdict: recommended, in the narrow form.**

### (d) Route these to the audit layer's `weak`/candidate tier
- **For:** correct venue for subject-matter judgement; an adjudicator exists.
- **Against:** **for the VAW row this is already done and already firing.** Replaying the shipped
  `adultSubjectChildBandsRule.detect()` against the 10 stored `city_calendar` all-ages rows:
  ```
  SIGNAL  weak:"Violence Against Women"   National Day of Remembrance and Action on Violence Against Women
  silent  —                               Police and Peace Officers' National Memorial Day
  silent  —                               Firefighters' National Memorial Day
  silent  —                               Remembrance Day
  ```
  So (d) buys nothing new for that row and nothing at all for the other eight, whose only
  distinguishing text is the description production does not store. And it does not stop the
  false claim being published at ingest — it only queues it for a human afterwards.
- **Verdict: already partly in place; not sufficient alone. Keep as the home for (b).**

### (e) Do nothing
- **For:** genuinely defensible, and stronger than it sounds. Nothing regressed — this shape has
  existed since `ADULT_SUBJECT_RE` was authored. The harm is bounded: four rows, each a flag
  notice with no venue to attend and no time to turn up. The reconciliation's verdict is
  correctly CONFIRMS. The catalogue is 15,050 rows; this is 4. And the standing rule that the
  vocabulary grows **one measured entry at a time** cannot currently be satisfied (§1.6), so
  "wait until we can measure" is a principled position, not laziness.
- **Against:** the rows say, affirmatively, to a parent filtering `ages=under2`, that a day of
  mourning is programming for their baby — the precise sentence `f59cd71` and
  `adult-subject-child-bands.ts` were both written to stop. Doing nothing means shipping a
  known false statement of fact, at a measured rate of ~1 new row every 6 weeks, indefinitely.
- **Verdict: the correct fallback if (c) is not signed off. It is not a good resting place.**

### 7.1 Recommendation — **AWAITING OPERATOR SIGN-OFF**

> **Adopt (c): suppress the age wording when the source's own description states that flags will
> be at half-mast — the notice shape, not the subject — implemented in the adapter only, as a
> separate named predicate beside `namesAdultOnlySubject` rather than as a new alternative
> inside `ADULT_SUBJECT_RE`; and ship the §6.3 drift test with it.**

Keeping it out of `ADULT_SUBJECT_RE` is load-bearing. That constant answers one question — *is
the subject adult-only?* — and "a flag is at half-mast" is not an answer to it. Folding it in
would make the constant mean two things and would export the confusion to the audit copy, which
has no use for it.

**The strongest argument against the recommendation**, stated plainly: (c) is tenant-specific
string-matching on one municipality's copy-deck, and it fails *silently*. The moment Vancouver
rewords the template — or a second city joins `CITY_CALENDARS` with a different one — the
predicate quietly matches nothing and the rows leak again, with no test failing and no signal
anywhere, because "the guard did nothing" and "there was nothing to guard" are indistinguishable
from outside. That is exactly the unfalsifiability `index.ts:324-336` was written to prevent, now
reintroduced one layer up. A subject-vocabulary fix, for all its false positives, at least
degrades *loudly*. Mitigation — not a refutation — is to pin the four rows in
`tests/adapters/citycalendar.test.ts` as fixtures so a template change turns into a red test
rather than a silent regression; that mitigation should be considered part of the recommendation,
not an optional extra.

---

## 8. What this document did NOT establish

1. **The authoritative annual list of City of Vancouver flag-lowering days.** 9 is a measured
   lower bound from a 400-day feed window, not the City's protocol. Get the list.
2. **Any false-positive rate on descriptions.** Impossible from stored data (§5.2). Until
   ingestion persists a description, or a description corpus is captured deliberately, no
   candidate pattern can meet `adult-subject-child-bands.ts:84-86`'s own bar. **This is the
   single biggest open question and it blocks options (a) and (b) outright.**
3. **Whether the wider feed window is contractual.** The parameter that produced it is
   undocumented and, when unrecognised, returns a different calendar entirely.
4. **Backfill.** Suppression makes the parser *quieter*, so per
   `docs/worker-fix-backfill-scope.md` §1 the four existing `[0, ∞)` rows will **not** self-heal
   on re-ingest — `if (ageParse)` never fires, so nothing overwrites them. A fix therefore needs a
   4-row backfill, which is Operator-write territory. Not scoped here.
5. **Whether a flag notice should be an `activity_occurrence` at all.** The honest extension of
   (c) is that `extract()` should not ingest it. That removes rows rather than silencing a field
   and has its own blast radius. Deliberately out of scope.
6. **`206159025` All Candidates Meeting** (§3.3) — an all-ages `[0, ∞)` municipal-election
   meeting. Same family of defect, covered by no option here.
7. **Whether the audit layer's `weak` candidate for the VAW row was ever adjudicated.** It fires
   today; I did not check the review queue for a verdict.

---

## 9. Reproducing this

Probe scripts were throwaway and are not committed; they parsed the guard's regex literals out of
the source at runtime and validated the reconstruction against `CityCalendarAdapter.extract()`
(§2.2). To re-derive:

```bash
# feed replay — no database needed
bash scripts/backfill-scope/citycalendar-recon.sh --feed-file .citycalendar-feed.json

# production counts — read-only, connection string supplied deliberately, never defaulted
DATABASE_URL=... bash scripts/backfill-scope/citycalendar-recon.sh
```

Verification that nothing moved: `npx tsc --noEmit` clean; `tests/adapters/citycalendar.test.ts`
(12), `tests/audit/rules.test.ts` (41), `tests/audit/pipeline.test.ts` (16),
`tests/audit/sweep.test.ts` (9), `tests/backfill-scope/citycalendar-recon.test.ts` (47),
`tests/scheduler/worker-image-closure.test.ts` (12) — **137 passed, 0 failed.**
