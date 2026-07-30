# KIDS FUN — Living Source Register

**Task:** T35 (Round 18 / Task Z) — Legal/terms register audit + robots guardrails.
**Autonomy:** ‹L3› real-time-review — this document records compliance reasoning for
human review; it does not silently decide anything ambiguous (see §7 flags).
**Author:** Developer Ops. **Date:** 2026-07-19. **Base commit:** `9dbfdcf` (main).

---

## 1. Purpose & authority

This is the living register of every data source KIDS FUN ingests, with an explicit
terms-of-service / robots record and one of four classifications for each:

| Classification | Meaning |
|---|---|
| **allowed** | Public feed the publisher offers expressly for syndication/subscription; robots permits it; automated access is unambiguously fine. |
| **summarise-only** | Automated access permitted *only* via a specific mechanism (e.g. RSS/XML feed); we store facts + a source link, never wholesale editorial copy. |
| **partner-required** | Would require a partner/API agreement or explicit permission before enabling. |
| **excluded** | Not permitted / not enabled — do not ingest without a new terms decision. |

**Source of truth for what is actually live is the production `source` DB table**, not
this file and not the seed. A source is live in production only when BOTH of these are
true (verified in code — see §3):

1. **DB gate** — `source.terms_status ∈ {allowed, summarise_only}` AND
   `source.robots_status = 'allowed'` (`worker/core/terms-gate.ts`,
   `worker/scheduler/tiered.ts`). The seed (`supabase/seeds/sources.sql`) intentionally
   inserts every row at `terms_status = 'pending'` / `robots_status = 'pending'` and
   *never* production-enables anything; promotion to `allowed`/`summarise_only` is an
   out-of-band ops/admin action on the production DB.
2. **Env allow-list** — the adapter's live path is additionally gated behind an
   environment allow-list: `KIDS_FUN_LIVE_LIBRARY_SYSTEMS` (e.g. `vpl,rpl`) and
   `KIDS_FUN_LIVE_CITY_CALENDARS` (e.g. `vancouver`). Absent the env var, the adapter
   returns fixtures and makes **zero** network calls. (`.env.example` sets neither, so a
   fresh/dev environment is fixture-only by default.)

Default posture is therefore fail-closed: a source stays fixture-only until it is
*explicitly* cleared in the DB **and** switched on by env.

---

## 2. Live sources (currently enabled in production)

Three real sources are live. All three are **plain single HTTP GETs** against a public,
publisher-offered feed — no login, no session, no CAPTCHA, no headless browser, no
paginated crawl. Item volume per fetch is hard-capped (`liveEventsLimit`).

| # | Source (family / name) | Feed pulled | What we pull | robots.txt (verified 2026-07-19) | ToS (verified 2026-07-19) | Classification |
|---|---|---|---|---|---|---|
| 1 | `library_bibliocommons` / **Vancouver Public Library BiblioEvents** | `https://gateway.bibliocommons.com/v2/libraries/vpl/rss/events` (RSS/XML) | Event title, branch/venue + geo, UTC start/end, age wording, category hint, source link | gateway host: **no robots.txt (HTTP 404 → unrestricted)**; `vpl.bibliocommons.com`: `User-agent: *` `Crawl-delay: 120`, `Allow: /*`, events explicitly indexable (events sitemap published) | `vpl.bibliocommons.com/info/terms`: *"use any automated system to harvest or capture any BiblioCommons Content … except as may be specifically permitted using RSS/XML feeds"* | **summarise-only** |
| 2 | `library_bibliocommons` / **Richmond Public Library BiblioEvents** | `https://gateway.bibliocommons.com/v2/libraries/yourlibrary/rss/events` (RSS/XML) | Same fields as VPL | `yourlibrary.bibliocommons.com`: identical to VPL (`Crawl-delay: 120`, `Allow: /*`, events indexable) | Same BiblioCommons ToS as VPL (RSS/XML is the permitted automated path) | **summarise-only** |
| 3 | `city_calendar` / **City of Vancouver events calendar** | `https://www.trumba.com/calendars/city-of-vancouver-events.json` (Trumba public syndication feed) | Park Board / community-centre / pool / park programming: title, venue + curated geo, UTC start/end, cost flag, audience, source link | `www.trumba.com/robots.txt`: `User-agent: *` / `Disallow:` (empty) — **allows all robots** | Trumba auto-publishes RSS/Atom/iCal/CSV/JSON feeds expressly *"for calendar subscriptions or custom publishing of events"* — the feed is offered for exactly this use | **allowed** |

### 2.1 Reasoning per live source

- **VPL & RPL (summarise-only).** BiblioCommons' Terms of Use prohibit automated
  harvesting *except* via RSS/XML feeds. Both adapters use the public RSS feed — the
  permitted exception — and **not** the JSON gateway/HTML app. RPL was deliberately
  migrated off the JSON gateway to RSS (Task 8) and its `gatewayEventsUrl` is omitted so
  it can never silently regress to the ToS-ambiguous path. We store structured facts +
  a link back to the event; we do not republish descriptions wholesale (see §4). robots
  imposes a 120 s crawl-delay on the `*.bibliocommons.com` app host; our fetch targets
  the `gateway` feed host (no robots restriction) and runs at most once per source per
  scheduled tick (daily baseline cadence) — comfortably inside a polite envelope.
  Classification **summarise-only** reflects the RSS-only ToS constraint. The
  corresponding DB `terms_status` should be `summarise_only` (or `allowed`) with
  `robots_status = allowed`.
- **City of Vancouver / Trumba (allowed).** Trumba publishes these feeds specifically for
  syndication and its robots.txt allows all robots with no disallowed paths. This is an
  unambiguous **allowed** source. DB `terms_status = allowed`, `robots_status = allowed`.

---

## 3. How live-fetching is structurally constrained (guardrail evidence)

Verified by reading the actual adapter + core code (not config flags):

- **No bypass** (`tests/compliance/no-bypass.test.ts`, G-T35-2): the two live adapters
  (`worker/adapters/library`, `worker/adapters/citycalendar`) each issue exactly **one
  credential-free GET** — no `Authorization`/`Cookie` header, no request body, no
  `credentials: 'include'`, carrying only an identified bot User-Agent (never a browser
  spoof). The rec-portal scaffolds (ActiveNet, PerfectMind) make **zero** network calls.
  A comment-stripped source scan additionally asserts none of the eight adapter files
  contain login/credential, CAPTCHA, headless-navigation (`puppeteer`/`playwright`/
  `page.*`), checkout/cart, or anti-forgery-token-submission code.
- **Attribute & summarise** (`tests/compliance/attribution.test.ts`, G-T35-3): the
  ingestion contract (`worker/core/adapter.ts` `StructuredRecord`) **requires**
  `sourceUrl` on every record and carries **no** editorial-body field — so there is
  structurally no channel to republish an article. The production activity card renders
  the source link (`rel="noreferrer noopener"`, honest "View on <source>" CTA) and
  factual facets only; an injected wholesale body does not appear on the card face.
  Fact-level provenance (source URL per displayed fact) is DB-wired via
  `worker/core/provenance.ts` `recordProvenance()`.
- **Terms gate** (`worker/core/terms-gate.ts`): `evaluateLiveFetchGate` blocks any live
  network fetch unless `terms_status ∈ {allowed, summarise_only}` AND
  `robots_status = allowed`. The scheduler (`worker/scheduler/tiered.ts`) only enqueues
  sources meeting the same bar, and only when `next_check_at` is due (cadence-gated).

---

## 4. Attribute-and-summarise posture

- Every ingested fact carries a `sourceUrl`; the card + detail views link out to the
  official listing (`ActivityCard` CTA "View on <source> ↗"; `ActivityDetail` "View
  official source").
- The `StructuredRecord` an adapter emits contains only short structured facts
  (title, venue, times, cost flag, raw age wording, category hint) + the source URL — no
  full description/body field. The `description_snippet` shown on the detail page is a
  separate, bounded DB column and is **not** populated from the live adapters' extract
  output, so live sources cannot inject wholesale editorial copy.
- Provenance rows (`provenance` table) record `source_url` + `source_family` +
  `fact_origin` per displayed fact — the transparency UX (NR-02) traces every fact back
  to its source.

---

## 5. Crawl-politeness controls

| Control | State | Evidence |
|---|---|---|
| Identified, contactable User-Agent | ✅ active on every live request | Both live adapters send `KidsFunBot/0.1 (+https://…; contact: jon@crhq.ai)`; asserted behaviourally in `attribution.test.ts` |
| Respectful cadence | ✅ config-declared & enforced | `source.baseline_cadence` (daily) / `near_date_cadence`; `enqueueDueJobs` only re-fetches when `next_check_at` is due; one GET per source per tick, item-count capped (`liveEventsLimit`: VPL 25 / RPL 20 / Vancouver 40) |
| Per-source rate limiter | ⚠️ primitive exists & tested, **not wired into live adapter fetch()** | `worker/core/politeness.ts` `RateLimiter` is correct (unit-tested) but the two live adapters call `fetch()` directly without it — see §7 flag F-1 |
| 403/429 backoff + disable | ⚠️ primitive exists & tested, **not wired into live adapter fetch()** | `recordResponse`/`isDisabled` correct; not invoked on the adapters' direct fetch path — F-1 |
| Conditional requests (ETag / If-Modified-Since) | ⚠️ primitive exists & tested, **not wired into live adapter fetch()** | `buildConditionalHeaders` correct; adapters don't pass prior cache metadata — F-1 |

Net: the *effective* crawl footprint today is polite (one small, capped, identified GET
per source per day/near-date tick), but the reusable politeness primitives are not on the
live fetch path. This is safe at current 3-source scale; it must be addressed before any
higher-volume or paginated source is added (§7 F-1).

---

## 6. Scaffolded but NOT live (fixture-only; `terms_status = pending`)

These have adapter scaffolds and seed rows but are **not** enabled, make no network
calls, and must not be ingested without a fresh terms decision. Do **not** build these
this round.

| Family / name(s) | Status | Note |
|---|---|---|
| `activenet` / City of Vancouver | terms cleared (D-9), **excluded — no current data** | Official API syndication ceased ~2024-06. See §6.2 |
| `activenet` / City of Burnaby, District of West Vancouver | terms cleared (D-9), **excluded — not syndicated** | No municipal org in the official API at all. See §6.2 |
| `perfectmind` / City of Richmond, NVRC, (New Westminster = candidate) | pending, fixture-only | See §6.1 (future source T8) |
| `venue_html` / Vancouver Aquarium, Science World | pending, fixture-only | Semi-automated venue HTML; separate terms review needed |
| `seasonal_watcher` / Stanley Park Miniature Railway, Burnaby Central Railway, Cypress Mountain | pending, fixture-only | Status-page watchers |
| `city_calendar` / (other municipalities) | n/a | Only Vancouver is live |
| `eventbrite_organizer` / placeholder | pending, `partner` tier | **partner-required** — none configured |

### 6.1 Future sources — pre-enablement checklist (informs the held T7/T8 decision)

The orchestrator is holding the ActiveNet (T7) and PerfectMind (T8) rec-portal adapters
for Jon's explicit sign-off because they involve **headless-browser rendering of
third-party rec-portal sites** — a materially different risk profile from the current
plain-GET syndication feeds. This audit does **not** build or scope them; it records what
would have to be checked *first*:

- **PerfectMind / Xplor BookMe4** (Richmond, NVRC, New West): pages are dynamic widgets
  requiring headless render + anti-forgery token handling (`requiresRender: true`). Before
  enabling: (a) read each tenant's actual ToS and `perfectmind.com` / tenant robots.txt;
  (b) confirm whether a public JSON/iCal endpoint exists that avoids headless rendering
  entirely (strongly preferred); (c) if headless is unavoidable, get an explicit written
  terms decision — headless rendering of a booking portal is exactly the case ‹L3›
  requires a human to sign off; (d) ensure the §7 F-1 politeness wiring is in place first.
  Provisional classification pending review: **partner-required / excluded** until a
  terms decision lands.
- **ActiveNet / ActiveCommunities** (Vancouver, Burnaby, West Vancouver): **resolved —
  see §6.2.** The terms question closed (D-9) but the source was then excluded on data
  grounds, not terms grounds.

Guardrail: `tests/compliance/no-bypass.test.ts` currently asserts these adapters make
**zero** network calls and expose no live-fetch capability. That test is the tripwire —
it must be revisited (and the login/CAPTCHA/headless assertions re-scoped) as part of any
future task that wires either adapter live. **It has NOT been revisited** — T7 left both
rec-portal adapters fixture-only, so the tripwire still stands unmodified.

### 6.2 ActiveNet (T7) — terms cleared, source excluded on data grounds

**Outcome: T7 did not ship an ingesting adapter. There is no ActiveNet coverage, and the
correct classification is an explicit, evidenced gap — not a deferral.**

Two separate questions had to clear. The first did; the second did not.

**1. Terms — CLEARED (D-9).** The ActiveCommunities rec-portal
(`anc.ca.apm.activecommunities.com/<tenant>`) is barred by ACTIVE's Terms of Use for
automated access by *any* technique; a plain JSON GET is as prohibited as a headless
render. The one compliant path is ACTIVE's own official **Activity Search API v2**
(`api.amp.active.com/v2/search`, keys via developer.active.com), whose express documented
purpose is third-party redistribution of activity listings. Jon authorised use of that API
on the existing credentials and personally accepted its caching/data-retention restriction
(D-9). That authorisation covers **this API only** — not the portal, not other
ACTIVE-family APIs, and not PerfectMind (T8, still separately parked).

**2. Data — FAILED.** The confirming query ran against the official API on **2026-07-30**
(read-only, Vancouver-scoped, official host only). The credentials work and the API is
healthy — but the data our tenants need is not in it:

| Tenant | In official API? | Newest activity | Verdict |
|---|---|---|---|
| Vancouver (Park Board) | Yes — org `Vancouver Board of Parks and Recreation`, `sourceSystem = 'ActiveNet CA'` | **2024-06-04** | **Stale** — syndication ceased |
| Burnaby | No municipal org | — | **Not syndicated** |
| West Vancouver | No municipal org | — | **Not syndicated** |

Vancouver Park Board activity counts by year in the API: 2021 → 1,497 · 2022 → 1,342 ·
2023 → ~10,000 (result cap) · 2024 → **22** · 2025 → **0** · 2026 → **0**. The exact
drop-in listings T7 targets (Open Gym, Public Swim, Public Skate) *are* present and
correctly attributed — but the newest ends **2023-08-26**, and the final 22 records
(2024-06-04) are preschool deposits, not drop-ins.

This is not a broken key, a wrong parameter, or a dead API — the same API returns **2,838**
current 2026 activities for other Vancouver organisations. The date filter was validated by
bisection (it returns varying non-zero totals for 2019–2024 and zero only for 2025–2026),
and `activityRecurrences` was checked for hidden current dates: none. Burnaby's and West
Vancouver's 2026 records are **100% private organisations** (hockey schools, private
schools, swim/baseball clubs) on `AW Camps 3.0` / `ActiveWorks Team Sports` — no municipal
ActiveNet tenant exists for either.

**Why nothing was built.** Ingesting this feed would have put ~3-year-old listings in front
of parents, and would have required dismantling the `no-bypass` tripwire to do it. An
empty, honest gap is the better product outcome. `worker/adapters/activenet/` therefore
stays fixture-only and makes zero network calls; the barred portal URLs were **removed**
from `config.ts` (they were a latent hazard — a config entry is how a barred host gets
wired live by accident), replaced by per-tenant `syndicationStatus` + evidence fields.
`tests/adapters/activenet.test.ts` pins both facts.

**To revisit:** re-run the confirming query. If Vancouver Park Board resumes syndication,
`ingestableTenants()` becomes non-empty and the pinning test fails by design, which is the
signal to build G-T7-2..T7-6. Do not flip a tenant to `syndicated_current` without that
fresh query. Independent of ACTIVE, the Park Board's drop-in schedule may be reachable via
the City of Vancouver **open-data** portal — a different source under different terms, and
the more promising route to this coverage.

---

## 7. Flags for human review (‹L3› — not silently decided)

- **F-1 (medium) — Politeness primitives not wired into the live adapter fetch path.**
  `RateLimiter`, `recordResponse`/`isDisabled` (403/429 backoff), and
  `buildConditionalHeaders` (conditional requests) are correct and unit-tested, but the
  two live adapters' `fetch()` methods call the global `fetch` directly and do not use
  them. Safe at today's 3-source, one-GET-per-day scale (cadence + item caps keep the
  footprint polite), but recommend routing all live fetches through a shared
  politeness-aware HTTP client before adding any higher-volume/paginated source or the
  headless T7/T8 adapters. **Not a blocker for the current live set.**
- **F-2 (low) — Two User-Agent constants.** `worker/core/politeness.ts` exports a
  placeholder `USER_AGENT` (`…kidsfun.example…`), while the live adapters use their own
  real UA (`…kids-fun-staging-jdci-nc.vercel.app; contact: jon@crhq.ai`). The real,
  contactable UA is the one actually sent; recommend consolidating to a single shared
  constant so the placeholder can't ever leak onto a live request.
- **F-3 (info) — Register vs. production DB.** The repo seed keeps all sources at
  `terms_status = 'pending'`; production enablement of the 3 live sources is an
  out-of-band DB/admin action. This audit verified the *mechanism* and the *correct
  classification* each live source should carry (§2). **Recommend the operator confirm
  the production `source` rows for VPL, RPL, and City-of-Vancouver actually read
  `terms_status ∈ {allowed, summarise_only}` + `robots_status = allowed`** — I could not
  read the production DB from the CI/audit environment.

All three live sources are, on the evidence available (verified robots.txt + ToS +
adapter code + passing compliance tests), operating within their terms. No live source
has an *unclear* status that I have silently resolved; F-3 is the one item that needs a
production-DB confirmation I cannot perform from here.

---

## 8. Verification evidence

- Full CI-parity run on ephemeral `postgis:16-3.4` (per `.github/workflows/ci.yml`),
  base commit `9dbfdcf`: migrations (17, forward) ✔ · idempotency (0 applied on re-run)
  ✔ · seeds ✔ · `tsc --noEmit` ✔ · `eslint .` ✔ · **vitest 695/695** (incl. the 25 new
  compliance tests) ✔ · `next build` ✔.
- New tests: `tests/compliance/no-bypass.test.ts` (13), `tests/compliance/attribution.test.ts` (12).
- External checks performed live 2026-07-19: `www.trumba.com/robots.txt`,
  `vpl.bibliocommons.com/robots.txt` + `/info/terms`, `yourlibrary.bibliocommons.com/robots.txt`,
  `gateway.bibliocommons.com/robots.txt` (404). BiblioCommons RSS-only ToS clause
  cross-checked across 10+ library installations.
