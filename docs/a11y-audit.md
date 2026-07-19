# KIDS FUN — WCAG AA Accessibility Audit

**Scope-to-task:** G-T38-4 (WCAG AA accessibility audit) · **Round 17 / Task W** · **AUDIT-ONLY**
**Date:** 2026-07-19 · **Branch:** `overnight/g6-a11y-audit` (off `main@f303d72`)
**Tooling:** [`@axe-core/playwright`](https://github.com/dequelabs/axe-core-npm) `4.12.1` (bundles `axe-core` `4.12.1`), driven through the existing Playwright E2E harness (`tests/e2e/`).

> **No fixes were applied in this round.** This is a deliberately audit-only pass: it
> *finds and documents* violations against the real, built-and-served app. Fixes are a
> follow-up round, sequenced **after** the in-flight Round 17 search-page changes (Task V)
> land, so the audit doesn't immediately go stale. Every finding below carries an explicit
> "no fix this round — see follow-up" note.

---

## 1. Summary table (route × colour-scheme × violation count)

`violated rules` = number of distinct axe rules that failed on that page. `affected nodes`
= total DOM elements flagged (axe counts these individually). All scans use the WCAG AA tag
set (`wcag2a, wcag2aa, wcag21a, wcag21aa`).

| Route | Light — rules / nodes | Dark — rules / nodes |
|---|---|---|
| `/` (home) | ✅ 0 / 0 | ✅ 0 / 0 |
| `/search` (no query) | ⚠️ 2 / 38 | ⚠️ 2 / 23 |
| `/search?q=swim&region=van` (query + region filter) | ⚠️ 1 / 14 | ⚠️ 1 / 14 |
| `/preview` (fixture shell) | ⚠️ 1 / 26 | ⚠️ 1 / 9 |
| `/preview/[id]` (`templeton-family-swim`) | ⚠️ 1 / 1 | ⚠️ 1 / 2 |
| `/activity/[id]` (`templeton-family-swim`) | ⚠️ 1 / 1 | ⚠️ 1 / 2 |
| `/account` (authenticated) | ✅ 0 / 0 | ⚠️ 1 / 4 |
| `/admin/dashboard` | 🚫 **audit gap** (not reachable) | 🚫 **audit gap** (not reachable) |

**Headline:** only **two distinct WCAG failure types** across the whole product surface:

| axe rule | axe impact | WCAG SC | Level | Where |
|---|---|---|---|---|
| `aria-allowed-attr` | **critical** | **4.1.2** Name, Role, Value | A | `/search` filter/age/cost chips (all query states, both schemes) |
| `color-contrast` | **serious** | **1.4.3** Contrast (Minimum) | AA | `/search` result cards & section counts, `/preview*` muted text, `/account` (dark only), detail CTAs (dark) |

The home front door (`/`) and the authenticated `/account` page (light) are **clean**. Findings
cluster in two root causes described in §3. `/admin/dashboard` could not be audited this round — see §4.

---

## 2. Methodology

- **Real app, not a mock.** `bash scripts/e2e/run-e2e.sh` runs `next build` + `next start`
  against the local Supabase stack (`npm run e2e:setup`), then Playwright drives a headless
  Chromium against the served app. axe-core runs *in-page* against the fully-rendered DOM.
- **Every route the harness can already reach**, mirroring the existing `public/*.public.spec.ts`
  and `authed/*.authed.spec.ts` coverage, plus the home front door (`/`) and the canonical
  `/activity/[id]` detail route. Detail routes use a **visual fixture id** (`templeton-family-swim`,
  from `app/preview/_data/fixtures.ts`) that resolves without a database — so the audit is
  stable regardless of DB contents, the same property the existing public specs rely on.
- **Both colour schemes.** Every route runs under a light and a dark project, reusing the
  existing `authed` / `authed-dark` colour-scheme split (and the same real injected Supabase
  session for the authed routes).
- **Full detail captured, nothing swallowed.** The audit spec never asserts "zero violations".
  For each route × scheme it writes the **complete** axe result (rule id, impact, description,
  help URL, WCAG tags, every affected node's target selector + failure summary) to a durable
  JSON artifact (`tests/e2e/.artifacts/a11y/<label>--<project>.json`), attaches it to the
  Playwright HTML report, and logs a one-line-per-rule summary to stdout. The only hard
  assertion is that **axe-core actually executed** (`results.testEngine.name === 'axe-core'`),
  so a silently mis-wired integration can never masquerade as a clean pass.

### How to reproduce

```bash
# in the worktree, from repo root
npm ci
npm run e2e:setup                 # supabase start + RLS role + .env.e2e.local
bash scripts/e2e/run-e2e.sh       # build + start + full E2E suite (incl. a11y projects)
# or just the a11y sweep against an already-running local app:
npm run e2e -- --project=a11y-anon --project=a11y-anon-dark --project=a11y-authed --project=a11y-authed-dark
```

Spec files: `tests/e2e/a11y/routes.anon.a11y.spec.ts`, `tests/e2e/a11y/routes.authed.a11y.spec.ts`,
shared runner `tests/e2e/a11y/axe-helper.ts`. Playwright projects: `a11y-anon`, `a11y-anon-dark`,
`a11y-authed`, `a11y-authed-dark`.

---

## 3. Findings by root cause

### Finding A — `aria-pressed` on `<a>` filter chips (CRITICAL, WCAG 4.1.2)

- **axe rule:** `aria-allowed-attr` · **impact:** critical · **WCAG:** 4.1.2 Name, Role, Value (Level A)
- **Where:** `/search` — every scan of the page flags **14 nodes**, identically in light and
  dark and with or without an active query. The chips are rendered as links (`<a>`) carrying
  `aria-pressed="true|false"`.
- **Representative offenders (target → issue):**
  - `a[href="/search?includeUnknownCost=0"]` — `<a … aria-pressed="true" class="Chip_chip__… Chip_rail__… Chip_selected__…">` → *ARIA attribute is not allowed: `aria-pressed="true"`*
  - `div[aria-labelledby="kf-fg-ages"] … .Chip_rail__…` — the Under 2 / 2–4 / 5–9 / … age chips, all `<a … aria-pressed="false">`
  - The region chips and the cost/quick-filter chips follow the same pattern.
- **Why it fails:** `aria-pressed` is only valid on elements with a toggle-button role. On a
  plain link (`role="link"`) it is an unsupported attribute, so assistive tech gets a
  contradictory role/state. This is a **single component-level root cause** (the `Chip`
  component emitting `aria-pressed` when rendered as an anchor), which is why the count is a
  flat 14 across every search scan.
- **Follow-up (no fix this round):** likely resolved in the `Chip` primitive — either render
  toggle chips as `<button>`, or drop `aria-pressed` on the link variant and convey selected
  state another accessible way (e.g. `aria-current`). ⚠️ This lives in `/search` +
  `components/ui` code that **Round 17 / Task V is actively editing**; deliberately not touched
  here to avoid collision. Re-audit after Task V lands.

### Finding B — Insufficient text contrast on muted "field-guide" greys (SERIOUS, WCAG 1.4.3)

- **axe rule:** `color-contrast` · **impact:** serious · **WCAG:** 1.4.3 Contrast (Minimum) (Level AA)
- **Where (light scheme):** the muted secondary-text greys sit just under the 4.5:1 threshold:

  | fg / bg | ratio | needs | example element |
  |---|---|---|---|
  | `#6e806e` on `#fefefd` | 4.18 | 4.5 | result-card meta (`.kf-card__meta`), dates/ages |
  | `#7a8278` on `#f4f5f3` | 3.62 | 4.5 | card type label on tinted rows |
  | `#7a8278` on `#fefefd` | 3.93 | 4.5 | `.kf-card__type` (e.g. "Leisure Swim", 11px bold) |
  | `#8c948a` on `#f4f5f3` | 2.85 | 4.5 | faintest muted text (worst light offender) |
  | `#6e806e` on `#f4f5f3` | 3.85 | 4.5 | card meta on tinted rows |
  | `#6c766b` on `#f7f2e8` | 4.23 | 4.5 | section count badge (`.kf-section__count`), detail-page muted text |

  Counts: `/search` (no query) **24 nodes**, `/preview` **26 nodes**, `/preview/[id]` &
  `/activity/[id]` **1 node** each. The `/search` *query + filter* state showed **0** contrast
  failures — with results/filters applied the low-contrast empty-state/section chrome that
  fails on the default view isn't rendered the same way (documented as-observed, not assumed).
- **Where (dark scheme):** the same muted greys plus dark-only offenders:

  | fg / bg | ratio | route | element |
  |---|---|---|---|
  | `#636e63` on `#dde0de` | 4.00 | `/preview`, `/search` | muted text (6 nodes) |
  | `#757f75` on `#dde0de` | 3.12 | `/preview`, `/search` | fainter muted text (3 nodes) |
  | `#2f5d50` on `#183b24` | 1.65 | `/account` | saved-search "Open" link (`.kf-saved__open`) |
  | `#0000ee` on `#183b24` / `#102316` | 1.32 / 1.75 | `/account` | **un-themed default-blue inline links** ("search page") — not restyled for dark |
  | `#bcd6f5` on `#efefef` | 1.29 | `/preview/[id]`, `/activity/[id]` | "⚑ Report wrong info" button (`.kf-link`) — light-blue text on a light surface in dark mode |
  | `#f7f2e8` on `#48c774` | 1.94 | `/preview/[id]`, `/activity/[id]` | primary CTA (`.kf-btn--primary`) cream-on-green |

- **Why it fails:** two flavours. (1) The brand's muted greys are tuned ~0.1–1.6 ratio points
  below AA on their intended backgrounds. (2) **Dark-mode-specific**: a couple of inline links
  fall back to the browser default `#0000ee`, and the "Report wrong info"/CTA tokens don't
  invert correctly for the dark surface — these are the most severe (ratios 1.3–1.9).
- **Follow-up (no fix this round):** the light-mode greys need a small darkening of the muted
  text tokens; the dark-mode links/CTAs need proper dark tokens (and the inline "search page"
  links need the `.kf-link` treatment instead of UA defaults). ⚠️ These live in
  `app/search/**`, `app/preview/**`, `app/account/**` and their CSS — **all off-limits this
  round** (search under active edit by Task V; the audit-only boundary forbids fixes even for
  the trivially-wrong `#0000ee` links). Logged, not touched.

---

## 4. Audit gaps & caveats

- **`/admin/dashboard` — NOT audited (explicit gap).** The admin dashboard is gated by a shared
  secret (`ADMIN_DASHBOARD_TOKEN`, via `?token=` / `x-admin-token`; see `lib/admin/access.ts`).
  It is **not** session/role-gated — but the E2E harness (`scripts/e2e/setup-local-supabase.sh`)
  does **not** provision `ADMIN_DASHBOARD_TOKEN`, so the gate fails closed and the route returns
  **404** for the harness. Wiring that token into both the app-server env and the test env is
  deliberately out of scope for this audit-only round. The audit spec records this as a **visible
  skipped test** (`a11y audit — admin (gated; audit gap this round)`) rather than silently
  omitting it. **Follow-up:** set `ADMIN_DASHBOARD_TOKEN` in `.env.e2e.local` + the test env and
  the existing spec will audit `/admin/dashboard?token=…` automatically (no new code needed). The
  admin page uses a large block of hand-authored inline CSS with muted greys and coloured badges,
  so it's a strong candidate for contrast findings once reachable.
- **Dynamic/JS-driven states not enumerated.** axe scans the rendered DOM at load. Interaction
  states that only exist after client JS (open menus, focus rings, live filter re-renders beyond
  the URL round-trip, toast/error states) are not separately scanned. The chips are covered
  because they're server-rendered; deeper interaction-state coverage is a follow-up enhancement.
- **`best-practice` rules excluded by design.** Only real WCAG A/AA success criteria are
  reported, so every finding maps to a criterion. Enabling `best-practice` would surface
  additional advisory items (e.g. landmark/region hints) not counted here.
- **Single detail fixture.** `/preview/[id]` and `/activity/[id]` were audited with one
  representative activity (`templeton-family-swim`). Other activity shapes (missing price, long
  titles, different categories) may surface additional contrast cases; a data-driven sweep over
  several fixtures is a cheap follow-up.

---

## 5. Verification evidence

Full E2E suite (existing + new a11y projects), real built app on the local stack:

```
Running 26 tests using 2 workers
  ✓ [setup] provision authenticated test session
  ✓ [public] account-redirect / search / preview          (unchanged, still passing)
  ✓ [authed] + [authed-dark] account × 3                   (unchanged, still passing)
  ✓ [a11y-anon] + [a11y-anon-dark] 6 routes each
  ✓ [a11y-authed] + [a11y-authed-dark] /account
  -  2 skipped  (admin /admin/dashboard — audit gap, see §4)
  24 passed (19.6s)
```

Per-route raw axe JSON: `tests/e2e/.artifacts/a11y/*.json` (git-ignored run output — regenerate
with the commands in §2). Machine-readable, one file per route × colour-scheme, containing the
complete violation set with node-level selectors and failure summaries.

---

## 6. Round 18 remediation (2026-07-19, Task Y — `overnight/t38-a11y-fixes`)

> **Fixes applied.** This section documents the follow-up round that resolved the two §3
> findings. It does **not** rewrite the Round 17 audit above (that stays the historical record).
> Re-running the **exact same** audit spec (axe-core `4.12.1`, WCAG AA, both schemes, same route
> list) after these fixes reports **0 `aria-allowed-attr` + 0 `color-contrast`** violations across
> every previously-flagged route × scheme. Every changed colour's new ratio was **computed**, not
> eyeballed. Functional public/authed E2E specs still pass unmodified; a JS-off SSR smoke confirms
> the URL-driven FilterRail still renders filters as applied.

### Finding A — `aria-pressed` on `<a>` chips → **fixed with `aria-current`**

- **Root cause:** the URL-driven filter chips render as real `<a>` (`as={Link}`), but the
  multi-select groups (Ages, Areas, Bookable-now/Drop-in/Rainy-day/Free) and the "Include unknown
  cost" chip in `SearchBar` passed `aria-pressed`. `aria-pressed` is a **button-only** toggle
  state; on a link's implicit `role="link"` it is unsupported → axe `aria-allowed-attr` (critical),
  a flat **14 nodes** on every `/search` scan.
- **Decision (documented):** convey selection **uniformly with `aria-current="true"`** — the only
  selected-state attribute ARIA permits on a link (`aria-pressed`/`aria-checked`/`aria-selected`
  are all role-gated to button/checkbox/option, not link). The chips **stay real `<a href>` links**
  — FilterRail's URL-driven/shareable/works-with-JS-off design is preserved (verified by SSR smoke:
  a directly-loaded filtered URL renders `data-selected`/`aria-current` chips + "Clear filters"
  with no client JS). This extends the pattern the radio-like groups already used to the
  multi-select groups too.
- **Trade-off considered:** this drops the ARIA-level radio-vs-toggle nuance. Accepted because
  (1) that nuance was **never expressible on a link** — `aria-pressed` there was invalid, not
  merely lossy; (2) the multi/single distinction is still carried by the group labels + the
  multi-select toggle behaviour of the links + the fill/✓ affordance; and (3) the alternative
  (`role="button"` on the anchor) would require re-implementing button keyboard/activation
  semantics on a link and was rejected as a real regression risk. The `Chip` primitive's
  `aria-pressed` pass-through is retained for the genuinely-button `segmented` list/map view toggle
  (which axe confirms is valid — 0 `aria-allowed-attr` there).
- **Files:** `app/search/_components/FilterRail.tsx`, `app/search/_components/SearchBar.tsx`,
  `components/ui/Chip.tsx` (doc guard-rail).

### Finding B — insufficient contrast → **fixed, all pairs now ≥ 4.5:1**

Computed with an axe-matching sRGB alpha-compositing model (validated to ±0.03 against the Round 17
ratios, incl. the `.kf-card--muted { opacity: 0.9 }` blend). All colours stay in the Brand V2 hue
family.

| # | Element(s) | Before (fg→bg / ratio) | Fix | After ratio |
|---|---|---|---|---|
| 1 | `.kf-card__meta`, Badge `neutral`, muted-card secondary text | `#5f7360` blended → `#6e806e` / **4.18 / 3.85** | Darkened token `--kf-park-moss-text` `#5f7360`→**`#4d604c`** | 5.33 (meta ×0.9), 4.92 (badge ×0.9), 6.08 (paper) |
| 2 | `.kf-section__count`, `.kf-card__type`, `.kf-control__label`, `.kf-detail__type` | `#6c766b` / **4.23** (paper) & `#7a8278` / **3.93** (muted) | Darkened token `--kf-tertiary-text` `#6c766b`→**`#555e54`** | 6.04 (paper), 5.31 (type ×0.9) |
| 3 | `.kf-stamp--muted` (light-on-light in dark; worst light offender `#8c948a`/2.85) | `#8c948a` / **2.85** & dark `#757f75`→`#dde0de` / **3.12** | Use **flipping** role tokens (`--ink-secondary` on `--surface-subtle`) instead of fixed `--tertiary-text`/`--neutral-100`; **removed** the compounding `.kf-stamp__src { opacity: 0.85 }` | 4.92 (light), 5.63 (dark) |
| 4 | `.kf-btn--primary` CTA, dark mode | `#f7f2e8` on Leaf `#48c774` / **1.94** | Higher-specificity `.kf a.kf-btn--primary { color: var(--forest-ink) }` (was clobbered by `.kf a { color: inherit }`) | **7.61** (both schemes) |
| 5 | "⚑ Report wrong info" `.kf-link` `<button>`, dark | `#bcd6f5` on UA buttonface `#efefef` / **1.29** | `.kf-link { background: transparent }` (composite onto panel `--surface`, not UA `buttonface`) | 7.68 (light), 8.33 (dark) |
| 6 | `/account` un-themed inline links ("search page"), dark | UA `#0000ee` on `#183b24`/`#102316` / **1.32 / 1.75** | New themed, scheme-flipping `--link` (`#1a6349` light / `#82d3ab` dark) + underline | 6.43–7.18 (light), 9.31 / 7.02 (dark) |
| 7 | `.kf-saved__open` "Open" pill, dark | un-flipped `#2f5d50` on `#183b24` / **1.65** | Retheme to `--link` | 7.18 (light), 7.02 (dark) |

- **Files:** `app/design-tokens.css` (tokens 1–2), `app/preview/preview.css` (3–5),
  `app/account/account.css` (6–7).

### Verification

`npm run e2e:setup` + `bash scripts/e2e/run-e2e.sh` (real built app, local Supabase, both schemes):

```
[a11y] every route (home / search ×2 / preview shell / preview[id] / activity[id] / account) — light + dark
       -> 0 violated rule(s) — clean   (was: aria-allowed-attr ×14, color-contrast ×24/9/26/…)
24 passed  ·  2 skipped (admin — audit gap unchanged, see §4)
```

Also green: `tsc --noEmit`, `eslint .`, `next build`, and the public/authed functional E2E specs
(unchanged). Harness note: the local E2E harness pins `E2E_BASE_URL` to `:3000`; if a stale
`next-server` already holds that port, Playwright silently tests the stale build — run on a free
port (`E2E_PORT` + matching `E2E_BASE_URL`) to test your actual build.
