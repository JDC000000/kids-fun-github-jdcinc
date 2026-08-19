# A3 — Cross-slot de-duplication and ordering for the "three things" front door

**Status: DESIGN ONLY. Nothing in this document is implemented.** The seam it plugs into
(`SlotChooser` in `lib/recommend/three-things.ts`) exists and is shipped with a deliberately
incomplete placeholder (`firstEligiblePerSlot`, which will hand the same listing to three slots).

This is the pass `docs/answer-before-search-design.md` §10.7 declined to make — *"I did not attempt
to design the ranking function in A3. It is the one genuinely new piece of logic here and it
deserves its own short design once §7.3 has decided what the slots are"* — now that §7.3 is
decided (Jon, 2026-08-19: free / indoor-on-`isRainyDayFriendly` / nearby-from-downtown-default).

Every number below was measured on staging at **2026-08-19 ~15:15 PT**, not carried over from the
parent document's 08-18 pass. Method and full figures are in §5.

---

## 1. The measurement this design is answering to

Three slot pools, each already through the front-door gates
(`isShowableOnFrontDoor`: source stated an age, and not adult/senior-only):

| Slot | Query | Reached | Showable | Head of pool |
|---|---|---|---|---|
| Free | `when=today, free=1` → `isFree()` | 101 | **18** | Games Room Drop-in - Youth · Hillcrest |
| Indoor | `when=today, rainy=1` (citywide) | 6 | **4** | Play Palace · Kerrisdale Cyclone Taylor Arena |
| Nearby | `when=today, 5 km of 49.2827/−123.1207, sort=distance` | 46 | **19** | inkTAG Layout Meeting · Central Library |

Those three pools hold **41 rows but only 33 distinct listings**. The duplication is not a corner
case waiting for a thin day; it is a third of the surface, today:

- **free ∩ nearby — 6 identical `listing.id`s.** The free pool's #2 *is* the nearby pool's #2
  ("Games Room - Pre-Teen/Youth Only" · Roundhouse). Today the two heads happen to differ, so a
  naive build would look fine in a screenshot and be wrong on a different afternoon.
- **free ∩ indoor — 2 identical `listing.id`s**, both "LEGO® Block Party".
- **indoor ∩ nearby — 0**, because all four showable indoor cards are further than 5 km from
  downtown. See §6, which is a question for Jon rather than a design decision.
- **Inside the indoor pool itself — "LEGO® Block Party" appears twice**, at West Point Grey Branch
  and at Renfrew Branch. Two *different* `seriesId`s at two *different* venues, so neither
  `collapseSeries` nor `dedupeSoonestPerSeries` can see it. With four showable indoor cards, half
  the pool's tail is one programme.

**The finding that decides the shape of this design:** the parent document's §3d(2) predicted the
three slots would collapse onto one listing. They don't quite — but they overlap by a third, the
overlap reaches the head of a pool, and the one genuinely-new duplicate class (same programme,
different venue, different series) is present today in the *smallest* pool. So de-duplication is
load-bearing and ordering is not.

---

## 2. What counts as "the same thing" — three classes, one key

### 2a. The classes, hardest last

1. **Same card.** The same `listing.id` reaches two slots. Six occurrences today. Trivial.
2. **Same series, different occurrence.** Not visible today, but structural and it must be
   handled: each slot is its own full pipeline run, and `collapseSeries` keeps *the best-ranked
   member under that run's ordering*. The nearby slot sorts by `distance` and the free slot by
   `best_match`, so one series can hand out two different representative `listing.id`s to two
   slots. A key of `listing.id` alone would miss it entirely.
3. **Same programme, different series and different venue.** "LEGO® Block Party" at two library
   branches; the parent document's two Zumba classes at two community centres (§1a). This is the
   class nothing in the codebase currently addresses, and the only signal available for it is the
   title.

### 2b. Can `worker/core/title.ts` be reused for class 3? — checked, and no

The brief asked this to be verified rather than assumed. Three findings:

- **A normalised title is already on `ListingRecord`.** `worker/core/upsert.ts` writes the
  normaliser's output into `activity_occurrence.activity_name` and preserves the source's own
  wording in `source_title` (migration `0032`); `lib/search/postgres-repository.ts:196` maps
  `activityName: row.activity_name`. So `ListingRecord.activityName` *is* the normalised string —
  and `source_title` is not on the record at all. There is nothing to import for access.
- **But normalisation is not uniform across the catalogue.** `0032`'s own header states the
  invariant: `source_title IS NULL` ⇔ the row has not been re-ingested since it shipped. So the
  live catalogue is mixed, and a comparison must not assume the normaliser has run on both sides.
- **And it would be the wrong tool anyway.** `worker/` is excluded from the app's `tsconfig.json`
  (`"exclude": ["node_modules", "worker", …]`), which is the boundary `worker/core/age.ts`'s
  header describes — but the deeper reason is purpose. `normalizeTitle` produces a string a
  **parent reads**, so it is documented as deliberately timid, requiring an unambiguous marker for
  every rule ("a bare number is NEVER a price here"). A comparison key produces a string **nobody
  ever sees**, so it can and should be far more aggressive. Reusing the reader-facing normaliser
  as a matcher would import exactly the timidity that makes it safe for its own job.

**Proposal: a local comparison fold in `lib/recommend/`, not a shared module and not an import.**

### 2c. The key

```
sameThingKey(listing):
  1. seriesId — if two cards share it they ARE the same thing; no text is consulted.
  2. otherwise foldTitle(activityName):
       lowercase; strip ® ™ and diacritics
       drop $-marked amounts            ($3, $0.00 - $8.75)
       drop clock times                 (3:30, 5pm)
       drop age tokens                  (0-12yrs, 8yrs+)
       drop a bare trailing weekday
       drop session qualifiers          ("- Set Two", "- Two Sets")
       collapse non-alphanumerics to single spaces; trim
```

The first four folds mirror what the ingest normaliser would have removed, which is what makes the
key stable across re-ingested and not-yet-re-ingested rows — the point of §2b's second finding.
The last two are additions the ingest normaliser must not make (a weekday is part of "Monday
Funday"; a set number is a real distinction on a timetable) but a *comparison* safely can.

**The venue is deliberately NOT in the key.** Including it would make the two LEGO Block Parties
distinct, which is the exact case this exists to catch. A three-card hero offers three things to
*do*; "the same thing, somewhere else" is not a second thing, and the where-question is what the
nearby slot's own framing answers.

Validated against tonight's 33 distinct cards: the fold merges **exactly one** pair beyond what
`seriesId` already merges — the LEGO pair — and produces **zero** false merges. That is a small
sample and I am not claiming more than it supports; it is enough to say the fold is not wild.

### 2d. Which direction to err, stated as a position

**Lean toward merging.** A false merge (two genuinely different activities collapsed) costs one
slot one candidate, and the slot moves to its next. A false split (two cards reading "LEGO® Block
Party" side by side) costs the credibility of the page that is the product's primary claim, in
front of a parent who has typed nothing and has no reason to give it a second chance. The costs
are not comparable and the key should not pretend they are.

The only case where a merge costs a *slot* rather than a *candidate* is when a slot's entire
remaining pool duplicates cards already placed. That case is genuinely "we have nothing else to
offer", and ruling 7.5's answer — render fewer cards — is the correct one, not a failure to route
around.

---

## 3. Ordering — my position is that most of it should not be built

§3d(1) of the parent document calls for a "good recommendation" score and lists what it would need
to know: *is this for children at all; is the age band confirmed or merely unstated; is the title
duplicated across the picks; is it starting in a usable window*. Taking those one at a time, **three
of the four are already answered, and better, by things that are not a score:**

| Wanted signal | Where it is actually answered | Why not in a score |
|---|---|---|
| is this for children | `isShowableOnFrontDoor` — a hard gate | It is a question of *evidence*, and evidence is binary. A listing nobody ever said was for children should not appear at rank 40 either. |
| is the age confirmed | the engine's `results` / `ageUnconfirmed` split (ruling 7.6) | Same reason. Ruling 7.6 makes it an exclusion; weighting it would be re-admitting what the ruling excluded, at a discount. |
| is the title duplicated | §2 above | Duplication is a property of a *set of picks*, not of a card. No per-card score can express it. |
| starting in a usable window | **genuinely unanswered — §3b** | |

That leaves nothing for a new scoring function to do, and I recommend building none. Two reasons
beyond the table:

1. **A second ranker means the hero and `/search` disagree about what is best.** This codebase
   refuses that shape repeatedly and by name — `cost.ts` ("every user-facing cost string derives
   from `isFree()` rather than restating it"), `filters/predicate.ts` shared with the facet
   counter, `indoor.ts`. A bespoke front-door score would be the fourth mirror, on the most
   visible surface, and the two orderings would drift the first time either is tuned.

2. **§1a's complaint was never a ranking defect, and it has already been fixed.** The parent
   document's evidence for "the ordering is not a recommendation" was that two adult Zumba classes
   won the front door. But the ordering did not put them there because it was badly weighted; it
   put them there because nothing was filtering them out. Tonight's gates do: applying
   `isShowableOnFrontDoor` to today's top 100 leaves 36 cards, and Zumba, Step and Strength, Muay
   Thai Kickboxing and Strong HIIT Conditioning are all gone from every pool in §1. **The problem a
   new score was proposed to solve no longer exists.** What remains — "soonest-ish, official-ish,
   freshly-checked", the surviving three of seven components on an empty query — is a defensible
   ordering for "what is on today", and it is the same one the parent will meet on `/search`.

### 3a. So the within-slot order is the engine's own, per slot

Each slot already asks a differently-sorted question and gets an appropriate answer: `best_match`
for free (with `prioritizeConfirmedFreeWhenFreeActive` putting confirmed-free first), `best_match`
for indoor, `distance` for nearby. The chooser takes the first eligible card in the engine's order,
with one preference layered on top:

### 3b. The one real gap — "starting in a usable window"

The read model keeps an occurrence until its `end_datetime_utc`, so `when=today` at 3 p.m. includes
a programme that started at noon. `/search` can show that honestly in a list; a card under a
heading that says *you could do this now* cannot, because its own printed time reads as past.

Two ways to handle it, and I recommend the second:

- **(i) A hard filter** — drop any card whose every slot has already started. Over-strict: a
  two-hour drop-in that began twenty minutes ago is a perfectly good answer, and at 8 p.m. this
  empties every slot on a night the catalogue still has content.
- **(ii) A preference** — among a slot's eligible candidates, prefer one with a slot starting at or
  after `now`, and fall back to a still-running card rather than emptying the slot.

```
hasUsableStart(item, now) =
  item.slots.some(s => s.startDatetimeUtc == null || Date.parse(s.startDatetimeUtc) >= now)
```

Open-hours cards (null start) always qualify — an aquarium is available whenever it is open, which
is the whole meaning of the null. Measured at 15:15 PT tonight: 32 of 48 free, 3 of 4 indoor and 15
of 19 nearby gated cards still have a slot starting at or after now, so on today's data the
preference changes which card is picked without emptying anything. No new data, no weights, and it
reuses `SearchResultItem.slots`, which is already carried on every card.

This is the same posture as §4b's venue rule and for the same reason: **prefer, never exclude.**
Ruling 7.5's empty state should be reserved for genuine scarcity, never spent on a rule of ours.

---

## 4. Assignment across slots — who yields when two slots want one card

### 4a. Fill order is by scarcity, computed, not hard-coded

When the free and nearby slots both want "Games Room - Pre-Teen/Youth Only", one must yield. The
rule I propose: **assign greedily, poorest pool first**, where "poorest" is that slot's *showable
candidate count*, which we already hold by the time the chooser runs.

Tonight that orders indoor (4) → free (18) → nearby (19). The reasoning is not that indoor matters
most; it is that a slot with four candidates that loses its only good one to a slot holding
nineteen alternatives goes empty for no reason at all, and an empty slot is the most expensive
thing this surface can print. Computing the order from the pools rather than hard-coding
`indoor → free → nearby` matters because the ranking is seasonal: on a rainy Saturday indoor is
plausibly the fattest pool and free the thinnest, and a hard-coded order would then be
systematically backwards.

Ties break on `SLOT_KEYS` order so the result is deterministic for a given set of pools — a
property T1 will want.

**Greedy, not optimal.** A 3×N bipartite matching would fill strictly more slots in the pathological
case. I am not proposing one: with three slots the gain is at most one card in a rare arrangement,
and the cost is a piece of code no future reader can check by eye against what the page shows. If a
measurement ever shows greedy leaving slots empty that a matching would fill, that is the moment to
revisit — not before.

**And the residual case is not a bug.** Greedy can leave slot A empty while slot B holds a card A
would have accepted, when B chose first and A's remaining candidates all duplicate placed cards.
That is ruling 7.5's case exactly — fewer cards, honestly — and it should be reported as
`none_showable`, not routed around.

### 4b. Venue diversity is a preference, not an exclusion

Three cards at one community centre is a worse page than three at three. But
`capVenueRepetition` already exists for this *within* a list, and its own header states the rule
this design should inherit: *"a reorder, never a filter"*, and it explicitly refuses to hide real
answers on a page that has nothing to diversify with. Across three slots, with an indoor pool of
four, a hard venue exclusion would empty slots for style. So: prefer a card whose venue is not
already on the page, take one that is rather than leave the slot empty.

### 4c. Render order never changes

The chooser decides *fill* order. The page renders free, indoor, nearby, always, regardless of
which slot picked first. A parent must not see the cards reshuffle between visits for reasons
invisible to them.

---

## 5. "For children / age-confirmed / usable window", stated operationally

What each phrase means against what is actually on `ListingRecord`, since the brief asked for this
explicitly rather than as prose:

**"For children"** = `isShowableOnFrontDoor(item)`: `listing.ageMinMonths != null` **and**
`!isAdultOrSeniorOnly(listing)`. Note what this is and is not. It is a claim about **evidence** —
the source said who the programme is for, and did not say adults-only. It is **not** a claim about
age: there is deliberately no upper bound test, because the product's top band is `15+` and a teen
listing is kids content here. Both gates are carried verbatim from
`app/_components/HomeTodayStrip.tsx#isFrontDoorCandidate` (b9cdc9c), whose header records the
measurement behind each. Measured cost tonight: today's top 100 → 36 showable.

**"Age-confirmed"** = the engine's `results` array, never `ageUnconfirmed` (ruling 7.6). Two things
about this are easy to get wrong and both matter to the tests:

1. **Pre-age the rule is vacuous.** `splitAgeUnconfirmed` returns everything as `scored` when
   `userBands` is empty (`engine.ts:656`, in `splitAgeUnconfirmed`), so `ageUnconfirmed` is
   *always* empty for an anonymous visitor — the default case. A T3 guard written only against
   the anonymous path would pass on an
   implementation that reads `ageUnconfirmed` freely. **T3 must select an age band**, the same way
   `b46de05` had to make the front-door age guard non-vacuous.
2. **Gate 1 and `hasConfirmedAgeMatch` are different tests** that coincide under an age filter.
   Gate 1 asks "did the source say anything at all"; the split asks "does what it said intersect
   what the parent asked". Since `ageBandMatches` is derived from the numeric range,
   `ageMinMonths == null` implies no bands implies never confirmed — so under an active age filter
   gate 1 is subsumed. It is load-bearing **exactly in the anonymous case**, which is the default.

**"Starting in a usable window"** = `hasUsableStart(item, now)` in §3b. A preference, not a filter.

---

## 6. Measurement method, and one question this design cannot answer

**Method**, matching parent-document §2d for comparability: staging
(`kids-fun-staging-jdci-nc.vercel.app`, `KIDS_FUN_SEARCH_BACKEND=database`), `/api/search`,
drop-in only (registration excluded — the product default), cards not occurrences,
`minResults=0` on every call so nothing measured here was broadened into existence. Totals are
`SearchResponse.total`, computed before `limit`. Downtown origin is 49.2827/−123.1207, radius 5 km,
the same coordinate §2d used and the one ruling 7.4 names. 2026-08-19, ~15:15 PT.

**A methodology correction that affects the parent document.** §2d states that under an active Free
filter *"the index of the first non-free result is the complete count"*, because
`prioritizeConfirmedFreeWhenFreeActive` puts every `isFree()` card first. That is no longer true:
`capVenueRepetition` runs **after** the free prioritisation (`engine.ts:564/568`) and reorders
across it. Measured tonight on `when=today&free=1`, the first non-free card sits at index 16 while
20 of the first 100 are `isFree()` — four library cards were deferred past it by the venue cap. The
figure it produced (§2d's "exactly 24") should be treated as approximate, and the technique should
not be reused.

**The open question, which is Jon's and not mine.** The indoor slot as designed runs **citywide**,
with no origin — which is what the parent document's §3d slot table specifies, and it is why the
slot has four showable cards tonight instead of zero. Constrained to 5 km of downtown it reaches
two cards, **both** with `ageMinMonths == null`, so **the indoor slot is empty today under the
ruling's own default location**. Citywide is plainly the better data answer. But it means a block
whose framing is "near downtown Vancouver" can print an indoor card in Kerrisdale, 8 km away. That
is a copy problem, not a selection problem, and §6/A6 should answer it deliberately — most likely
by scoping the location claim to the nearby slot rather than to the block.

---

## 7. What this design does not cover

- **The scoring function is not built, on purpose** (§3). If a future measurement shows the
  engine's own ordering putting weak cards at the head of a *gated* pool, that is the evidence that
  would reopen this — and "inkTAG Layout Meeting · Central Library" leading the nearby pool tonight
  is arguably the first data point in that direction. One afternoon is not a finding; it is worth
  a second look once the block is live and can be watched.
- **`hasUsableStart` has no answer for 9 p.m.** — §7.2 of the parent document raised this as a copy
  question ("three things for tomorrow morning? an empty state? the notice?") and it is still open.
  This design degrades honestly into it (every slot reports `nothing_on`/`none_showable` rather
  than lying) but does not decide the copy.
- **Nothing here is measured on production.** Staging only, one afternoon, one Wednesday in August.
  The *shape* of the finding — a third of the pools overlap, the smallest pool contains a
  same-programme-different-venue pair — is structural and will hold. The counts will not.
