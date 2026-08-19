# §3.4 CityCalendar — targeted re-ingest RECONCILIATION

**Status: MEASUREMENT ONLY. Not one production row was written, and the tooling cannot write
one.** Branch `design/kf-cc-reingest-recon`. Measured against **production**
(`kids-fun-supabase-prod`) on **2026-08-19**, read-only, via
`scripts/backfill-scope/citycalendar-recon.sh`.

This is the follow-through on `docs/worker-fix-backfill-scope.md` §3.4 and §5, which recommended
mechanism **(b) targeted re-ingest** for fix class 4 (`f59cd71`, CityCalendar adult-subject
suppression) and could not go further because production persists neither the event description
nor the Trumba `customFields`. This document reports what the live feed says. It **proposes**
nothing to apply; a write to any row below still requires the Operator's sign-off.

---

## 1. Why this needed doing at all, and why the recheck's `ambiguous: 0` is not an answer

The post-redeploy recheck reports `ambiguous: 0` for class 4. That is a bucket-label artefact,
not a resolution, and the underlying data says so plainly. All 49 rows land in
`not_applicable`, split:

| reason | rows |
|---|---|
| `citycalendar:stored-wording-was-not-a-catch-all` | 39 |
| `citycalendar:title-alone-does-not-trigger-suppression` | **10** |

Those 10 are character-for-character the 10 rows §6 lists as ambiguous. `fix-classes.ts` returns
`ambiguous` only when the title-only re-derivation *suppresses* AND a positive claim is stored;
when the title alone does not trip `namesAdultOnlySubject` it falls through to `not_applicable`
regardless of what the missing description might have done. The count moved. The uncertainty did
not.

To keep that link checkable rather than asserted, every finding this tool emits carries a
`priorBucket` field obtained by **calling `fix-classes.classifyCityCalendar` itself**, so the two
measurements join on a computed label instead of a hand-copied list of ten IDs.

## 2. Method

1. Read all non-archived `city_calendar` occurrences read-only, through the unmodified
   `scripts/backfill-scope/readonly-db.ts` (§11's three locks, untouched).
2. Fetch `https://www.trumba.com/calendars/city-of-vancouver-events.json` — the URL in
   `worker/adapters/citycalendar/config.ts`, one identified plain GET.
3. Drive the **real shipped adapter**: `new CityCalendarAdapter(getCityCalendar('vancouver'))
   .extract(events)`, on the real events. `ageText()`, `isCatchAllAudience()` and
   `namesAdultOnlySubject()` are module-private and are executed, never copied — a
   re-implementation would prove only that two copies of a regex agree.
4. Reproduce `worker/core/ingest.ts:237-239` verbatim to turn the adapter's `ageText` into the
   `AgeParse` a re-ingest would write, join `eventID` → `activity_occurrence.source_record_id`,
   and diff against the stored row.

**Not** used: `adapter.fetch()`. It slices to `config.liveEventsLimit` (40), which for a
reconciliation would silently convert joinable rows into "no live counterpart" — manufacturing
the exact outcome this report must not manufacture. The cap is checked and logged instead. It is
also gated behind an ingest-enablement env flag and routes through `politeFetch`'s process-global
backoff/rate-limiter state, neither of which belongs in a one-shot measurement. Nothing that
decides an age is re-implemented; only the transport is.

## 3. The verdict is three-valued, and the third value is load-bearing

`confirms` / `contradicts` / **`cannot-speak`**. §3.4 names the reason the third one has to exist:
a rolling calendar feed drops past-dated occurrences, so a stored row's absence from today's fetch
is a property of the feed window and carries no information about the row in either direction.
Folding those into `confirms` would convert "we did not look" into "we checked and it was fine"
across 39% of the population. They are counted separately, and nothing is inferred from them.

## 4. Results — 2026-08-19T15:44Z

```
city_calendar rows, all           49
  archived (out of scope)          0
  in scope (archived_at IS NULL)  49
  of those, no source_record_id    0
events in feed                    30      (all 30 kept by the shipped extract() filter,
                                           and all 30 joined to a stored row)

confirms                          30   (61.2%)
contradicts                        0    (0.0%)
cannot-speak                      19   (38.8%)

  of the contradictions, needing an Operator write (§3h stale):  0
                         self-healing on the next re-ingest   :  0
```

**No stored claim is contradicted by the live feed. There is no §3h-stale row in this class, and
therefore nothing to ask the Operator for.**

### 4.1 The 10 — `title-alone-does-not-trigger-suppression`, row by row

| eventID | listing | stored | live verdict |
|---|---|---|---|
| 206159025 | All Candidates Meeting: False Creek Community Centre | `[0, ∞)` all-ages | **confirms** |
| 206174273 | 2026 Vancouver TAIWANfest | `[0, ∞)` all-ages | **confirms** |
| 150182640 | National Day of Remembrance and Action on Violence Against Women | `[0, ∞)` all-ages | **confirms** |
| 150182023 | Police and Peace Officers' National Memorial Day | `[0, ∞)` all-ages | **confirms** |
| 150182228 | Firefighters' National Memorial Day | `[0, ∞)` all-ages | **confirms** |
| 150182437 | Remembrance Day | `[0, ∞)` all-ages | **confirms** |
| 206479248 | Port Day, presented by the Vancouver Fraser Port Authority | `[0, ∞)` all-ages | **confirms** |
| 206476602 | Creekside Movie Night | `[0, ∞)` all-ages | **cannot-speak** |
| 204769892 | Music in the Park | `[0, ∞)` all-ages | **cannot-speak** |
| 206698998 | Public Disco Granville Street Pedestrian Zone Pop-Up | `[0, ∞)` all-ages | **cannot-speak** |

7 confirmed with the true inputs restored, 3 still unknowable, 0 contradicted. For six of the
seven the feed's `Audiences` field really is `All ages` and the shipped guard does **not** fire on
the restored title+description; for `2026 Vancouver TAIWANfest` there is no `Audiences` field at
all and the wording came from the prose scan. The lost description does not move the guard on any
of the seven — which is the answer §3.4 could not reach and the reason this class needed a fetch
rather than more analysis.

### 4.2 The flagship row, closed by observation rather than argument

`150181808` "International Overdose Awareness" is in the live feed, tagged `Audiences: All ages`,
with `"City Hall's flag will be at half-mast…"` as its description. The shipped adapter
**withholds** the wording (`suppressionFired: true`). Production holds **no `occurrence_age` row**
for it, so live and stored agree exactly.

That is also a direct observation that `f59cd71` is running in production, not an inference from
its commit timestamp: the deployed build re-ingested this occurrence at `2026-08-19T15:39:20.905Z`
and the newest `age_min_months` provenance fact on it is from `2026-08-18T16:05:08.181Z`.
`worker/core/ingest.ts:303` appends that fact whenever `ageParse.resolved`, so the run that just
happened resolved no age claim for a row whose `Audiences` tag says `All ages`. The pre-fix
adapter would have written `[0, ∞)`.

### 4.3 A self-heal caught in the act

The first run of this tool, at ~15:36Z, found exactly one contradiction:

```
[contradicts/self_heals_on_reingest] "Free Synchronized Swimming Try-it Class for Kids"
    occurrence  : 7f9dcaef-82b6-4f4b-acdb-dc4b14d5bb7c  eventID=204262943
    stored      : [60, 144) bands=2 notes=NULL      last_checked_at 2026-08-18T21:55:06.872Z
    derived     : [84, 144) resolved=true notes=NULL
```

This is `AGE_RANGE_RE`'s own row — the adapter comment names it — and `AGE_RANGE_RE` shipped in
`e277d5c` (2026-08-19 03:54), after the *previous* worker boot but before the current one
(`bootedAt 2026-08-19T06:28:06.333Z`). The city_calendar source was then re-ingested at
`2026-08-19T15:39:19.982Z`, between that run and the next, and the row now reads `[84, 144)` —
exactly the derived value. The `self_heals_on_reingest` classification was a prediction at 15:36
and an observation three minutes later. Recorded because it is the cleanest available evidence
that the remedy taxonomy is calibrated, and because the pre-ingest value is otherwise no longer
recoverable from the database.

### 4.4 No live counterpart — 19 rows

All 19 are `no-live-counterpart:not-in-current-feed`. No row failed to join for want of a
`source_record_id`, and no feed event was dropped by the shipped `extract()` filter. **14 hold no
`occurrence_age` row at all**, so even if the feed could speak there would be no claim to
contradict. **5 hold a positive claim** and are the residue this class cannot close:

| eventID | stored | listing |
|---|---|---|
| 206476602 | `[0, ∞)` all-ages | Creekside Movie Night |
| 204769892 | `[0, ∞)` all-ages | Music in the Park |
| 206698998 | `[0, ∞)` all-ages | Public Disco Granville Street Pedestrian Zone Pop-Up |
| 204262942 | `[60, 144)` | Free Synchronized Swimming Try-it Class for Kids |
| 204262941 | `[60, 144)` | Free Synchronized Swimming Try-it Class for Kids |

**Observation, deliberately not upgraded to a verdict.** The last two share a listing title with
`204262943`, the row §4.3 watched self-heal from `[60, 144)` to `[84, 144)`. If they are past
occurrences of that same programme then they hold the value the live sibling was just corrected
away from, and — having fallen out of the feed — no future re-ingest will ever touch them. That
is a strong inference and it is still an inference: the tool reports them as `cannot-speak`, and
this paragraph is the evidence for a human to weigh, not a classification. Correcting them would
need the same Operator sign-off as anything else here.

## 5. Observation this reconciliation surfaced but does not act on

Six rows re-ingested minutes ago by the deployed build read `[0, ∞)` — all five age bands,
including `under2` — from an `Audiences: All ages` tag on subject matter that is a civic
observance, not programming for a baby:

- National Day of Remembrance and Action on Violence Against Women
- Police and Peace Officers' National Memorial Day
- Firefighters' National Memorial Day
- Remembrance Day
- All Candidates Meeting: False Creek Community Centre
- (`Port Day` is genuinely a public family event and is not in question.)

Their descriptions are, verbatim, `"Citywide, flags will be at half-mast in honour of …"` — the
same sentence, from the same template, as the overdose row that motivated `f59cd71`. The
reconciliation verdict on all of them is honestly `confirms`: stored equals what today's code
writes. The point is what today's code writes. `ADULT_SUBJECT_RE` enumerates named adult
subjects (overdose, suicide, bereavement, domestic violence, dementia, tax, …) and none of these
match — "Violence Against Women" is not "domestic violence", and a flag-lowering is not on the
list at all.

Recorded as an observation with a possible shape (a flag-at-half-mast / memorial-observance
marker, or an `Event Type`-driven rule) and **explicitly not proposed here**: it is a change to a
shipped ingest guard, it needs its own measurement of what it would suppress across the whole
feed, and smuggling it into a read-only reconciliation is exactly the move this document's
discipline exists to prevent.

## 6. Re-running it

```bash
# Read-only. Requires a connection string; never defaults to one.
DATABASE_URL='<connection string>' bash scripts/backfill-scope/citycalendar-recon.sh \
  --deployed-since 2026-08-19T06:28:06.333Z \
  --save-feed .citycalendar-feed.json \
  --json .citycalendar-recon.json
```

`--deployed-since` takes `bootedAt` from the worker's own public health endpoint
(`curl -s https://kids-fun-worker.fly.dev/healthz`), same contract as `measure.sh`: without it,
statements about what a re-ingest would do are predictions rather than observations, and the
report says which.

Because the feed is **rolling**, a re-run an hour later is not checking the same input. That is
why `--save-feed` writes the exact bytes a run classified and `--feed-file` replays them — every
row-level claim above is reproducible against a fixed input rather than against whatever the City
is publishing at the moment you look. The §4 tallies were produced identically from a replayed
capture and from a fresh fetch.

| file | role |
|---|---|
| `scripts/backfill-scope/citycalendar-recon.ts` | Join + classify. Pure: no DB, no network, no clock. |
| `scripts/backfill-scope/citycalendar-recon-run.ts` | Driver: fetch → drive the real adapter → read → diff → render. |
| `scripts/backfill-scope/citycalendar-recon.sh` | esbuild wrapper, same pattern as `measure.sh`. |
| `tests/backfill-scope/citycalendar-recon.test.ts` | 47 tests, driving the real adapter. |

## 7. Read-only guarantees

Unchanged from `docs/worker-fix-backfill-scope.md` §11, and inherited rather than re-implemented:
the only database access is `scripts/backfill-scope/readonly-db.ts`, whose three locks were not
touched by this unit. Neither new file imports `upsertOccurrenceAge`, `upsertOccurrence`, or
anything from `worker/core/ingest.ts` — the ingest age expression is *mirrored* in
`ingestAgeParse()`, which calls only the pure parsers `parseAgeText` / `parseAudienceLabels`.
The tool makes exactly one outbound request, a GET to a public municipal calendar feed, and
`--feed-file` removes even that.

Checkable mechanically rather than taken on the paragraph above — the shipped bundle contains no
write statement of any shape, because esbuild tree-shakes the unused writer out of
`worker/core/age.ts`:

```bash
node_modules/.bin/esbuild scripts/backfill-scope/citycalendar-recon-run.ts \
  --bundle --platform=node --format=esm --target=node20 --external:pg --outfile=/tmp/b.mjs
grep -ciE 'insert into|update [a-z_]+ set|delete from|truncate' /tmp/b.mjs   # → 0
grep -c  'BEGIN TRANSACTION READ ONLY' /tmp/b.mjs                            # → 1
```

**No production or staging row was written during this work. No migration was authored. No
automation capable of writing was built.**
