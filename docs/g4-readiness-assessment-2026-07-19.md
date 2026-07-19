# KIDS FUN — G4 (Parent-Facing UX) Readiness Assessment

**Date:** 2026-07-19 · **Round 20 / Task GG** · **Author:** Developer Ops (delegated by Development Orchestrator, session `cbda1fb7-…`)
**Branch:** `overnight/g4-readiness-assessment` off `main` @ `1b116f7` (verified) · **Live target inspected:** https://kids-fun-staging-jdci-nc.vercel.app

> **This document does NOT close, decide, or self-approve G4.** G4 is an **Orchestrator + Jon** gate. This is an evidence package prepared for Jon's decision. Nothing here advances any gate; no product code was changed (documentation-only task, scope = this file plus read-only inspection).

---

## TL;DR — headline recommendation

**The evidence supports G4 being ready to close** — all 7 M3 story tasks (T21–T27) genuinely meet their canonical exit-ACs (merged + independently QA'd + live-verified, cited below), and a **fresh** live Blueprint-conformance review of `/search`, `/preview/[id]`, and `/activity/[id]` shows **strong conformance to the approved Visual Blueprint v0.2 (defaults D1–D12)**.

The close is **not automatic**, and two items are **Jon/Orchestrator-owned, not mine to perform**:

1. **The milestone-boundary `code-review` over the consolidated M3 diff** — a standing Orchestrator gate procedure at every gate G1–G7 (scope-to-task v1.1, TSD §9 Tier-4). Per-round code-reviews happened; the formal G4-boundary review over the whole M3 diff is the Orchestrator's gate step.
2. **Jon's co-sign of the gate itself.** Jon has already **approved the Blueprint** (2026-07-18, "APPROVED — Yes I signed off"); closing G4 is the separate build-gate decision he co-owns.

**FLAG count against the 3-FLAG pause rule: 0 blocking flags.** One **design advisory** (a green "Official source" badge appearing on a *cancelled* card) should be put in front of Jon at the human gate as a conscious call — but it does not fail any acceptance criterion. Two other conformance notes are minor cosmetic/polish items (below). One deviation from the Blueprint's literal hex values is an **accessibility improvement**, not a regression.

---

## 1. Story-task exit-AC audit (T21–T27)

Canonical exit-ACs are from **scope-to-task v1.1** (§ PHASE M3, L711–867). Merge SHAs verified in `git log` on this branch. QA + live-verification evidence is cited from the on-record paper trail in `crhq-satellite/documents/execution/` — **not** re-verified from scratch (these were independently QA'd and live-verified in their originating rounds), except where this assessment re-checked the live build in §2.

M3 milestone status per the local task ledger: **37/37 SP — first KIDS FUN milestone to reach 100%.**

### T21 — App shell + search bar + chips + filters · 8 SP · exit AC (G-T21-5): *shell / search / chips / filters functional*
- **Merges:**
  - `c8d28d8` — R10/Task D: brand design tokens + shared UI primitives (**G-T21-1**, the hard brand-token constraint).
  - `0456137` — Task 12: parent-facing `/search` results shell (Screen 2 / **G-T21-2**).
  - `29e068e` — R13/Task K: `SearchBar` onto `Input`/`Button` primitives + `Textarea`/polymorphic `Button`.
  - `872ef68` — R14/Task O: `Chip`/segmented-toggle primitive + fixed the view/map toggle WCAG-AA contrast failure.
  - `9dbfdcf` — R17/Task V: **time-of-day + max-price + drop-in** filter chips, closing the last always-visible-FilterRail gaps (**G-T21-3 / G-T21-4**). Indoor deferred-as-duplicate (backend maps `indoor`→Rainy-day; a separate chip would be byte-identical UX — a reasoned, surfaced scope decision).
- **Independent QA:** R17/Task V findings — independent QA in a fresh worktree, **646 tests (+12 new)**, decisive end-to-end URL→SearchState→parser→engine proof, incl. the `under 2` AGE-vs-price-ceiling non-collision guard.
- **Live re-verification (this assessment):** live `/search` renders the always-visible FilterRail with **afternoon/evening (time-of-day)**, **Max price (cost)**, and **drop-in** chips; chips carry `aria-pressed`; the transparent-sort line renders (see §2).
- **Verdict: exit-AC MET.** (Ledger notes the earlier conservative "T21 partial until its own a11y defects are fixed" reading; those chip-a11y defects were resolved in R14/R18 — see §2 D-notes — so T21 is now credited.)

### T22 — Result cards + list view · 8 SP · exit AC (G-T22-4): *list view + 100 % card completeness; no colour-only status; unknown-cost honest*
- **Merge:** `04fd66f` — R16/Task T: 100 % `ResultCard` completeness — surface source confidence + primary CTA (feat `2663c64`).
- **Independent QA:** R16/Task T QA = **PASS, exit-AC explicitly confirmed met**; **528 passed / 93 skipped**; new `card-completeness` (6) + `confidenceMeta` (4) tests; confidence Badge backed by real data end-to-end; a11y/CTA correct; main-integrity adversarially confirmed. **One design ADVISORY** surfaced *for the G4 human gate* (see §4).
- **Live re-verification:** 8 cards render with all facets (`kf-card__title/type/tags/meta/cost/cta` + freshness stamp); status shown as **icon (`aria-hidden`) + text** (never colour-only); cost shows `$N` / "check source".
- **Verdict: exit-AC MET.**

### T23 — Map view · 5 SP · exit AC (G-T23-3): *map optional, filters persist list↔map, search usable without map*
- **Merge:** `808a5a5` — Task 37: search map view (feat, `overnight/search-map-view`).
- **Independent QA:** Track-F overnight QA = **PASS**; Mapbox tiles light/dark both HTTP 200 (public `pk.*` token, value never printed); list/map toggle preserves filters; **map lazy-loaded via `next/dynamic ssr:false`** so `mapbox-gl` stays out of the initial payload — search fully usable map-hidden (keyboard/SR users operate entirely from the list). R11/Task F research independently re-confirmed all three G-T23 gates already shipped and declined redundant rework.
- **Verdict: exit-AC MET.**

### T24 — Detail / source page · 5 SP · exit AC (G-T24-3): *provenance-backed transparency; distinct source/booking/location CTAs; source always exposed; last-checked + confidence*
- **Merge:** `823ecdc` — R15/Task R: canonical **`/activity/[id]`** detail route with share/SEO metadata (feat `33620cf`; cosmetic follow-up `25796d4`). Shares body/loader/metadata with `/preview/[id]` so the two routes **structurally cannot drift.**
- **Independent QA:** R15/Task R = **PASS**, live-verified via real browser drive incl. metadata/OG/canonical. The 2026-07-18 site-URL fix corrected `NEXT_PUBLIC_SITE_URL` so canonical/OG resolve to the real staging domain on the live commit.
- **Live re-verification:** both `/activity/[id]` and `/preview/[id]` return HTTP 200; **distinct** CTAs — *View official source* + *Open in maps* (`maps.google.com/?q=…`) + Booking (never merged); "Report wrong info"; "Checked today" + "Confidence"; **both routes set `<link rel=canonical>` → `/activity/[id]`** (SEO consolidation freshly confirmed).
- **Verdict: exit-AC MET.**

### T25 — Confirmed vs expected/seasonal separation + status copy · 3 SP · exit AC (G-T25-2): *honest confirmed/expected separation; all 16 states have copy; non-confirmed never shown as confirmed*
- **Merge:** `1d18da9` — R11/Task F: honest status copy for all 16 `status_state` values (**G-T25-1**). Removed a **live honesty defect** — the DB→UI mapper had been collapsing real states into misleading ones (`full`→"Opens soon", `seasonal_active`→"Usually weekly"); now passes canonical statuses through verbatim, and any unexpected string degrades to `needs_review` ("Unverified"), never to a confirmed-looking state.
- **Independent QA:** ran the full CI recipe against a real ephemeral PostGIS 16-3.4 container — **481/481 tests (73 files)**; live-verified `full`→**"Full"** (was "Opens soon") and `seasonal_active`→**"In season now"** (was "Usually weekly"). Sectioning (`partitionSections`) already correct: confirmed section = `confirmed` + `bookable_open` only.
- **Live re-verification:** "**Confirmed from approved sources**" section header + Confirmed badges present; the confirmed/expected split is spec-driven (G-T25-2 / PRD Appendix C), not a judgment call.
- **Verdict: exit-AC MET.**

### T26 — Date/age/location controls + anon memory · 5 SP · exit AC (G-T26-3): *anon memory + controls wired to backend; date controls incl. range; multi-child filtering without searching twice* — **this task completed M3**
- **Merges:**
  - `64ea006` — R12/Task H: anon search memory — resume a returning visitor's last search (**G-T26-3**), explicit dismissible suggestion, no silent auto-apply.
  - `aa74914` — R19/Task CC: custom **date-range** control + **results grouped by day** (**G-T26-1**, FR-04) (feat `6fddb45`; durable-a11y follow-up `0146b17`). Age/radius/area multi-select (**G-T26-2**) were built in earlier rounds; the orchestrator **re-audited and confirmed** them still holding pre-dispatch rather than assuming.
- **Independent QA:** R19/Task CC = **PASS**; **731/731 tests (+20 new)**; dedicated axe pass on the active-range grouped-by-day view = **0 violations light AND dark**. Notably, **QA caught a real gap** — the developer's claimed a11y regression-check was never committed as a durable test — and the orchestrator **required it closed before merge** (commit `0146b17`), not deferred.
- **Live re-verification:** "Custom date" control renders on `/search`; `kf_anon_id` cookie is set by middleware (anon-memory surface live).
- **Verdict: exit-AC MET.** (M3 → 37/37.)

### T27 — Report-wrong-info flow · 3 SP · exit AC (G-T27-2): *corrections captured + routed; user acknowledged*
- **Merge:** `6ae4096` — Task 39: "Report wrong info" wired to a real backend (feat `f008934`) — creates `correction_report` (open), acks the user, routes to the admin QA queue (queue itself wired in T34).
- **Independent QA:** **313 passed** + **20 new corrections tests** (route 9 / validate 8 / client 3); optimistic ack + background persist; a persist failure never breaks the ack.
- **Live re-verification:** "Report wrong info" action present on the detail page (also satisfies WCAG 3.2.6 consistent-help placement).
- **Verdict: exit-AC MET.**

**§1 conclusion:** all seven M3 story tasks are genuinely delivered to their canonical exit-ACs — not merely "merged" — with independent QA and live verification on record for each.

---

## 2. Blueprint conformance review (fresh verification)

This is the part requiring real, current verification rather than citing prior work. Reference: **approved Visual Blueprint v0.2** (`documents/requirements/jon-cartwright/kids-fun-visual-blueprint-v0.2.md`; shareable HTML `…/downloads/kids-fun-visual-blueprint-v0.2.html`). Method: fetched the **live** `/search`, `/preview/[id]`, `/activity/[id]` from the staging deployment and cross-checked against the source-of-truth `app/design-tokens.css` + component source on this branch. The build inspected is current (T21-R17 chips and T26-R19 date-range both present live).

### Defaults D1–D12 — line-by-line

| # | Blueprint default | Build state | Conformance |
|---|---|---|---|
| **D1** | Manrope only (400/500/600/800); Fraunces only as optional non-default alt; no Inter/Roboto/Geist as brand | `design-tokens.css` imports `Manrope:wght@400;500;600;700;800`; `--kf-font-ui: 'Manrope', …`; `--kf-font-display: 'Fraunces'` explicitly commented "*optional display alt — not the default*". The "Inter/Roboto" strings in page HTML are the **system-ui fallback stack of a Next.js error/notFound component**, not brand type. | ✅ **Conformant** |
| **D2** | Tabular lining numerals wherever data appears | `--kf-font-feature: 'tnum' 1, 'lnum' 1`; cards render distances/costs/dates with tabular figures | ✅ Conformant |
| **D3** | Tight display tracking, weight 600–800, sentence case | Type scale + weights defined; display treatment applied in chrome/cards | ✅ Conformant (visual) |
| **D4** | Illustrated tile — flat, two-tone, category-coded glyph | `app/preview/_components/CategoryTile.tsx` (`CategoryTile`), consumed by `ActivityCard` + home | ✅ Conformant |
| **D5** | Live "On today near you" cards first; collections → concrete "Quick starts" | Home leads with live cards + quick-starts (per prior rounds; home not re-driven here) | ✅ Conformant |
| **D6** | Best-match sort **transparently defined + one-tap changeable** | Live `/search` renders verbatim: **"Sorted by confirmed first, then closest and soonest for your kids."** with a change control | ✅ Conformant |
| **D7** | Expected/seasonal in a separate, clearly-labelled section — never blurred with confirmed | Live "**Confirmed from approved sources**" section; `partitionSections` puts only `confirmed`+`bookable_open` in confirmed | ✅ Conformant |
| **D8** | Notify-Me = labelled "Coming soon" placeholder | Phase-2 placeholder (per Blueprint/PRD; not a G4 blocker) | ✅ Conformant (as designed) |
| **D9** | Freshness stamp on every card + detail | Live cards + detail render "**Official source · Checked today**"; the signature stamp is present | ✅ Conformant |
| **D10** | Leaf = action only; warm-paper canvas; Evergreen anchors; no gradients/glass | Palette **exactly matches** the Blueprint (Leaf `#48c774`/hover `#36a65a`, Forest ink `#102316`, Evergreen `#183b24`, Warm paper `#f7f2e8`, Sand `#c9b79e`, Rainy fog `#d8e3e0`, Museum lilac `#d9c7ef`, Evening plum `#8d7aad`); `--kf-canvas: warm-paper`, `--kf-anchor: evergreen`; no gradient/glass tokens | ✅ Conformant |
| **D11** | Motion small/functional ≤200 ms; honours reduced-motion | `--kf-motion: 180ms`; `@media (prefers-reduced-motion: reduce)` in `search.css`, `preview.css`, `Chip.module.css` | ✅ Conformant |
| **D12** | Dark mode via `dark_*` tokens; honours `prefers-color-scheme` | Full `@media (prefers-color-scheme: dark)` block flips surface roles + all four status pairs | ✅ Conformant |
| D13 | Logo deferred (plain wordmark) | Deferred, non-blocking — matches Blueprint | ✅ (deferred by design) |

### Status colour system + a11y
- Status tokens match the Blueprint status table exactly: Confirmed `#375c2d`/`#eef7ed`, Info `#30538b`/`#eef6fe`, Expected `#6b4e12`/`#fbf3de`, Cancelled `#853b20`/`#fdf1ed`. All statuses render as **text label + icon**, never colour-only (verified live via `aria-hidden` icon spans alongside text). **44px** minimum touch targets present throughout `search.css` / `preview.css` (WCAG 2.5.8). Screen 3 CTAs are distinct and never merged; Screen 5b empty/broadening state ("No exact matches / No matches yet … widen") is live.

### Layout / radius / spacing / elevation
- UI primitives use the canonical tokens correctly: `Card` = `--kf-r-card` (16), `Button`/`Input`/`Textarea` = `--kf-r-control` (12), `Chip`/`Badge` = `--kf-r-chip` (9999). Spacing = base-4/8; three-tier elevation set (`--kf-e-100/200/300`) matches the Blueprint's cards/sticky/sheets model.

### Honest deviations / notes (none blocking)
1. **AA text tokens differ from the Blueprint's literal hex — in the direction of *better* accessibility.** Blueprint (and G-T21-1) name Park-moss-text `#5F7360` (5.11:1) and Tertiary-text `#6C766B` (4.73:1). The build ships **`--kf-park-moss-text: #4d604c`** (6.79:1) and **`--kf-tertiary-text: #555e54`** (6.74:1), darkened in the **Round 18 a11y remediation** because the original hexes, once blended through the 0.9 muted-card opacity, fell **below** AA (4.18/3.85). The Blueprint's D-level *intent* ("secondary text uses AA-safe tokens; never Park moss `#758A73` as body; Leaf never body text") is fully honoured and, in fact, **exceeded**. This is a conformance-improving evolution, not a regression — worth Jon noting that the shipped tokens are stricter than the doc's sample values.
2. **`app/search/search.css` uses some hardcoded radii (4/6/10/12/14px)** rather than the `--kf-r-*` tokens; the Blueprint names "search bar 16." The **UI primitives are fully token-correct**; the `/search` page was migrated onto the design system incrementally (R13/Task K) and retains a few page-local radii. **Minor cosmetic polish**, not a functional or a11y issue.
3. **Result cards link to the interim `/preview/[id]` shell**, while `/activity/[id]` is the SEO-canonical route. This is benign — both share body/loader/metadata and **`/preview/[id]` sets its canonical to `/activity/[id]`**, so SEO consolidates correctly. A purist could prefer cards linking directly to the canonical route; **cosmetic**, no user-facing or indexing harm.

**§2 conclusion:** the live build is a **strong, faithful implementation** of the approved Blueprint v0.2. D1–D12 are all met; the only deviations found are one accessibility *improvement* and two minor cosmetic/polish items. I did not find any place where the build overstates conformance or diverges from the Blueprint's honesty/brand intent.

---

## 3. What G4 needs that ISN'T covered by M3's story tasks alone

G4 is **`from T21–T27`** and is an **Orchestrator + Jon** gate (scope-to-task v1.1 L1391/L1398). Beyond the seven exit-ACs, the gate carries:

1. **Visual Blueprint human sign-off** — ✅ **RESOLVED 2026-07-18.** Jon, direct and explicit via the operator: *"APPROVED — Yes I signed off."* Defaults D1–D12 approved; logo route (D13) deferred. This resolved the earlier ledger-vs-doc status discrepancy (§0.29). *Note: Blueprint sign-off is distinct from the G4 build-gate close — approving the design is not the same as closing the milestone.*
2. **Blueprint conformance review** — done fresh in §2 above (was the outstanding non-signature item the ledger repeatedly flagged for "a fresh G4 gate-readiness look"). Result: strong conformance.
3. **Milestone-boundary `code-review` over the consolidated M3 diff** — a standing **Orchestrator gate procedure** at every gate G1–G7 (scope-to-task v1.1 L1396; TSD §9 Tier-4), executed over the milestone's diff. Per-round code-reviews occurred; the formal G4-boundary review is the Orchestrator's step and is **not something this assessment performs or substitutes for.**
4. **3-FLAG pause check** — from this assessment: **0 blocking FLAGs** (1 design advisory, below the 3-FLAG escalation threshold). No pause condition.

**Cross-cutting / adjacent-but-separate (precise):**
- **M2 search engine dependency:** G4's parent UX sits on the M2 search engine. Per the ledger, **M2 = 42/42 (engineering-complete)** and **G3 is "engineering-ready."** The live pages return **real Supabase-backed data** (UUID activity IDs, not fixtures), confirming the search engine is wired end-to-end behind the UX. G4 requires the search engine to be **engineering-ready** (it is); it does **not** require G3 to be *formally closed*, nor does it require M1 ingestion *breadth* (that is **G2**, still the weakest gate — separate concern, not a G4 blocker).
- **Not required by G4:** accounts/personalisation (M4/G5 — already complete), admin/data-health/analytics depth (M5/G5 — partial), launch hardening/security/UAT/PIPEDA (M6/G6/G7). These are genuinely separate gates. Notify-Me (D8) and the logo (D13) are deferred/Phase-2 by design and do not block G4.

---

## 4. The one item for Jon's eyes at the human gate (design advisory — non-blocking)

R16/Task T's independent QA surfaced, and this assessment re-confirms as still-relevant, a single **design judgment call** — *not* an AC failure:

> A **cancelled** occurrence sourced from an official page renders **both** "Cancelled" **and** a green "Official source" freshness badge. Factually both are true (the City's official page *is* the source, and the event *is* cancelled), and both are stated in words — so G-T22-2 ("no colour-only status; source confidence visible") is **met**. QA's concern is purely that a *green* "Official source" chip adjacent to a "Cancelled" status could read as reassuring at a glance.

**Recommendation:** put this in front of Jon/design as a conscious decision at the G4 human gate (e.g., neutralise the freshness-stamp tone when the occurrence status is cancelled/postponed). It does **not** block the AC or the gate.

---

## 5. Recommendation (for Jon — a recommendation, not a decision)

**The evidence supports closing G4.** All seven M3 story tasks meet their canonical exit-ACs with independent QA + live verification on record; the approved Blueprint v0.2 is faithfully implemented on the live build (D1–D12 conformant, deviations minor/improving); the Blueprint sign-off is already Jon's on record; and there are no blocking FLAGs.

**Before the gate is closed, two Orchestrator/Jon-owned steps remain — deliberately not performed here:**
1. The **Orchestrator** runs (or confirms) the **milestone-boundary `code-review` over the consolidated M3 diff** — the standing gate procedure.
2. **Jon co-signs** the G4 build-gate close (his to make; the Blueprint approval is already given).

Optionally, Jon may want the §4 cancelled-card freshness-badge advisory addressed as a small polish item, and may note the two cosmetic conformance items in §2 — none of which block the gate.

*This assessment is documentation only. It does not close G4 and claims no gate authority.*

---

### Evidence index
- Canonical scope: `documents/requirements/jon-cartwright/kids-fun-scope-to-task-v1.1.md` (M3 / G4, L711–867, L1391–1398)
- Blueprint: `documents/requirements/jon-cartwright/kids-fun-visual-blueprint-v0.2.md` (D1–D13; APPROVED 2026-07-18)
- Local ledger: `documents/execution/kids-fun-local-task-ledger-v0.1.md` (M3 37/37; gate-readiness §0.29 + Round 19 snapshot)
- Per-task QA/merge docs: R16/Task T, R17/Task V, R19/Task CC (findings + merge), R11/Task F G4-items, Task 37/39, Track-F QA — all in `documents/execution/`
- Live build inspected: `https://kids-fun-staging-jdci-nc.vercel.app` — `/search`, `/preview/[id]`, `/activity/[id]`
- Source-of-truth tokens: `app/design-tokens.css` @ `1b116f7`
