# Catalogue safety auditor

A recurring, read-only batch job that sweeps the whole live catalogue and flags listings whose
**source text contradicts a label we derived from it**. It exists because two severity-3
child-safety mislabels were found *by chance* by 2 of 15 testers, and finding that class by
chance does not scale.

Nothing in it writes. It makes `GET /api/search` calls and produces a report.

---

## The four patterns it detects today

| Rule id | What it catches | Real instance |
|---|---|---|
| `outdoor_source_indoor_tag` | Source says outdoor; the card renders **Indoor / Rainy-day friendly** | `Sportball Outdoor Soccer (5-7yrs) Rain/Shine` → `suitabilityTags: ['outdoor','indoor']` |
| `adult_source_child_bands` | Source names an adult **audience**; the listing reaches a **child age filter** | `Supporting People Together: The Basics of Overdose Response`, `age_notes: "…, Adults, English"`, `ageBandMatches: []` → returned by `ages=2-4` |
| `adult_subject_child_bands` | Source's **subject** is adult-only; the listing **affirmatively claims** a child band | `International Overdose Awareness`, `age_notes: "all-ages"`, `ageBandMatches: [under2, 2-4, 5-9, 10-14, 15+]` |
| `adult_title_child_bands` | The programme's **name** is adult-only by convention; the listing reaches a **child age filter** | `Aquafit - Deep`, `age_notes: "Aquafit - Deep"`, `ageBandMatches: []` → returned by `ages=2-4` |

Pattern 2 counts **two** ways a listing reaches a child: it carries a child band, *or* it carries
**no bands at all** — because the search filter's "empty → don't hide" rule then admits it into
every age filter. The tonight instance was the second kind, and a rule that only looked at bands
present would have scored it clean.

### Pattern 3, and what it is NOT

Pattern 3 is often described as "pattern 2 but for resolved rows". That is wrong, and the wrong
version is unimplementable: pattern 2 already handles the child-band-present case, and its tests
pin it. The gap it fills is on the **evidence** side.

Pattern 2 asks whether the source names an adult **audience**. On the `International Overdose
Awareness` row there is no audience wording left to read, because resolving an age **destroys**
it: `occurrence_age.age_notes` keeps the raw source string only while a row is unresolved
(`"unresolved: …"`), and this row resolved to `"all-ages"`. So the auditor's `source.ageWording`
for it is the string `all-ages` — *our own output wearing the source's field*. The only adult
signal left is in the title, and it is not an audience, it is a **subject**.

Two consequences are load-bearing:

- Pattern 3's false-positive guards read **title and description only**, never `ageWording`.
  Letting a derived age string satisfy a source-side guard would make the rule unfalsifiable —
  the bug would be its own alibi.
- Pattern 3 requires the child band to be **present**, and deliberately ignores the empty-band
  case. An empty band list is a *known unknown* (the parser said "I cannot tell", and the filter
  chose to be permissive, which pattern 2 owns); a populated one is a **false statement of
  fact**. Only the second is a claim we made.

Measured against the live catalogue on 2026-08-18 — 4,530 rows, 2,090 of them carrying an
affirmative child band — pattern 3 raises **one strong** candidate (the row above) and **one
weak** one (`Kitsilano MS Support Group`, also tagged all five bands), with no guarded-out rows.
Its subject list is expected to grow one measured entry at a time; adding a term without checking
it against a live sweep is how a severity-3 report starts being filtered to a folder.

### Pattern 4 — the programme's NAME as the claim

Origin: the independent test report's own P1-4 proposal, a title-based regex gate for adult
content surfacing on `swimming` / `library` / `park` queries. It is **not** a replacement for
pattern 3; it asks a third question of the same listing.

Patterns 2 and 3 are both blind to `Aquafit - Deep`: there is no audience word in it, so pattern 2
has nothing to read; "aquafit" is not subject matter, and the row carries no affirmative band, so
pattern 3 does not apply. What makes it adult-only is **naming convention** — in a municipal
recreation catalogue "Aquafit", "Osteofit" and "Master's" name a class a four-year-old cannot be
enrolled in, the way "Storytime" names one for a toddler. Its evidence field is therefore the
**title only**: the title is the programme's *name*, so the convention is a declaration there and
merely a mention anywhere else.

Two deliberate narrowings of the report's proposed word list, both **measured** against the same
4,530-row sweep, not argued:

- `adult` / `senior` / `55+` / `19+` are **already pattern 2's vocabulary**, and re-matching them
  would report one row under two rule ids. Measured cost of the disjointness: **zero** — all 30
  exposed rows whose title contains "adult" are caregiver or shared sessions this rule's guards
  drop anyway, the one "senior" title is a youth volunteer shift, and `55+`/`19+` have no hits.
- `lane swim` is **excluded as a measured false-positive class**: 345 exposed rows across 156
  titles, nearly all NVRC lane swims banded `['5-9','10-14','15+']` — plausibly the *correct*
  derivation, since a lane swim is open to anyone who can swim lengths. Shipping it would put 345
  rows into a severity-3 report and 345 candidates against a 500-candidate adjudication cap.

It adds one guard of its own, because its evidence is title-position naming and this catalogue
puts audience ranges *in* titles: a title stating its own age range or floor below 16 —
`(0-6years)`, `8yrs+`, `Tennis 4-6 yrs` — has named a child audience as plainly as "kids" would.
605 rows across 290 titles carry such a token. The guard is anchored on an explicit year unit so
clock times (`Tuesday 9:00-10:00pm`) and pool geometry (`(1 lanes x 25m)`) can never parse as ages.

Measured through the real prefilter, three rules vs four: **46 → 94 candidates**. The 48 new ones
are 11 titles, all City of Vancouver ActiveNet, all reached by the empty-band shape — **25 strong**
(7 titles / 10 series: Aquafit ×3 titles, Osteofit ×3, `Soccer - Master's Co-Ed`) and **23 weak**
(`Group Fitness - Gentle Fit` and variants, never reported unreviewed). **Zero** are also raised by
another rule, and the other three rules' candidate sets are unchanged by the addition.

A live prefilter-only sweep the same night (4,990 rows, 103.4% coverage, 219 requests) agrees: 97
candidates, 51 of them this rule's, and reported severity-3 findings go **6 → 18** — Aquafit ×4
variants, Osteofit ×5, `Soccer - Master's Co-Ed`, all strong, all empty-band, no false positives in
the reported set. It reproduces end to end on production:
`/api/search?q=aquafit&ages=2-4` returns **16 results, all of them adult aquafit classes**.

### Adding a fifth pattern

One file under `lib/audit/rules/`, one entry in `lib/audit/registry.ts` (plus its `custom_id`
prefix), one test. The prefilter, the LLM stage, the report and the CLI all iterate the registry
and know nothing about how many rules exist. Shared vocabulary — which bands expose a listing to
a child, the supervision-sentence trap guard, the caregiver-programme guard — lives in
`lib/audit/rules/adult-signals.ts` with one owner, so a new rule reuses it rather than growing a
second copy that drifts.

One wrinkle a fifth pattern will hit: `exposedToChildSearch()` is the shared answer to "can a child
search reach this row", but it still lives in `rules/adult-age-band.ts` and patterns 2 and 4 both
use it from there. It belongs in `adult-signals.ts` beside the other shared vocabulary; it was left
where it is because relocating it means editing pattern 2, which pattern 4's change was scoped not
to touch. Move it the next time pattern 2 is opened for another reason.

---

## Architecture

```
  /api/search  ──►  adaptive partition sweep      lib/audit/sources/search-api.ts
                     (no offset param, so the
                      catalogue is partitioned
                      and each cell paged once)
        │
        ▼
   ~4,700 rows ──►  deterministic prefilter        lib/audit/prefilter.ts + rules/
                     pure regex/tag contradiction   → ~70 candidates  (0 tokens, ~1s)
        │
        ▼
   candidates  ──►  Haiku adjudication             lib/llm/safety-audit.ts
                     ONLY the candidates            (existing Message-Batches plumbing)
        │
        ▼
    findings   ──►  report.json + report.md        lib/audit/report.ts
```

**Cost discipline is the architecture.** A blanket LLM pass over 4,700 listings is both wasteful
and unnecessary: these patterns are contradictions between two fields we already hold, and a
contradiction is what a regex is good at. So every row goes through the free deterministic stage,
and only ~1.5% of them are ever shown to a model.

The LLM stage reuses the existing `lib/llm/` plumbing unchanged — the `AnthropicBatchClient`
seam, `batch.ts`'s submit/poll/collect loop, `config.ts`'s Haiku-only model constraint and
enablement gate, and `prompts.ts`'s cacheable-prefix + fail-closed-parser convention. It does
**not** reuse `watermark.ts` or the transactional writers, because it has nothing to write.

### Evidence tiers, and why findings are trustworthy

Each rule labels its evidence `strong` or `weak`.

- **strong** — words that mean one thing: `Outdoor`, `Rain/Shine`, a structured audience tag
  literally reading `Adults`.
- **weak** — words that usually mean that and sometimes don't: `park` (Park Board, Parkgate),
  `field` (field trip), `playground` (indoor playgrounds exist), a bare `adults` in prose.

Promotion to a reported finding:

| | adjudicated `contradiction: true` (≥0.7) | adjudicated `false` | not adjudicated |
|---|---|---|---|
| strong evidence | reported | **dropped** — the model's no beats the prefilter's maybe | reported |
| weak evidence only | reported | dropped | **dropped** |

A weak candidate is never reported unreviewed. That rule is the reason the live run's reported
set had no false positives.

### The documented false-positive trap

`worker/core/age.ts:245-250` warns that *"Adults accompanying children under 9 must stay in the
library"* is prose about supervision, not an audience. The trap is sharper than it looks: the
shipped `ADULT_AUDIENCE_RE` is anchored at the start of a tag, and that sentence **starts with
"Adults"** — so feeding it to `parseAudienceLabels()` returns 18+ and produces a false positive on
the exact example the codebase warns about.

The rule therefore reuses `parseAudienceLabels()` (so the audience semantics can't drift) but
guards what reaches it: `structuredTags()` discards any candidate tag containing
supervision/accompaniment language, or running longer than six words. Both halves are pinned by
tests, including the verbatim sentence.

That guard, the caregiver-programme guard and the child-band set now live in
`lib/audit/rules/adult-signals.ts`, shared by patterns 2 and 3. Two copies of a false-positive
guard drift the moment one is tuned, and the drift surfaces as a false positive on a
child-safety report — the one output whose credibility everything else here depends on.

---

## Running it

```bash
bash scripts/safety-audit.sh                       # dry run, delta mode, prints markdown
bash scripts/safety-audit.sh --out .audit          # + report.json and report.md
bash scripts/safety-audit.sh --mode as_served      # only what production serves today
bash scripts/safety-audit.sh --live --out .audit   # ALSO adjudicate with Haiku (see gate below)
```

| Flag | Default | Meaning |
|---|---|---|
| `--base-url` | `https://kids-fun-psi.vercel.app` | Target environment |
| `--mode` | `delta` | `as_served` \| `post_fix` \| `delta` |
| `--out` | — | Directory for `report.json` + `report.md` |
| `--delay` | `120` | Politeness delay between API requests, ms |
| `--live` | off | Ask for LLM adjudication (still gated — see below) |
| `--max-candidates` | `LLM_BATCH_MAX_CANDIDATES` (500) | Per-run adjudication cap |

`--live` **requests** adjudication; it does not grant it. A real Anthropic call additionally needs
`ANTHROPIC_API_KEY` provisioned **and** `LLM_BATCH_ENABLED=true`. Without both,
`lib/llm/safety-audit.ts` resolves the unprovisioned client and the run silently stays
prefilter-only, at zero cost.

### `delta` mode — independent verification of `fix/kf-safety-tagging`

`suitabilityTags()` in `lib/search/postgres-repository.ts` adds `indoor` for the catch-all
`class_program` category, so every unclassifiable listing renders "Indoor / Rainy-day friendly".
That bug is owned by `fix/kf-safety-tagging` and is **not** fixed here.

What is here is `lib/audit/tags.ts`, which re-derives the tag set the fixed code *would* produce
and runs the identical rules over both. `delta` mode reports:

- `resolvedByFix` — candidates that stop being candidates under the fixed derivation.
- `introducedByFix` — candidates that appear **only** under the fixed derivation. **This must be
  empty.** A non-empty list means the fix changes the derivation for rows that were previously
  fine.

If the shipped fix takes a different shape, update `POST_FIX_INDOOR_CATEGORIES` in
`lib/audit/tags.ts` and re-run; the delta stays meaningful because the rules never change.

---

## Two things that will bite the next person

**1. `minResults=0` is mandatory, not optional.** `lib/search/engine.ts` defaults `minResults` to
3 and, when a query returns fewer than that, starts **dropping the caller's own filters** and
re-running until it can fill a page. For a visitor that is the broadening ladder; for a
partitioned sweep it is silent data corruption — a cell holding one listing comes back with a few
hundred belonging to its parent, and the pager splits a cell that was never full. Measured before
this was set: single past days reporting 262 rows, and 30 "unsplittable" cells that did not exist.

**2. `description_snippet` is empty for the entire catalogue.** Not an API limitation — nothing in
`worker/` ever writes `activity_occurrence.description_snippet`, so the column is null and the
repository maps it to `''`. Measured 0 non-empty out of 311 rows across four partitions. The rules
read it anyway, so the auditor gets stronger the day ingestion starts persisting body text. Until
then the evidence is the **title** and the **raw audience wording** recovered from
`occurrence_age.age_notes`. That is enough for both tonight's instances, but a listing whose only
adult signal is in its body text is currently undetectable. Persisting scraped body text is an
ingestion change, not something the auditor can improvise.

### Sweep coverage is a measurement, not a claim

`/api/search` clamps `limit` to 100 and has no offset, so the sweep partitions the catalogue by
region → date bisection → time of day → age band, paging each cell once. Two properties are
reported rather than assumed:

- `coverage` = unique rows collected ÷ the unfiltered `total`. It runs slightly **above 1.0**,
  because the search collapses a repeating programme to one representative occurrence and *which*
  occurrence depends on the date window asked for — so the sweep sees more distinct occurrence
  rows than a single unfiltered query reports. Findings are collapsed back per `seriesId`, with an
  occurrence count.
- `truncatedCells` — cells that exceeded a page with no dimension left to split. A last-resort
  multi-sort harvest re-asks such a cell under three alternate orderings; the cell is still
  recorded either way. Silent truncation is how a partial sweep gets mistaken for a clean bill of
  health.
