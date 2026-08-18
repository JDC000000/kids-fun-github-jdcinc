# Catalogue safety auditor

A recurring, read-only batch job that sweeps the whole live catalogue and flags listings whose
**source text contradicts a label we derived from it**. It exists because two severity-3
child-safety mislabels were found *by chance* by 2 of 15 testers, and finding that class by
chance does not scale.

Nothing in it writes. It makes `GET /api/search` calls and produces a report.

---

## The two patterns it detects today

| Rule id | What it catches | Real instance |
|---|---|---|
| `outdoor_source_indoor_tag` | Source says outdoor; the card renders **Indoor / Rainy-day friendly** | `Sportball Outdoor Soccer (5-7yrs) Rain/Shine` → `suitabilityTags: ['outdoor','indoor']` |
| `adult_source_child_bands` | Source says Adults / 18+ / Seniors / prenatal; the listing reaches a **child age filter** | `Supporting People Together: The Basics of Overdose Response`, `age_notes: "…, Adults, English"`, `ageBandMatches: []` → returned by `ages=2-4` |

Pattern 2 counts **two** ways a listing reaches a child: it carries a child band, *or* it carries
**no bands at all** — because the search filter's "empty → don't hide" rule then admits it into
every age filter. The tonight instance was the second kind, and a rule that only looked at bands
present would have scored it clean.

### Adding a third pattern

One file under `lib/audit/rules/`, one entry in `lib/audit/registry.ts`, one test. The prefilter,
the LLM stage, the report and the CLI all iterate the registry and know nothing about how many
rules exist.

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
