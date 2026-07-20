# UAT harness + launch-gate KPI validation (T-36)

_Last measured: 2026-07-20 (Round 24 / Task TT), branch `overnight/t36-uat-kpi-validation` off `main@42879dc`._

This document describes the T-36 UAT harness (G-T36-3) and the launch-gate KPI
validation (G-T36-4), and records the **honest** current standing of TSD §12.5
launch-gate KPIs **#1–#12**. KPIs **#13–#22** are post-launch **operating** KPIs
(DAU/MAU baselines, Sentry/bug ops, latency-under-load, data-ops recovery) and are
explicitly **out of scope** for the launch gate.

Everything below runs over the **real** search path (`evals/harness.ts` →
`makeFixtureEngine` for the fixture regime, `buildDbEngine` for the live-DB regime) —
no mocks. It reuses the shipped instrumentation (`lib/analytics/kpi.ts`,
`lib/analytics/benchmark.ts`, `lib/admin/dashboard.ts`) rather than forking any metric.

## What was built

| File | Purpose |
|---|---|
| `evals/harness.ts` (extended) | `runUat` / `summarizeUat` — measure benchmark search success (KPI #1), useful density (KPI #2), zero-result recovery (KPI #6), and the PRD §9 SC#4 no-empty-screen invariant. |
| `evals/uat.json` | 15 realistic East-Van parent journeys (persona: a 2-yr-old + a 5-yr-old, PRD §10), tiered `benchmark` (flagship-class, catalogue-supported) vs `realistic` (broad coverage). |
| `evals/scenarios/uat.test.ts` | Fixture-path gate on the benchmark tier (≥80% success / ≥70% density) + DB-gated honest live-catalogue measurement. |
| `evals/kpi-launch-gate.ts` | Pure catalogue of the 12 launch-gate KPIs + a report assembler (reuses `evaluateBenchmark`). |
| `evals/scenarios/kpi-launch-gate.test.ts` | Honest target-vs-actual validation for all 12 KPIs in two regimes; asserts structure, not that targets are met. |

## The two regimes (why the numbers differ so much)

- **`fixture`** — the shipped demo catalogue (`FIXTURE_LISTINGS`). This is the
  **quality ceiling** the engine reaches when a catalogue is populated. It is NOT a
  claim of launch-ready live search.
- **`live-db`** — the live Postgres read model + live `analytics_event`. On a clean
  CI/local seed the ingested catalogue is empty; any handful of "indexed" rows are
  **cross-test residue** (rows other DB tests inserted), **not** real ingestion — the
  same caveat `golden-db.test.ts` documents. The real M1 breadth (~37% per the Round 24
  orchestrator) lives on **staging**; point `DATABASE_URL` at the staging DB
  (`KIDS_FUN_SEARCH_BACKEND=database`) to measure it here.

## T-36 exit-AC — measured

> Exit: "open gym near East Van" and the full T-suite pass; **≥80% benchmark search
> success, ≥70% density measured.**

| Bar | Measured (fixture regime) | Verdict |
|---|---|---|
| Benchmark search success ≥80% | benchmark tier **100%** (5/5); full realistic suite **100%** relevance (13/13); golden set **100%** (6/6) | **MET** on a populated catalogue |
| Useful density ≥70% | benchmark tier **100%** (5/5); full realistic suite **38.5%** (5/13); avgPrimary 3.7 | **MET on the benchmark tier; NOT met broadly** — density is data-breadth-bound |

**Honest headline:** relevance is excellent; **density is the gating problem**, and it
is a *catalogue-breadth* problem, not a search-engine problem. Even on the curated demo
catalogue, single-category searches return 1–2 options because there is ≈1 listing per
category. Broad ≥70% density is **not achievable until M1 ingestion has real breadth.**

## UAT harness results

| Slice | success (KPI #1) | density (KPI #2) | recovery (KPI #6) | empty screens | avgPrimary |
|---|---|---|---|---|---|
| benchmark · fixture | 5/5 (100%) | 5/5 (100%) | — | 0 | 7.2 |
| all · fixture | 13/13 (100%) | 5/13 (38.5%) | 2/2 (100%) | 0 | 3.7 |
| all · live-db (CI seed) | 4/13 (30.8%) | 2/13 (15.4%) | 2/2 (100%) | 0 | 0.6 |

`golden.json` set: fixture path **6/6 pass (100%)**, zero-result 0%; live-db path
0/6 pass, zero-result 83.3% (residue-driven, informational only).

## Launch-gate KPI #1–#12 — honest standing

**Fixture regime** (populated-catalogue ceiling) — `met=3 below=1 manual=1 no-data=7`:

| # | KPI | Status | Actual |
|---|---|---|---|
| 1 | Search success (relevant top-10) | **MET** | realistic 100% (13/13), benchmark 100%, golden 100% |
| 2 | Useful result density | **BELOW** | realistic 38.5% (5/13); benchmark 100% — data-breadth bound |
| 3 | Time to first useful result (<30s) | **MANUAL** | content precondition met (≥3 realistic in first response); <30s is a human UAT |
| 4 | Source freshness SLA | no-data | needs live `source_check_run` |
| 5 | Card completeness | **MET** | 100% (14/14 cards carry every required field) |
| 6 | Zero-result recovery | **MET** | 100% (2/2 recover via expected options / explanation) |
| 7 | Source click-through | no-data | needs live `analytics_event` |
| 8 | Correction rate / trust | no-data | needs live `analytics_event` |
| 9 | Coverage by region/family | no-data | needs live ingested sources |
| 10 | Repeat use / retention | no-data | needs live `analytics_event` |
| 11 | Data-health board | no-data | needs live `source_check_run` |
| 12 | Account value | no-data | needs live `analytics_event` |

**Live-db regime** (CI clean seed; `indexedListings` are test residue) —
`met=5 below=4 no-data=2 manual=1`:

| # | KPI | Status | Actual (with honest caveat) |
|---|---|---|---|
| 1 | Search success | BELOW | realistic 30.8%, benchmark 40%, golden 0% — driven by residue rows, not real ingestion |
| 2 | Useful density | BELOW | realistic 15.4%, benchmark 0%, avgPrimary 0.6 |
| 3 | Time to first result | MANUAL | precondition not established (no catalogue) |
| 4 | Source freshness SLA | MET* | 100% fresh (2/2 seeded sources) — *never-run sources count fresh; needs cadence history for a real SLA |
| 5 | Card completeness | MET | 100% (6/6) — structural read-model guarantee |
| 6 | Zero-result recovery | MET | 100% (2/2) |
| 7 | Source click-through | BELOW | 0% (target ≥25%) — no engagement events |
| 8 | Correction rate / trust | no-data | 0 source clicks |
| 9 | Coverage by region/family | BELOW | 0/2 seeded sources have occurrences — every region/family is an explicit gap |
| 10 | Repeat use / retention | MET* | DAU=9 WAU=10 MAU=10 — *wiring proof only; counts are cross-test residue, not usage; §12.5 targets set post-beta |
| 11 | Data-health board | MET | board live (recentFailures=0, staleSources=0) — the T-33 deliverable exists |
| 12 | Account value | no-data | no signed-in / saved-search / opt-in events |

`MET*` = the instrumentation is wired and returns values, but the value on a clean CI DB
is a wiring proof (seed/residue), **not** a real launch-readiness measurement. Read those
two rows as "the pipe works," not "the target is achieved."

## Bottom line for the launch gate

- **Search quality (relevance, completeness, recovery, empty-state honesty) is
  launch-ready** — #1, #5, #6 are MET whenever a catalogue is populated, and the
  no-empty-screen invariant holds across every journey in both regimes.
- **The launch gate is bound by DATA BREADTH, not code.** #2 density and #9 coverage
  cannot be met until M1 ingestion fills the catalogue; engagement KPIs (#7, #8, #10,
  #12) and the freshness SLA (#4) cannot be truly measured until there is live traffic +
  scheduled source checks on staging.
- **How to re-measure for real:** run the DB-gated blocks against **staging** with
  `DATABASE_URL` pointed at the staging DB. The harness is data-source-agnostic; only the
  numbers change.
