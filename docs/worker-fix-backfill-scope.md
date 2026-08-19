# §3h — worker-side fix backfill/reconciliation scope

**Status: MEASUREMENT ONLY. Nothing here has been applied to any database.**
Branch `design/kf-3h-backfill-scope`. All counts measured against **production**
(`kids-fun-supabase-prod`) on **2026-08-19**, read-only, via `scripts/backfill-scope/`.

Every write to a production row still requires the Operator's sign-off before it happens — the
same discipline as the PerfectMind stopgap, which the Operator did **by hand, deliberately**.
This document recommends mechanisms. It does not execute any of them, and the tooling it ships
**cannot** execute any of them (see §11).

---

## 1. The defect, stated once

`worker/core/ingest.ts:294`:

```ts
const ageParse = record.ageAudienceLabels?.length ? parseAudienceLabels(record.ageAudienceLabels)
               : record.ageText ? parseAgeText(record.ageText) : null;
...
if (ageParse) { await upsertOccurrenceAge(pool, occurrenceId, ageParse, ...); }
```

When a **fixed** parser concludes "no age claim can be made", it returns no `ageText`, so
`ageParse` is `null`, so **nothing is written**. `upsertOccurrenceAge` is an overwrite — but it is
only reached when there is something to overwrite *with*. The stale row written by the *old*
parser is therefore never touched again, by any number of future re-ingests, forever.

`if (ageParse)` is not a bug. Not writing is the right default for a brand-new listing — "don't
hide" is the product rule. The gap is that the same branch also means "don't correct".

**Consequence that drives every recommendation below:** a fix that makes the parser *quieter*
leaves stale rows behind and needs a backfill. A fix that makes the parser *say something
different* self-heals on the next re-ingest and needs no backfill at all. Those two are counted
separately throughout, because conflating them is the easy way to make a 1-row problem look like
a 12,000-row one.

---

## 2. Headline findings

1. **The four 2026-08-19 fixes are not running in production.** The worker's own public
   `/healthz` reports `bootedAt: 2026-08-18T21:47:41.402Z` with an uptime consistent with no
   restart since. A process cannot contain code committed after it booted, so commits `3b29456`
   (03:46), `9f95e31` (03:49), `e277d5c` (03:54) and `6637ae5` (04:11) are **definitively not
   live**. Corroborated independently: 8,895 rows were upserted after 05:00 today and **0** of
   them have `source_title`, which `worker/core/upsert.ts` writes unconditionally since `ac17c4f`
   (2026-08-18 21:48 — one minute after boot).

2. **The Operator's PerfectMind stopgap has already been substantially reverted.** 73 rows were
   hand-corrected. **19** still carry the correction. Every one of those 19 has
   `last_checked_at ≤ 2026-08-18T15:38:55Z` — i.e. **not one of them appeared in any of today's
   three PerfectMind ingest runs** (01:37, 03:38, 05:38). They survive *because they fell out of
   the vendor feed*, not because the correction held. Meanwhile 286 of the 369 PerfectMind rows
   currently reading `all-ages` were re-ingested at or after 05:00 today, by the pre-fix parser
   that re-asserts `All ages` unconditionally. **A hand correction applied to a row that is still
   in the feed is overwritten within ~2 hours.** This is the single most important operational
   finding in this document (§9).

3. **Production retains almost nothing to re-derive from.** There is no raw-payload column or
   table anywhere in the 33 applied migrations. `description_snippet` is **0/12,949** populated
   and no adapter has ever written it. `source_title` is **0/12,949**. The only surviving inputs
   are the listing title (`activity_name`) and `occurrence_age.age_notes` — and `age_notes` echoes
   the source's raw wording **only for parses that failed**. The rows whose input is perfectly
   recoverable are the harmless ones (null bounds); the rows carrying a harmful positive claim are
   exactly the ones whose input is gone. This is a structural limit, not a gap in effort (§4).

4. **Two of the eight classes have zero stale rows, and one has one.** Measured, not assumed.
   Class 1 (age-fallback) has never written to production at all. Class 8 (library) only ever
   *adds* a claim, so it cannot strand one.

---

## 3. Per-class results

| # | Fix class | Commit(s) | Live? | Stale (confirmed) | Ambiguous | Self-heals | Measurable? |
|---|---|---|---|---|---|---|---|
| 1 | LLM age-fallback provenance | `e88ebe8`, `2e6af0f` | yes | **0** | 0 | 0 | fully |
| 2 | venue open-hours "All ages" | `959d123` | yes | **1** | 0 | 0 | fully |
| 3 | ActiveNet title age-claim gate | `f15d6c8` | yes | 0 provable | **672 + 1,154 + 116** | 0 | partial |
| 4 | CityCalendar adult-subject | `f59cd71` | yes | 0 from stored data | 0 identifiable | 0 | candidate-only |
| 5 | PerfectMind NoAgeRestriction | `9f95e31` | **NO** | **109** | 0 | 0 | via proxy |
| 6 | ActiveNet title-gate widen | `3b29456` | **NO** | (folded into 3) | (folded into 3) | 0 | partial |
| 7 | ActiveNet description precedence | `6637ae5` | **NO** | — | — | — | **not measurable** |
| 8 | Library title-anchored age | `e277d5c` | **NO** | **0** | 0 | 9 | fully (positive half) |

"Live?" = present in the build that booted 2026-08-18T21:47:41Z. Classes 1–4 were committed
between 20:33 and 21:09 on 2026-08-18 and are *probably* in that build, but the exact release
contents cannot be determined from the database or from `/healthz` — **the Operator should
confirm against the Fly release log.** Nothing below depends on that: see §3.3.

### 3.1 Class 1 — LLM age-fallback provenance (`e88ebe8`, `2e6af0f`) — **0 stale rows**

`age_notes` marker shapes across all 12,680 `occurrence_age` rows:

| shape | count |
|---|---|
| legacy `llm-resolved: …` (source wording destroyed) | **0** |
| legacy `llm-unresolved: …` | **0** |
| current `… (llm-resolved)` | **0** |
| current `… (llm-unresolved)` | **0** |

The LLM age-fallback job has never written to production. `e88ebe8`'s stale-row class is empty.

`2e6af0f` is a **read-side** fix — it widened `AGE_NOTES_MARKER` in `lib/search/filters/audience.ts`
so the adult exclusion steps over a `llm-unresolved:` prefix. A read-side fix corrects historical
rows *on the next read*, with no backfill by construction. Its own commit message says it could
not be measured without prod access; it can now be: **0 rows in that shape, so it is currently a
no-op** — correctly defensive, but not remediating anything today.

**Recommendation: no action.** Re-run the measurement after the age-fallback job's first
production run, because the `llm-resolved:` shape destroys the source's wording irrecoverably and
is the one shape here that a backfill could never repair from stored data.

### 3.2 Class 2 — venue open-hours fabricated "All ages" (`959d123`) — **1 stale row**

```
[stale_3h] "General Admission"   (H.R. MacMillan Space Centre)
    stored : [0, ∞) bands=5 notes="all-ages"
    derived: no claim (the fixed builder emits no ageText at all)
```

`buildOpenHoursRecord` no longer emits any `ageText`, unconditionally. There is no input to
re-derive and no ambiguity: **every** open-hours row holding a claim is stale by construction.
Production has exactly one such row. It is reachable by a parent today (the adult/senior search
exclusion does not hide it) and it claims all five age bands.

**Recommendation: hand-correct, one row.** This is the cheapest, least ambiguous correction in the
entire scope and needs no tooling. It has not been re-ingested since the worker booted
(`last_checked_at = 2026-08-18T15:30:34Z`), and because the fixed builder never writes an
`ageText`, a correction here **will hold** — this class is immune to the reversion problem in §9.

### 3.3 Classes 3 + 6 — ActiveNet title-manufactured age claims (`f15d6c8`, `3b29456`)

10,600 ActiveNet occurrences; **3,019 hold a positive age claim**. The fixed `extractAgeText`
admits the title only if `titleStatesAge()` passes; that decision is a pure function of the title
and is exactly reproducible. What is *not* reproducible is whether a description phrase survived
alongside it, because the description is gone.

| bucket | rows | of which re-ingested by the deployed build |
|---|---|---|
| title still admitted by the fixed gate → **provably unaffected** | 1,077 | 805 |
| **candidate**: gate rejects the title AND `parseAgeText(title)` exactly reproduces the stored bounds | **672** | **504** |
| gate rejects the title, but the stored bounds do not match a title-only parse | 1,154 | 766 |
| gate admits the title but bounds differ (description unknown) | 116 | 87 |
| title-only re-derivation already matches the stored bounds | 6 | 6 |
| no positive claim either side | 7,575 | 5,605 |
| **total** | **10,600** | **7,768** |

Of the 1,942 ambiguous rows, **1,879 are reachable by a parent today** (only 63 are already
hidden by the shipped adult/senior exclusion). Representative:

```
"Baby Jellyfish Playtime - M/Tu/W/Th/F"        stored [0, 24) bands=1   → title rejected by fixed gate
"1.0-1.5 NTRP - Adult Beginner Tennis Lessons" stored [0, 24) bands=1   → adult tennis labelled UNDER-2s
"| Length Swim (50m) |"                        stored [0, ∞) bands=5
"Guitar/Ukelele- Private Lessons"              stored [0, ∞) bands=5
```

**Why "candidate" and not "confirmed".** A row is only *provably* stale if we can show today's
parser produces nothing for it, and that needs the description. The 672 are rows where the title
alone reproduces the stored bounds exactly — strong evidence the claim was title-manufactured,
which is precisely what these fixes withdraw — but a description phrase resolving to the same
bounds cannot be excluded. **They are not to be auto-corrected.** They are the correct input to a
diff-and-review queue.

**The 504 figure is the interesting one.** Those rows were re-ingested *by the currently deployed
build* and still hold a claim that build's parser would not manufacture from the title. Two
readings, and they converge:

- If `f15d6c8` **is** in the deployed build: the fixed gate refused the title, ingest wrote
  nothing, the stale value survived a real post-fix re-ingest. §3h **observed at scale**, not
  predicted.
- If it **is not**: the old parser is re-writing the same wrong value every cycle, and the rows
  become §3h-stale the moment the fix deploys.

Either way the remediation is the same: **deploy, then correct; correcting first is wasted work.**

**Recommendation: (c) diff-and-flag for review, not an automated correction.** Start with the 672
candidates, prioritising the 1,879 parent-reachable rows. Re-run the harness *after* the fixed
build is deployed and one full ActiveNet cycle has completed — the population will shrink to the
rows that genuinely cannot self-heal, and correcting before that measures the wrong set. Do not
mechanically clear the 1,154 "source unknown" rows: their stored bounds did not come from the
title, so this fix is not what made them wrong.

### 3.4 Class 4 — CityCalendar adult-subject suppression (`f59cd71`) — **not measurable from stored data**

49 city_calendar occurrences; 18 have an age row; 10 read `all-ages`. Driving the real adapter
with each stored title plus a synthetic catch-all `Audiences` tag yields **0 rows** where the
title alone triggers `namesAdultOnlySubject`.

That is a real result, not a null one, and it has a clean explanation. The suppression reads
`title + description`, and the wording it suppresses comes from the Trumba `customFields`
`Audiences` value. **Neither the description nor `customFields` is persisted** — `StructuredRecord.raw`
carries the whole Trumba event but is never written to any column. The flagship
"International Overdose Awareness Day" row, whose title *does* contain the decisive
`\boverdose\b`, was already hand-corrected by the Operator and so no longer reads `all-ages`.

**Recommendation: (b) targeted re-ingest, not backfill.** Only 49 rows, one source, and the
adapter is a pure function of a feed that is still online. Re-fetching
`trumba.com/calendars/city-of-vancouver-events.json` and joining `eventID` →
`activity_occurrence.source_record_id` reconstructs the true inputs exactly. Caveat, and it is
the reason this is not free: a rolling calendar feed no longer carries past-dated occurrences, so
some stored rows will have no counterpart and must be flagged rather than assumed correct.

### 3.5 Class 5 — PerfectMind NoAgeRestriction (`9f95e31`) — **109 stale rows**

The fix fires on a conjunction: the vendor's `NoAgeRestriction` flag was true **and** the title
states an age. The flag is not stored, but it is recoverable by a one-to-one proxy — the flag's
branch is the only PerfectMind path emitting the literal `ageText: 'All ages'`, and
`notes: 'all-ages'` is written by exactly one branch of `parseAgeText`. So
`age_notes = 'all-ages'` ⇒ this row came from the flag branch. 369 rows qualify.

Driving the **real** fixed `resolveAgeText({ EventName: activity_name, NoAgeRestriction: true })`
over those 369:

| verdict | rows | re-ingested by the deployed build |
|---|---|---|
| `no-age-restriction-contradicted` → claim withdrawn → **§3h stale** | **109** | 95 |
| flag still believed, bounds already match | 260 | 198 |

**50 of the 109 are already hidden** by the shipped adult/senior title exclusion.
**59 are reachable by a parent today.** Samples:

```
"Adult 19yrs+ Swim Karen Magnussen Thursday 8:00-9:00am"    [0, ∞) bands=5   (masked by title exclusion)
"$3 Open Gym 8yrs+ Parkgate Wednesday 6:15-7:45am"          [0, ∞) bands=5   (REACHABLE)
"Lynn Creek Youth Centre Tuesday 3:30pm-5:30pm (Grade 4-7)" [0, ∞) bands=5   (REACHABLE)
```

Two caveats stated rather than smoothed over:

- **The 109 excludes the Operator's corrections**, whose `age_notes` no longer reads `all-ages`
  and which therefore drop out of the proxy. The true pre-stopgap population was larger.
- **One observed behaviour is worth a decision, not a silent acceptance.** PerfectMind's title
  gate deliberately omits the date/grade veto that ActiveNet's carries, so
  `"… (Grade 4-7)"` matches as if `4-7` were an age range. The fix's outcome — withhold the claim
  — is still safer than asserting all-ages, but the row ends with *no* age information where the
  source stated a grade band. Flagging as a follow-up, not as a defect in this scope.

**Recommendation: (a) re-derive from the title, but ONLY after deploying `9f95e31`, and apply as
a reviewed batch.** This is the one class where the fixed parser's decision is fully reproducible
from stored data, so the corrective write is exactly computable: `age_min_months = NULL`,
`age_max_months = NULL`, `age_band_matches = '{}'`, and an `age_notes` provenance string. Prioritise
the 59 parent-reachable rows. **Correcting before deploying is worse than doing nothing** — see §9.

### 3.6 Class 7 — ActiveNet description-phrase precedence (`6637ae5`) — **not measurable**

`statedAgePhrase()` needs the full description text *and* the character offsets of every numeric
match, to evaluate an ±80-character disqualifier window around each. `description_snippet` is NULL
on 100% of rows and no adapter has ever written it; `age_notes` stores the phrase the old parser
*chose*, never the prose it chose from, so it supplies neither the surrounding text nor the offsets.

The affected population is also structurally invisible: this fix only fires when the leftmost
match is a keyword (`all ages|preschool|toddlers|babies|youth|teens`), and every one of those
keywords *resolves* under `parseAgeText` — so an affected row is a resolved row with
`age_notes = NULL`. **Candidates cannot even be counted.**

**This is reported as out of scope, NOT as "0 changed".** Its commit measured 153 records / 25
programmes against the live feed. That number is not verifiable against stored data by any means.

**Recommendation: (b) targeted re-ingest is the only mechanism** that can touch this class, and
it is the natural side-effect of deploying the fix. No backfill is possible or should be attempted.

### 3.7 Class 8 — Library title-anchored age (`e277d5c`) — **0 stale rows**

783 `library_bibliocommons` occurrences (503 VPL + 280 RPL).

| outcome | rows |
|---|---|
| title states no age → fix cannot change the row | 741 |
| title age already matches stored bounds | 33 |
| title age would **overwrite** stored bounds on re-ingest → **self-heals** | 9 |
| **stale** | **0** |

This class is structurally incapable of stranding a row: the bug was title-*blindness*, so the fix
only ever **adds** a claim. It never withdraws one, so `if (ageParse)` is never the branch taken.

The title-only re-derivation is *provable* here rather than merely indicative: `AGE_RANGE_RE` is
non-global (leftmost match wins), the title is the prefix of the haystack, and the pattern is
terminated by `.` while `ageHaystack` joins with `". "` — so a title-internal match is
byte-identical whether the description is present or empty.

Two scope notes: the `genericRssAgeWording` half of `e277d5c` serves only the `library_generic_rss`
family, which has **zero production rows** — it is untestable in prod and needs no backfill. And
zero `audience:` notes across all 12,680 age rows proves the BiblioCommons **audience-tag tier has
never written to production**, so these 783 rows were written by pre-2026-08-16 code, two
generations behind HEAD.

**Recommendation: no backfill. Deploy and let the 9 rows self-heal.**

---

## 4. What production retains, and why that is the binding constraint

Checked across all 33 applied migrations: **there is no raw-source-payload column or table.**
Not on `activity_occurrence`, not on `activity_series`, not on `source_check_run`. The adapters
build a `StructuredRecord.raw` holding the whole vendor object and it is **never persisted**.

| candidate input | populated | usable |
|---|---|---|
| `activity_occurrence.activity_name` | 12,949 / 12,949 | **yes** — and it is the *raw* source title (see below) |
| `occurrence_age.age_notes` | 9,288 / 12,680 | **partially** — echoes raw wording only for failed parses |
| `activity_occurrence.source_title` | **0** / 12,949 | no |
| `activity_occurrence.description_snippet` | **0** / 12,949 | no |
| vendor structured fields (`NoAgeRestriction`, Trumba `Audiences`, BiblioCommons categories) | not a column | no — proxy only |

`source_title` being 0-populated is doubly informative. `worker/core/upsert.ts` writes it on
*every* upsert since `ac17c4f`, so NULL means "not re-ingested since that build shipped" — which
(a) proves the deployed worker predates it, and (b) guarantees `activity_name` still holds the
**un-normalised source wording**, which is exactly the string the adapters' age gates saw. The
title-only re-derivations in this document are therefore operating on the real input, not a
normalised derivative.

`age_notes` retains the raw `ageText` **only** via `` `unresolved: ${ageText}` ``. Resolved parses
write `'all-ages'` or NULL. The uncomfortable structural consequence, stated plainly:

> The rows whose parser input is perfectly recoverable are the **unresolved** ones — null bounds,
> harmless. The rows carrying a **harmful positive claim** are exactly the resolved ones, whose
> `age_notes` is NULL and whose description is gone.

No amount of additional analysis defeats that. It is why classes 3 and 4 top out at "candidate"
and class 7 cannot be measured at all.

---

## 5. Recommended mechanism per class

The brief's three options — (a) re-derive from stored payload, (b) targeted re-ingest, (c)
diff-and-flag for manual review. **No single mechanism fits all eight.**

| # | Class | Mechanism | Why |
|---|---|---|---|
| 1 | age-fallback | **none** | 0 rows. Re-measure after the job's first prod run. |
| 2 | venue-allages | **hand-correct, 1 row** | Unambiguous by construction; too small to automate; immune to reversion. |
| 3+6 | ActiveNet title gate | **(c) diff-and-flag** | Description unrecoverable ⇒ candidates only. 672 to review, 1,879 parent-reachable. Re-measure post-deploy first. |
| 4 | CityCalendar | **(b) targeted re-ingest** | 49 rows, feed still online, true inputs reconstructable by `eventID`. Expired occurrences must be flagged, not assumed. |
| 5 | PerfectMind | **(a) re-derive from title, reviewed batch** | Fixed parser's decision fully reproducible; corrective write exactly computable. **Deploy first.** |
| 7 | ActiveNet description precedence | **(b) re-ingest only** | Backfill impossible — inputs and even the candidate set are unrecoverable. |
| 8 | Library | **none** | Fix only adds claims; 9 rows self-heal on re-ingest. |

**Total confirmed stale rows needing a write: 110** (1 venue + 109 PerfectMind), of which **60 are
reachable by a parent today**. Plus **672 ActiveNet candidates** requiring review rather than
correction. That is the honest size of this problem — not 12,949, and not the 5,169 rows that hold
a positive age claim.

---

## 6. Ambiguous cases — reported, never guessed

Following the Operator's own discipline on the ~55 PerfectMind rows they deliberately left alone:

| category | count | why it is ambiguous |
|---|---|---|
| ActiveNet, title rejected, stored bounds match a title-only parse | **672** | Consistent with a title-manufactured claim, but a description phrase resolving to the same bounds cannot be excluded. |
| ActiveNet, title rejected, stored bounds do **not** match a title-only parse | **1,154** | The stored claim came from somewhere other than the title. This fix is probably not what made it wrong. |
| ActiveNet, title admitted, bounds differ | **116** | Only the unmeasurable class 7 could explain the difference. |
| CityCalendar `all-ages` rows, title alone does not trigger suppression | **10** | The lost description can move the guard in *both* directions. |
| PerfectMind grade-in-title rows inside the 109 | (subset) | The fixed gate reads `Grade 4-7` as an age range; withholding is safe but discards a real grade band. |

None of these should be auto-corrected. The 672 are the only bucket worth queueing for review.

---

## 7. Schema change needed for *measurement*? No.

Flagged as the brief requires: **no migration and no schema change is needed to measure any of
this.** Everything in this document came from `SELECT`s against the existing schema.

Separately — and explicitly **not** proposed here, because it is a product decision and a
different unit of work — the single change that would make this class of problem measurable in
future is retaining the parser's *input* (the raw source payload, or at minimum the description
text) alongside the derived value. Every "not measurable" verdict above traces to its absence.
Recording that as an observation, not a recommendation.

---

## 8. Re-running the measurement

```bash
# Read-only. Requires a connection string; never defaults to one.
DATABASE_URL='<connection string>' bash scripts/backfill-scope/measure.sh \
  --deployed-since 2026-08-18T21:47:41.402Z \
  --json .backfill-scope.json \
  --samples 20
```

`--deployed-since` takes `bootedAt` from the worker's own public health endpoint
(`curl -s https://kids-fun-worker.fly.dev/healthz`). Supplying it is what separates an
**observation** ("this row already survived a post-fix re-ingest") from a **prediction** ("it
would"). Without it the tool says so, rather than blurring the two.

Files:

| file | role |
|---|---|
| `scripts/backfill-scope/readonly-db.ts` | The only DB access. Read-only by construction (§11). |
| `scripts/backfill-scope/fix-classes.ts` | One re-derivation rule per fix class. Pure; no DB, no network, no clock. |
| `scripts/backfill-scope/measure.ts` | Driver: fetch → classify → tally → render. |
| `scripts/backfill-scope/measure.sh` | esbuild wrapper, same pattern as `safety-audit.sh`. |

Each class drives the **real shipped parser** through its exported entry point with a synthetic
record — `resolveAgeText({ EventName, NoAgeRestriction: true })`,
`extractAgeText({ title, description })`, `resolveBiblioCommonsAgeSignal(title, '', [])`,
`CityCalendarAdapter.extract([...])` — rather than a copy of its regexes. Several decisive patterns
are module-private, and a copy would measure a *snapshot* of the fix and rot the first time one is
tuned. What is measured here is what ships.

---

## 9. The reversion problem — read this before scheduling any correction

**A correction applied while the pre-fix parser is still deployed will be silently reverted, and
the evidence that this already happened is in production right now.**

- The Operator hand-corrected **73** PerfectMind rows. **19** still carry the correction.
- All 19 have `last_checked_at ≤ 2026-08-18T15:38:55Z` — **none appeared in any of today's three
  PerfectMind ingest runs** (01:37, 03:38, 05:38). They survive because they left the vendor feed.
- 286 of the 369 PerfectMind rows currently reading `all-ages` were re-ingested at or after 05:00
  today, by a build that cannot contain `9f95e31` and whose parser therefore returns
  `ageText: 'All ages'` unconditionally for a `NoAgeRestriction` record.
- `upsertOccurrenceAge` overwrites whenever the parser makes *any* claim. So every corrected row
  still in the feed was overwritten back to `[0, ∞)`, all five bands, within hours.

PerfectMind ingests roughly every two hours. **The corrective window for a row still in the feed
is under two hours until the fixed build is deployed.**

Therefore, in order:

1. **Deploy the four 2026-08-19 fixes.** Until then, corrections to classes 3–7 are wasted work
   and produce a misleading audit trail. (Class 2 is exempt — the fixed builder never writes an
   `ageText`, so nothing re-asserts the stale value.)
2. **Let one full ingest cycle complete** for each affected source.
3. **Re-run this harness.** The population will shrink to rows that genuinely cannot self-heal.
   Correcting the pre-deploy set means correcting the wrong set.
4. **Then** apply reviewed corrections, Operator sign-off per class, smallest and least ambiguous
   first (class 2's single row, then PerfectMind's 59 parent-reachable rows).

One further note on correction *shape*. The Operator wrote provenance prose into `age_notes`,
which is the right instinct — it is distinguishable from "never had a row" and preserves the audit
trail. But `age_notes` is read at query time by `isAdultOrSeniorOnly()`, a **hard** exclusion with
no user-facing escape hatch: it strips a known marker prefix, splits on `[,|;\n]`, and anchors an
adult-tag match at each segment's start, with whole-field vetoes for supervision and
parent-and-child prose. The Operator's actual note is safe (verified against the shipped
predicate). Future correction text should be checked against that filter rather than composed
freely — a note beginning "Adults…", or one containing the word "ratio", changes what the search
filter concludes about the listing.

---

## 10. Scope boundary

Not addressed here, deliberately: whether `if (ageParse)` should learn to clear a stale row when a
fixed parser withdraws a claim. That is a **worker behaviour change** — it would make every future
parser fix self-healing and shrink this entire problem class to zero — but it is a separate,
separately-reviewable unit with its own risk (an adapter that transiently fails to see an age
field would start *erasing* good data). Recording it as the obvious follow-up. Not smuggling it in.

## 11. Read-only guarantees

The tooling **cannot** write. Three independent locks:

1. **Postgres-enforced.** Every statement runs inside an explicit `BEGIN TRANSACTION READ ONLY`;
   the session default is set read-only too. The *server* rejects any write with SQLSTATE 25006,
   before the statement is even parsed. A bug in the guard below cannot defeat this.
2. **Statement-shape guard.** `query()` refuses anything whose first keyword is not `SELECT`/`WITH`,
   refuses data-modifying CTEs (`WITH … INSERT/UPDATE/DELETE`, which are legal Postgres and would
   pass a naive check), and refuses stacked statements.
3. **No write surface is imported.** Nothing under `scripts/backfill-scope/` imports
   `upsertOccurrenceAge`, `upsertOccurrence`, or anything from `worker/core/ingest.ts`. There is no
   code path from this tool to a write; adding one takes a deliberate edit to two files.

`DATABASE_URL` is never defaulted and never read from a credential store by the tooling — pointing
it at production is an explicit act by the operator running it.

**No production or staging row was written during this work. No migration was authored. No
automation capable of writing was built.**
