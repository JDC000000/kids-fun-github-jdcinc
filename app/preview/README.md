# Mobile fixture shell (`/preview`)

A fixture-backed, mobile-first preview of the KIDS FUN parent experience, built from
**Visual Blueprint v0.2** + **Brand Workbook V2** (Track E of the overnight sprint).
Fixture-only by design — no database, no network, no secrets — so it runs ahead of
the backend (Track B schema) and search API (Track D) and swaps to live data cleanly.

## Routes
- `/preview` — Landing / Today dashboard + results (Screen 1 & 2): sticky date/area
  bar, scroll-snap filter chips, transparent sort (D6), confirmed-vs-expected split
  (D7), and the empty/broadening state (Screen 5b) when filters over-constrain.
- `/preview/[id]` — Activity detail (Screen 3): key stat row, honesty block,
  **Who it's for** (age-band clarity + honest sibling-fit read from `age_min`/`age_max`,
  plus source-authored `age_notes` verbatim when present), **Good to know** practical
  facts (indoor/outdoor, rainy-day, drop-in — from real boolean fields), Overview,
  Parent notes, source & freshness panel, sticky bottom action bar. Fixture-backed
  locally, DB-backed in staging.

## Structure (all self-contained under `app/preview/`)
| Path | Role |
|---|---|
| `_data/types.ts` | Domain types mirroring TSD §6 `activity_occurrence` + BR-12 status enum. |
| `_data/fixtures.ts` | ~13 East Vancouver activities spanning every status / booking / cost / radius. |
| `_data/format.ts` | Pure formatters (time, age, cost, distance, freshness) + status→copy map. Unit-tested. |
| `_data/filter.ts` | Pure filter / sectioning / sort logic. Unit-tested. |
| `_components/*` | Card, category tile (D4), freshness stamp (D9), chips, sort, empty state, detail bits. |
| `preview.css` | Design system scoped under `.kf` (brand tokens, dark mode, reduced-motion). |

## Wiring to the real API later
Replace `ACTIVITIES` (and the `applyFilters` / `sortActivities` calls in
`ResultsShell`) with results fetched from the Track D search endpoint. The pure
format/filter modules and every component stay as-is — they already speak the
canonical field names.

## Not yet wired (fixture stubs, called out honestly)
- Date/area pickers are display controls; the radius segmented control is live.
- "Report wrong info" acknowledges locally (real corrections inbox = Screen 7).
- Map view, saved/login, and full Schedule/Similar sections are later screens.

Verified: `npm run typecheck`, `npm run lint`, `npm run test` (32 tests), `npm run build`.
