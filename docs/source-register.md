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
   environment allow-list: `KIDS_FUN_LIVE_LIBRARY_SYSTEMS` (e.g. `vpl,rpl`),
   `KIDS_FUN_LIVE_CITY_CALENDARS` (e.g. `vancouver`), `KIDS_FUN_LIVE_VENUES`, and
   `KIDS_FUN_LIVE_ACTIVENET` (e.g. `vancouver,burnaby` — see §6.3). Absent the env var,
   the adapter returns fixtures and makes **zero** network calls. (`.env.example`
   documents all four but sets none, so a fresh/dev environment is fixture-only by
   default.)

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

- **No bypass** (`tests/compliance/no-bypass.test.ts`, G-T35-2, amended by G-T7R-0):
  the production live adapters (`worker/adapters/library`, `worker/adapters/citycalendar`,
  `worker/adapters/venue`) each issue exactly **one credential-free GET** — no
  `Authorization`/`Cookie` header, no request body, no `credentials: 'include'`, carrying
  only an identified bot User-Agent (never a browser spoof). **PerfectMind** still makes
  **zero** network calls and exposes no live-fetch capability. **ActiveNet** is now
  live-capable under D-10 (§6.3) and is held to the same contract with ONE named
  exception: it may POST to two exact read-only search paths
  (`READ_ONLY_POST_SEARCH`, D-11), and only when its tenant is named in
  `KIDS_FUN_LIVE_ACTIVENET` — un-named tenants still make **zero** network calls, asserted
  behaviourally. A comment-stripped source scan additionally asserts none of the fifteen
  adapter files contain login/credential, CAPTCHA, headless-navigation
  (`puppeteer`/`playwright`/`page.*`), checkout/cart, anti-forgery-token-submission, or
  PUT/PATCH/DELETE code — the allow-listed file included.
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
| `activenet` / District of West Vancouver | **excluded — ZERO drop-in data** | Portal live, online-calendar module empty. See §6.3 |
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
- **ActiveNet / ActiveCommunities** (Vancouver, Burnaby, West Vancouver): **superseded —
  see §6.3.** The *official-API* route (D-9) was excluded on data grounds (§6.2). The
  *portal* route was subsequently authorised by D-10 and BUILT (T7 REBUILD); Vancouver
  and Burnaby are live-capable, West Vancouver has zero drop-in data.

Guardrail: `tests/compliance/no-bypass.test.ts` is the tripwire. It has now been revisited
ONCE, by G-T7R-0, for ActiveNet only — a single named `READ_ONLY_POST_SEARCH` allowance
(§6.3). **PerfectMind is untouched**: it still makes zero network calls and exposes no
live-fetch capability, and wiring it live would require its own revisit of that test.

### 6.2 ActiveNet via the OFFICIAL ACTIVE API (T7, D-9) — excluded on data grounds

> **Superseded as the delivery route by §6.3** (T7 REBUILD, authority D-10), which reads
> the municipal *portal* instead. This section is retained because it is the evidence for
> WHY the official API is not the route — deleting it would invite someone to re-try it.

**Outcome: this route did not ship an ingesting adapter. The official API carries no
current data for our tenants, and that is an explicit, evidenced gap — not a deferral.**

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

**To revisit:** re-run the confirming query. If Vancouver Park Board resumes syndication
the official API becomes a *second*, lower-risk route to the same coverage and should be
preferred over the portal, because it carries no terms override. Nothing in §6.3 removes
that preference.

---

### 6.3 ActiveCommunities rec-portal (T7 REBUILD) — live-capable under D-10, with the risk stated plainly

**Status: BUILT and measured. Vancouver and Burnaby are live-capable. West Vancouver has
zero drop-in data and is recorded as zero. Nothing is enabled in production by this task.**

#### 6.3.1 Authority, and the risk we are accepting

The ActiveCommunities rec-portal (`anc.ca.apm.activecommunities.com/<tenant>`) is **barred
by ACTIVE Network's Terms of Use for automated access by ANY technique** — a plain JSON GET
is as prohibited as a headless render. That has not changed and is not disputed here.

**decisions_register D-10 (2026-07-30) overrides it.** Jon, the business owner, directly and
twice, on an informed basis, authorised reading these portals notwithstanding those terms.

The risk is recorded here **unsoftened**, because softening it would defeat the purpose of
recording it:

> We are reading a third party's portal against its published Terms of Use. ACTIVE Network
> would be within those stated terms to block our access, to demand we stop, or to pursue
> the matter further, and we would have no contractual or good-faith position to stand on —
> we knew, and proceeded anyway. The polite engineering below bounds the OPERATIONAL risk
> (getting blocked, degrading their service); it does nothing whatsoever about the TERMS
> risk, which is accepted in full as a business decision, not engineered away.

D-10 authorises **reading**. It does not authorise deception or defeating access controls,
and none was needed: see §6.3.2. It covers **ActiveCommunities portal tenants only** — not
PerfectMind (T8, still parked and still making zero network calls), not other ACTIVE
products, not any other barred host.

**Preference on record:** if ACTIVE's official Activity Search API ever resumes carrying
current municipal data (§6.2), it is the better route precisely because it needs no
override, and it should replace this one.

#### 6.3.2 What is actually sent — verified, not assumed (2026-07-30)

| Property | Needed? | Evidence |
|---|---|---|
| Cookie / session | **No** | Endpoints answer 200 with no cookie jar |
| CSRF / anti-forgery token | **No** | 200 with no `__csrfToken`, and we never send one |
| Browser-spoofed User-Agent | **No** | Works with the project's identified `KidsFunBot/1.0 (+…; contact: …)` |
| Login / paywall / CAPTCHA | **No** | All endpoints are pre-auth |
| Headless browser | **No** | Every data endpoint answers plain `fetch()` |
| Read-only POST (search) | **Yes** | The vendor's two search endpoints take a JSON filter object |

The last row is the ONLY thing that moved in the compliance tripwire. `tests/compliance/
no-bypass.test.ts` now carries a named `READ_ONLY_POST_SEARCH` allow-list keyed on adapter
family + **exact host** + **exact path** (`anc.ca.apm.activecommunities.com` ·
`/onlinecalendar/filters`, `/onlinecalendar/multicenter/events`) — `decisions_register
D-11`. Every other prohibition still applies **to that same file**: Authorization header,
Cookie header, `credentials:'include'`, PUT/PATCH/DELETE, headless navigation,
checkout/cart, anti-forgery-token submission, CAPTCHA handling, password credentials,
browser-spoofed UA. The zero-network assertion is retained for every tenant not named in
`KIDS_FUN_LIVE_ACTIVENET`.

**Host-scoping (QA finding A1, closed 2026-07-30).** The first revision of the amendment
pinned the PATH but not the HOST — `pathname.endsWith()` alone, which was host-agnostic by
construction. Independent QA proved it by repointing `ACTIVENET_PORTAL_HOST` to a fake host:
the elevated-scrutiny suite stayed green while an ordinary adapter test caught it — exactly
backwards for the file this project holds to the highest standard. **D-10's authorisation is
host-scoped** — Jon overrode ACTIVE Network's Terms of Use for *this portal*, not for
read-only POSTs against hosts in general — so the tripwire now owns that boundary itself,
three ways: (1) behaviourally, every captured request from the family must go to an
allow-listed hostname, GETs included; (2) the POST check requires host AND path to match on
the SAME allow-list entry; (3) structurally, the family's config must declare the pinned
host as its ONLY host literal. Hostnames match EXACTLY, never by suffix.

The amendment is itself tested (`(C) tripwire self-check`), and was mutation-verified on
2026-07-30 by injecting each bypass class into the real adapter and confirming the suite
goes red. **All ten classes bite:**

| Injected into the real adapter | Tests failed |
|---|---|
| Cookie header | 3 |
| Anti-forgery / CSRF header | 3 |
| Headless-browser import | 1 |
| Browser-spoofed User-Agent | 4 |
| `PUT` inside the allow-listed file | 4 |
| POST to a non-allow-listed path | 4 |
| **Host repointed to `evil.example.com`** (QA's A1 repro) | **3** |
| **Host suffix-extended** (`…activecommunities.com.attacker.example`) | **3** |
| **Second host added alongside the real one** | **1** |
| **Second host added as a full URL literal** | **1** |

Baseline restored each time: 63/63 green. The last four rows are the A1 fix; the last two
were not in QA's report — they are the additive repoint routes the exact-match assertion
also has to cover, tested because closing only the case that was demonstrated would have
left the obvious neighbouring one open.

#### 6.3.3 Crawl posture

Single-threaded per host through the shared `politeFetch` seam (`worker/health/policy.ts`),
family rate `activenet: 20/min` (a 3s floor — the hygiene requirement is ≥1s), hard
per-run request cap in tenant config (Vancouver 60, Burnaby 48), `Retry-After` honoured,
bounded exponential backoff on 5xx, and a circuit breaker that **stops the run and writes a
`source_check_run`** on 403/429 rather than retrying into a block. Cadence is daily-at-most;
these schedules change weekly. No adapter opens its own HTTP path.

Measured cost of one full run: **Vancouver 47 requests, Burnaby 33** (≈2N+2 for N
calendars). The endpoint returns the tenant's whole calendar period in one response and
**ignores `start_date`/`end_date`** (proven by ablation), so windowing is done client-side —
paginating by date would have cost requests and returned identical bytes.

#### 6.3.4 MEASURED COVERAGE — staging-equivalent run, 2026-07-30

Real run of the shipped adapter (live fetch → parse → venue join) with
`KIDS_FUN_LIVE_ACTIVENET=vancouver,burnaby,west_vancouver`, 28-day ingest window
2026-07-30 → 2026-08-27. **Every number below is measured. None is projected.**

| | Vancouver | Burnaby | West Vancouver |
|---|---|---|---|
| Calendars configured | 23 (+1 UI placeholder excluded) | 17 | **0** |
| Calendars returning **zero** | **1** (Queer Inclusion) | **3** (Floor Hockey, Indoor Cycling, Multi-sport) | n/a |
| Requests used / cap | 47 / 60 | 33 / 48 | **0** / 4 |
| Occurrences fetched (full calendar period) | 10,146 | 4,786 | **0** |
| Records emitted (28-day window) | **6,834** | **2,457** | **0** |
| Skipped — closure notices | 27 | 0 | 0 |
| Skipped — outside window | 3,285 | 2,329 | 0 |
| Skipped — unparseable time | **0** | **0** | 0 |
| Venue address resolved | **6,834 / 6,834 (100%)** | **2,457 / 2,457 (100%)** | n/a |
| Unmapped centres | **0** | **0** | n/a |
| Distinct venues | 35 | 7 | 0 |
| Unrecognised payload keys | **0** | **0** | n/a |

**Cost-status distribution (28-day window)**

| | Vancouver | Burnaby |
|---|---|---|
| `free` | 454 (6.6%) | **0** |
| `known` (a real amount) | 1,614 (23.6%) | 23 (0.9%) |
| `check_source` | 2,626 (38.4%) | 2,401 (97.7%) |
| `unknown` | 2,140 (31.3%) | 33 (1.3%) |

**The "free" flag is not trustworthy, and this is the number that proves it.** Over the full
calendar period, Vancouver ships **838** occurrences with `price.free === true`. We report
**721** as free and **hold back 117 (14.0%)** — 74 because the record's own title or
description quotes a price or names an admission fee ("Drop-in price is per child $3.00" on
a record flagged `free: true` **and** priced "no charge"), and 43 because a single
uncorroborated free signal is not enough to tell a parent something is free. We never assert
free without the vendor flag (0 such cases). Burnaby ships **zero** free records at all.

**Age resolution (T13's existing deterministic normaliser, not forked)**

| | Vancouver | Burnaby |
|---|---|---|
| Records with age wording captured | 6,834 (100%) | 2,457 (100%) |
| Resolved to a structured band | **2,322 (34.0%)** | **601 (24.5%)** |

Two thirds of Vancouver records and three quarters of Burnaby's do **not** resolve to an age
band deterministically. That is a real gap, stated as a gap: the wording is free text
("Gym Bugs Drop In", "Reserve In Advance: Badminton All Ages"), and this is exactly the
worklist T13's LLM-fallback exists for.

**Category classification** — 5,536 of 6,834 Vancouver records (81%) fall through to the
generic `class_program`; only 1,184 carry a confident calendar-derived hint (`public_swim`
842, `indoor_play` 257, `open_gym` 88, `skate` 75). Burnaby is worse: 2,421 of 2,457 (99%)
are `class_program`. The taxonomy is not tuned for this source's vocabulary.

#### 6.3.5 Honest findings that qualify the headline numbers

1. **Burnaby is mostly not walk-in drop-in.** 4,691 of 4,786 occurrences (**98%**) are
   titled `"Reserve In Advance: …"` — pre-booked slots, not turn-up-and-play. And 2,635
   (55%) come from ONE calendar, "Racquet Court", at ONE centre: court bookings. Burnaby's
   raw count should not be read as 4,786 kids' drop-in sessions.
2. **The D-10 scoping doc's per-week figures were per-calendar-period.** It reported e.g.
   "1,125 Public Swimming occurrences/week"; the endpoint ignores the date window, so that
   was the whole ~8-week period. The corrected single-week measurement (2026-08-03 →
   08-09) is **Vancouver 1,596 / Burnaby 589** occurrences — still substantial, but ~7x
   lower than the scoping figure implies. Corrected here rather than carried forward.
3. **The build-stamp canary was misattributed in scoping.** `26.9.53` and `26.9.37` are two
   different globals (`__version` / `__cuiVersion`) on the SAME page, identical across both
   tenants — not one version per tenant. Re-measured and pinned correctly.
4. **The `*` centre-name sentinel is tenant-specific.** Vancouver 36/36 centres carry it;
   Burnaby 0/7 do. Stripping is defensive, not assumed.
5. **West Vancouver is zero, and stays zero.** Its portal is live with 6,566 *registered*
   activities, but `onlinecalendar/calendars` returns an empty array. It is configured with
   `dropInCalendarIds: []` and `enabled: false`, and cannot live-fetch even when named in
   the env allow-list. It is **not** backfilled with registered activities.
6. **Not enabled in production, and no production DB was touched by this task.** The
   coverage run above was executed against an ephemeral local CI Postgres and the live
   portal; the shared staging environment's `source` rows still need the out-of-band
   `terms_status`/`robots_status` promotion described in §1 before anything ingests. That
   promotion is an operator action, deliberately not performed here.

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
