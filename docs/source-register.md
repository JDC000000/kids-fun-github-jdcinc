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
   `KIDS_FUN_LIVE_ACTIVENET` (e.g. `vancouver,burnaby` — see §6.3) and
   `KIDS_FUN_LIVE_PERFECTMIND` (e.g. `nvrc` — see §6.4). Absent the env var,
   the adapter returns fixtures and makes **zero** network calls. (`.env.example`
   documents these but sets none, so a fresh/dev environment is fixture-only by
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
  only an identified bot User-Agent (never a browser spoof). **ActiveNet** (§6.3) and, as
  of T8, **PerfectMind** (§6.4) are live-capable under D-10 and are held to the same
  contract with TWO named exceptions — one per family, each pinned to its own exact hosts
  and exact read-only search paths (`READ_ONLY_POST_SEARCH`, D-11) — and only when the
  tenant is named in `KIDS_FUN_LIVE_ACTIVENET` / `KIDS_FUN_LIVE_PERFECTMIND`. Un-named
  tenants still make **zero** network calls, asserted behaviourally. The host/path check is
  **family-scoped**, so one family's authorised host can never license another family's
  path. A comment-stripped source scan additionally asserts none of the eighteen adapter
  files contain login/credential, CAPTCHA, headless-navigation
  (`puppeteer`/`playwright`/`page.*`), checkout/cart, anti-forgery-token-submission, or
  PUT/PATCH/DELETE code — the allow-listed files included.
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
| `perfectmind` / NVRC (North Vancouver) | **live-capable under D-10/D-11, staged OFF** | Drop-in confirmed: 9 calendars. See §6.4 |
| `perfectmind` / City of Richmond | **excluded — ZERO drop-in data** | Registration widget only; drop-in published as PDFs. See §6.4 |
| `library_generic_rss` / **NVDPL (North Vancouver District Public Library)** | **live-capable under D-12, staged OFF** | Public RSS feed, 97 items, **41 emitted / 42 kid-relevant (43%)** — but its **robots.txt is UNREADABLE**. See §6.5 |
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

- **PerfectMind / Xplor BookMe4** (Richmond, NVRC, New West): **SUPERSEDED by §6.4 — the
  assessment below is WRONG and is preserved only as a record of what was believed before
  the API was probed.** BookMe4 needs no headless render and no anti-forgery token
  (verified 2026-07-30, re-verified 2026-07-31: plain HTTP, identified UA, HTTP 200). New
  Westminster was never seeded as a source row and has been dropped from config. The
  original text follows. Pages are dynamic widgets
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
> **UPDATE (T8, 2026-07-31):** that revisit has now happened, exactly as this paragraph
> anticipated — see §6.4. PerfectMind is live-capable under the same D-10/D-11 authority,
> with its own host-pinned `READ_ONLY_POST_SEARCH` entry. It remains staged OFF.

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
ACTIVE-family APIs, and not PerfectMind (T8, still separately parked *at the time this
was written* — T8 has since landed under D-10/D-11; see §6.4).

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
PerfectMind (T8 — *at the time this was written*; T8 has since been built under the same
D-10/D-11 authority and is scoped to its own two hosts, see §6.4), not other ACTIVE
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

**✅ CLOSED — case-variant User-Agent shadowing (QA finding A2, raised 2026-07-30, closed
2026-07-31 on the H4 politeFetch-deadline branch). Closed on BOTH sides: the precondition was
removed as a side effect of H4, and the detector was then hardened deliberately.**

A2 was: `politeFetch` built its headers as `{ ...buildConditionalHeaders(), ...init.headers }`,
so a caller supplying a **lowercase** `'user-agent'` produced **two** differently-cased UA
keys. `no-bypass.test.ts`'s `headerLookup` returned the *first* case-insensitive match, so it
read the identified `KidsFunBot/1.0` and passed — while `Headers` combines duplicates, putting
`user-agent: KidsFunBot/1.0, Mozilla/5.0 (…)` on the wire.

**1. The precondition is gone (side effect of H4, not a targeted fix).** `politeFetch` now
detects a caller-supplied UA in *any* casing and drops its own default instead of emitting a
second key, so exactly one UA key is ever sent. H4 also routed `venue_html` — the last adapter
still calling global `fetch()` directly — through the seam, so **every** network request in
`worker/` passes through that de-duplication. That is what makes the closure general rather
than adapter-specific. Independently verified by QA, 2026-07-31:

| | `b90f1e7` (before) | H4 branch |
|---|---|---|
| UA keys for a lowercase caller UA | **2** | **1** |
| Wire value | `KidsFunBot/1.0, Mozilla/5.0 (…)` | `Mozilla/5.0 (…)` |
| A2 repro vs the compliance suite | 63/63 **green** (the gap) | **2 failed** (caught) |

**2. The detector is now fixed too (defence in depth).** `headerLookup` normalises through the
native `Headers` API (`new Headers(rec).get(name)`) instead of a hand-rolled first-match scan,
so it sees exactly what the transport would send. Applied because the property that closes A2
in (1) lives in a *different file* and is not obliged to preserve itself: a future adapter that
bypasses the seam, or a change to `politeFetch`'s header merge, would otherwise re-open the gap
with nothing to catch it. Baseline stays 63/63 green and the fix independently re-catches the
A2 repro.

**Generalisable rule this left behind** (apply to any new check in `no-bypass.test.ts`):
absence-assertions ("no Cookie header") are casing-safe, because they trip on the key existing
at all. Value-property assertions ("the UA must not match /Mozilla/i") are not — a benign value
under a different casing can shadow a malicious one. Any *new* value-property check added there
inherits A2's shape by default.

**Related, fixed at the same time (QA finding H4-B).** The "caller owns the UA" test originally
keyed on the *presence* of a UA header, so `{'user-agent': ''}` would suppress the seam's
identified default and send the crawler out unidentified. `politeFetch` now requires a
non-empty value before yielding ownership; an empty or whitespace-only UA is treated as "none
supplied". No live caller did this — it was latent — and it is covered by
`tests/health/policy-timeout.test.ts`.

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

### 6.4 PerfectMind / Xplor BookMe4 rec-portal (T8) — live-capable under D-10/D-11, and one honest zero

Built by T8 (2026-07-31) under the SAME authority as T7: **decisions_register D-10**
(Jon's direct, twice-stated, informed override of the vendor's Terms of Use prohibition on
automated portal access) and **D-11** (the narrow read-only-POST-as-query compliance
amendment). No new legal decision was made by this task. The risk is restated here
unsoftened: we are reading a third party's portal against its published terms on an
explicit business decision. Xplor would be within its stated terms to block us and we
would have no recourse; the polite engineering below bounds the *operational* risk, not
the *terms* risk.

**§6.1's "requires headless render + anti-forgery token handling" is WRONG and is
superseded by this section.** That assessment was written in Round 13 (2026-07-13) before
anyone probed the real API. Measured 2026-07-30 and independently re-measured 2026-07-31:

> `POST https://nvrc.perfectmind.com/23734/Clients/BookMe4BookingPagesV2/ClassesV2`
> with **no cookie, no session, no `__RequestVerificationToken`, no browser-spoofed UA and
> no headless render** — only the project's own identified `KidsFunBot/1.0` UA —
> returns **HTTP 200 and ~130 KB of JSON.**

The BookMe4 shell *does* embed an anti-forgery token and its own client *does* post it
(`$.ajaxAntiForgeryPost`). The server does not require it. We therefore never send one:
`buildFormBody()` is a **closed allow-list** of five field names, and
`tests/adapters/perfectmind.test.ts` + `tests/compliance/no-bypass.test.ts` assert the
absence on the wire rather than leaving it true by omission.

The NextRec rebrand did **not** move tenant URLs — `nvrc.nextrec.com` and
`richmondcity.nextrec.com` are NXDOMAIN; the `perfectmind.com` tenant hosts are current.

#### Compliance: D-11 needed a narrow, real amendment (it did NOT already cover this)

This was checked directly against `tests/compliance/no-bypass.test.ts` rather than
assumed. The existing `READ_ONLY_POST_SEARCH` entry is **host-scoped** (QA finding A1 from
T7, and rightly so), so PerfectMind's different hosts were **not** covered by it. One
family was added — two hosts, two paths, one source file — and nothing else about the
prohibition list moved. Three things were tightened at the same time, because adding a
second family to a list that had only ever held one is exactly where a tripwire quietly
loosens:

- `isAllowedReadOnlyPost()` and `expectAllowedHost()` are now **family-scoped**. Without
  this, every family added would have widened the check for every *existing* family, since
  a request would only have had to satisfy *some* entry.
- A new test asserts one family's host can never license another family's path, in both
  directions, plus the near-miss hostname cases. **QA found the first version of that test
  vacuous** — today's two families have disjoint host sets, so the pre-existing host+path
  coupling already rejected every cross-family combination and deleting the family filter
  left the suite green. `family` is now a **required** parameter (omitting it is a compile
  error, not a silent no-op) and the matcher is exercised against a synthetic allow-list
  where two families **share** a host, which is the only configuration in which family
  scoping is load-bearing — and one the real list could grow into at any time.
- A new test asserts `/BookMe4BookingPages/Courses` appears nowhere in the adapter. That
  is an honesty guard, not a bypass guard: it is the endpoint that would let a future
  change present registered courses as drop-in coverage.

#### Measured contract: pagination is TWO NESTED LOOPS

This took two passes to get right and the first one shipped a real bug. Both passes are
recorded, because the wrong conclusion is the instructive part.

| Finding | Evidence |
|---|---|
| **`page` is a 14-day STRIDE SELECTOR** (the vendor's `numberOfDaysToLoad: 14`) | `page=0` covers 07-31..08-13; `page=1` covers 08-14..08-27. |
| **`after` is a cursor WITHIN a stride** | `page=0` no cursor → 54 records 07-31..08-05; `after=2026-08-05` → 58 records 08-06..08-11; `after=2026-08-11` → 15 records 08-12..08-13; `after=2026-08-13` → **0 records + `0001-01-01`**. |
| **`"0001-01-01"` is END-OF-**STRIDE**, not end-of-data** | Stride 0 returns it at day 13 while `page=1` still holds 08-14..08-27 (50 + 56 + … records). |
| `dateString` is **ignored** server-side | Absent, `2026-08-06` and `20260806` all returned the byte-identical payload. Windowing is entirely client-side. |
| Corroborated against the vendor's own client | `ClassBookingV2Controller.js?07231003` posts `{calendarId, widgetId, page, dateString, values, after}`, sets `me.after = result.nextKey`, and increments `page` **only** on an empty response — i.e. "empty ⇒ this stride is done, move to the next". |

**The bug the first build shipped, and how it was caught.** The first pass ablated `page`
and `after` independently, saw that `page=1` returned 08-14..08-18 while `page=0` had
ended at 08-05, and concluded `page` "silently drops" 08-06..08-13. That was backwards:
the missing days are reachable, and only reachable, by continuing the *cursor* inside
stride 0. Acting on the wrong conclusion, the client pinned `page: 0` — which capped every
run at **day 13 of a declared 28-day window**, while reporting `truncated: false` and no
warnings. Independent QA caught it by driving the real client against the live portal and
noticing the returned span was exactly half the declared window; estimated loss was ≥209
occurrences per run across NVRC's calendars.

Neither loop alone is sufficient: cursor-only stops at day 13, stride-only drops
everything past each stride's first ~55 records.

**A second, smaller coverage bug rode in behind the first (QA C1).** With the walk fixed,
the *window* was still off by one: `defaultWindow` declared an inclusive
`[today, today + 28]` — 29 days — while two strides cover 28, so the final declared day
was never fetched. QA measured 41 real occurrences lost on that one day. It rolls forward
daily rather than accumulating, which is exactly why nothing noticed. Fixed by making the
window span exactly `DEFAULT_WINDOW_DAYS` rather than buying a third stride (~50% more
requests to gain one day at the far edge of a deliberately approximate horizon). Note that
`worker/adapters/activenet/index.ts` carries the same off-by-one; it is harmless there,
because ActiveNet fetches its whole calendar period in one request and windows
client-side, so the extra day is simply kept rather than lost. The fix walks the cursor within a stride
and the stride within a ceiling, resetting the cursor at each boundary, stopping after two
consecutive empty strides. Crawl depth is **derived** from the ingest window
(`stridesForWindow(28) = 2`) so the two can never drift apart again, and the run report
now carries `stridesRequired` / `minStridesWalked` so under-coverage is visible rather than
silent. Five mutations of this logic — pinning `page: 0`, treating the sentinel as
end-of-data (in both its empty and data-bearing forms), failing to reset the cursor, and
treating an empty batch as end-of-data — are each proven to fail the suite.

#### Cost honesty: the price field is wrong on 100% of the calendar we sampled

Same trap as ActiveNet, but total rather than partial. On NVRC's Open Gym calendar,
**50 of 50** records carry `PriceRange: "No fee"` — and every one of them has `$3` in its
own `EventName` and "Regular admission fees apply" in its `Details`. NVRC's own page ships
JavaScript that rewrites the rendered `Event price No fee` label into "Regular admission
rates apply": the vendor knows the field is wrong and patches it in the browser. So
`PriceRange` can **never** produce `free` on its own; fee language anywhere in the listing
wins, and `free` requires two independent corroborating signals.

#### Age: better than expected, and deterministic

The scoping pass expected to parse the display string `DisplayableRestrictionsForCourses`
("Age: 8+"). The live payload is better than that: it carries **structured** `MinAge`,
`MinAgeMonths`, `MaxAge`, `MaxAgeMonths` and `NoAgeRestriction`. The adapter reads those
first and emits a canonical phrase that **T13's existing normaliser** (`worker/core/age.ts`)
resolves — deliberate reuse, so there is one age convention in the codebase rather than
two. Two vendor quirks are handled explicitly: `MinAgeMonths` is an *additional* months
component (`7 y 12m` = 8 years), and `MaxAge: 0, MaxAgeMonths: 0` means *no maximum*, not
a maximum of zero. **100% of the captured fixture resolves deterministically.**

#### Coverage, as measured (not projected)

| Tenant | Org / host | Status | Measured |
|---|---|---|---|
| **NVRC / North Vancouver** | `23734` · `nvrc.perfectmind.com` | **live-capable, staged OFF** | 12 categories; `**Drop-In Schedules` holds **9 calendars** (Art, Fitness Studio Workout, Indoor Playtime (Parent Participation), North Shore Neighbourhood House, Open Gym, Parkgate Society, Skate, Swim, Youth Services). Open Gym alone: **127 occurrences across stride 0** (07-31..08-13, 4 requests) plus **106+ more in stride 1** (08-14..08-27) — the stride-1 half is exactly what the first build silently missed. One calendar (North Shore Neighbourhood House) has an **empty `BookingLink`** and is expected to yield zero — flagged at runtime, not hidden. |
| **Richmond** | `23650` · `richmondcity.perfectmind.com` | **ZERO drop-in coverage** | See below. |

**G-T8-1 came back NULL, and that is reported plainly rather than papered over.**
Richmond's only public widget is a **registration** widget. Its 8 categories hold 122
calendars, of which the 22 `ClassesV2` can serve are **13 `*Registered Visits` facility
calendars** (book-ahead, paid, adult/senior-skewed — yoga, cycle-fit, table tennis 55+,
badminton 18+), **5** "Events and Seasonal Programs" (one each under 55+, Adults,
Children, Preschoolers, Youth), 1 "Luncheons and Dinners", 1 "Wellness Clinics" and 2
plant-sale calendars — 13+5+1+1+2 = 22. **No drop-in category exists on the tenant at
all.** Richmond publishes its actual walk-in drop-in
schedules (public swim, public skate, gym, drop-in fitness) as **PDFs on richmond.ca**.

Search scope for the null result: 4 widget IDs probed (`15f6af07…` registration,
`9f0e23da…` Cultural Centre All Programs, `83166e26…` invalid, plus enumeration of every
`perfectmind.com` link on richmond.ca's schedules and fitness-schedules pages); the
tenant's BookMe4 start page references only its own widget; and every BookingType-2
calendar on the tenant was listed and checked. Richmond is therefore configured with
`dropInCategoryNames: []` and `enabled: false`, and **cannot** live-fetch even when named
in the env allow-list. It is **not** backfilled with registered visits or courses. If
Richmond ever does publish a drop-in widget, `richmond.classes.registered-visits.json` is
kept as a fixture precisely so the claim stays falsifiable.

#### Gates and current state

Triple-gated, same pattern as T7, **all three currently closed**:

1. **config** — `tenant.enabled` **and** a non-empty `dropInCategoryNames` (Richmond fails
   this permanently, by measurement).
2. **env** — `KIDS_FUN_LIVE_PERFECTMIND=<tenantKey,...>`, **unset everywhere**.
3. **DB** — `source.terms_status` / `robots_status` via `worker/core/terms-gate.ts`, still
   `pending` for both PerfectMind rows.

**Run length — MEASURED, and an earlier estimate here was wrong.** QA's first full live
end-to-end run of the fixed adapter (2026-07-31) used **47 of 140 requests (34%) and took
138.2s fetch-only (~2.3 min)**. An earlier version of this paragraph projected ~7 minutes
and called NVRC the longest-running source on the project; both were wrong, because they
assumed the request cap would be spent. The cap is a **runaway bound, not a budget** —
~3x headroom is deliberate, since sizing it nearer the operating point would convert a
future vendor change into a `RequestCapExceededError` instead of absorbing it. T7's
Vancouver run (~14 min total) remains the longest.

Long runs are safe here regardless, confirmed rather than assumed: no per-job wall-clock
watchdog exists anywhere in the scheduler (only H4's per-request deadline) and production
cadence is daily. The absence of scheduling jitter is a pre-existing, project-wide scaling
note that would only bite at a source count this project is not near — not a T8 issue.

**Live fetch was NOT enabled by this task, in staging or anywhere else.** The dev stream
deliberately built to opt-in/dry-run-by-default and left enablement to the orchestrator,
matching T7's own pattern. Everything measured above came from a bounded set of manual
verification probes against the live portal (~20 requests total, spaced ≥2s, identified
UA), not from an enabled worker run.

**Coverage detection.** Two distinct health codes, deliberately not merged.
`coverage_truncated` fires when a calendar's stride stopped on the page ceiling with the
vendor's cursor still advancing — "cut off with data still arriving", unambiguously bad.
`coverage_shortfall` fires when a walk ended on consecutive empty strides with part of the
declared window never fetched — possibly a calendar that genuinely ended, possibly a real
gap, and worth a human glance either way. Blurring them into one code would let the benign
case train people to ignore the malignant one. The early-exit path also now emits a named
warning instead of returning silently: an unreported short walk is the same
looks-clean-over-a-partial-window signature as the original stride bug, merely relocated.
(The two-empty-stride tolerance itself is load-bearing and was NOT reduced — NVRC's Skate
Schedules has a genuinely empty stride 0 with all its records in stride 1.)

**Breakage detection:** the BookMe4 asset build stamp (`?07231003`, re-measured
2026-07-31) is pinned as a canary and raises `asset_build_drift` on the T15 health board;
unrecognised payload keys raise `shape_drift`; a yield collapse against the trailing
baseline raises `yield_collapse`; 403/429/cap/protocol failures map to their own codes.
All are written through `worker/core/checkrun.ts` — the same machinery T7 uses, not a fork.

---

### 6.5 NVDPL library RSS (`library_generic_rss`) — live-capable under D-12, with the robots.txt problem stated plainly

**Source:** `https://nvdpl.events.mylibrary.digital/rss` — HTTP 200, `application/rss+xml`,
~117 KB, **97 items**, unauthenticated, no API key, no query parameters.
**Verified firsthand 2026-07-31** by the implementing stream (one GET, identified bot UA),
independently of the scoping pass that found it.

#### 6.5.1 robots.txt: UNREADABLE. Stated without softening.

**`nvdpl.events.mylibrary.digital/robots.txt` returns HTTP 403 behind a Cloudflare managed
challenge.** We do not know what it says. We cannot know what it says without solving a bot
challenge, which this project does not do.

Under this project's **own T11 precedent** — Vancouver Aquarium was excluded as fixture-only
because `vanaqua.org/robots.txt` returned an Akamai "Access Denied" — **an unreadable
robots.txt is FAIL-CLOSED, not cleared.** That is still the project's default, and this entry
does not change it.

**What cleared NVDPL specifically: decision record D-12, an explicit human override.** Jon
was asked directly (routed as an ‹L3› decision, not self-approved in-project) and personally
accepted this risk for **NVDPL by name**. His words, relayed by the operator: *"if we have new
solutions or ideas, let's try it. update the TSD memory and other documents. test it and
report against it."*

**The affirmative argument the decision rested on** — recorded because it is an argument, not
a clearance, and the distinction is the reason this was routed at all: **an RSS feed is by
definition published for automated syndication.** That is the same
"intended-for-syndication" bar that made the BiblioCommons library feeds (§2.1) and the
Trumba city calendar ToS-tractable in the first place. A feed exists to be machine-read; the
`/rss` path answers 200 to an identified bot with no challenge, while every HTML path on the
same host (`/events`, `/events/ical`, `/events/feed`) answers 403. The publisher's own
behaviour distinguishes the feed from the site.

**Scope — read this narrowly, because it was granted narrowly:**

- It applies to **NVDPL only, by name**.
- It does **NOT** reopen the **T11 Vancouver Aquarium exclusion** (§6, still correctly
  fixture-only).
- It does **NOT** establish "an unreadable robots.txt is acceptable" as project policy. Any
  future source with this same fact pattern needs **its own routed human decision**.
- It authorises **fetching this feed**. It discharges nothing else — see §6.5.2.

#### 6.5.2 What the override does NOT excuse (compliance work done anyway)

- **No auth, no cookie, no session — proved, not asserted.** One plain GET, no
  `Authorization`, no `Cookie`, no `credentials: 'include'`, no body, identified
  `KidsFunBot` UA (never a browser spoof). **The host DOES set a session cookie**
  (`set-cookie: PHPSESSID=…; path=/; secure; HttpOnly`, observed live) — we neither store
  nor return it, and `tests/compliance/no-bypass.test.ts` asserts two consecutive fetches
  are byte-identical with no `Cookie` header, so no session can accumulate across runs.
- **Rate-limited through the SHARED seam.** `politeFetch` (`worker/health/policy.ts`), not a
  fork: per-source rate limiter, 403/429 breaker, conditional headers, the H4 request
  deadline. Registered at `library_generic_rss: 20/min` (a 3 s floor) in the same table as
  every other family. Footprint: **one GET of one document per daily tick** — the lightest
  live source in the project.
- **No headless browser, no challenge-solving, no HTML scraping.** Deliberately no
  per-event page fetch even though that is where a venue would be richest: those paths are
  Cloudflare-challenged, and fetching them would be exactly the escalation D-12 did not
  authorise. Venue is recovered from the RSS payload alone.
- **Attribute-and-summarise unchanged.** Every record carries `sourceUrl`; no editorial body
  field exists to fill (§4).

#### 6.5.3 The data — measured on our own pull, correcting the scoping figure upward

| Measure | Value (2026-07-31, our own capture) |
|---|---|
| Items in feed | **97** (scoping pass saw 99 hours earlier — rolling ~1-month window, expected drift) |
| Carry the `Date/Time` field | **97 / 97 (100%)** |
| Carry it in the SINGLE-DATE shape | **96 / 97** — see §6.5.4 |
| **Classify kid-relevant** | **42 / 97 (43%)** |
| **Emitted as occurrence records** | **41** (the 42nd is a multi-day range — §6.5.4) |
| Not kid programming | 54 (Tech Cafés, Pins & Needles, Philosophy Gym, Writer's Group, Discussion Lounges, Discover: 3D Printing/Cricut, **and the 5 adult Summer Reading Raves — see the correction below**) |
| Service notices, not events | 1 (`Library Closure: BC Day`) |
| Unparseable dates | **0** |

**⚠️ CORRECTION, 2026-07-31 (QA finding F-A) — an earlier revision of this section claimed
48% and cited adult events as the proof.** It reported **47/97 (48%)** and led its evidence
list with *Summer Reading Rave* (×5). Those 5 occurrences are **adult programming**:
silent-reading sessions with a mocktail, two of them after the branch closes to the public
("...offline reading time **with other adults after the library doors close for the day**" —
verbatim). They were misclassified because `summer reading` is a kid token in the title
vocabulary and a title match short-circuits before the description is read. So the shipped
document was citing 5 adult events as evidence the classifier had *improved*. That is the
worst version of this mistake, not a rounding error, and it is recorded here rather than
quietly overwritten. **Corrected figure: 42/97 (43%)** — re-derived independently by QA to
the same number, and the classifier now vetoes that series on semantic markers ("with other
adults", "mocktail") rather than on the series name, which would break on a rename.

**On the 31% figure: do not treat it as this source's kid-relevant rate, and do not treat 43%
as contradicting it.** The scoping pass measured **31% (31/99)** against a 12-name keyword
list — a **conservative floor, not a ceiling.** Re-measuring with a hand-reviewed classifier
admits **13 further occurrences across 9 titles** that are unambiguously kid programming and
were simply not on that list: *Family Storytime with CCS* (×3), *Toddlertime* (×2), *Koala
Koders: Scratch — Ages 9-11* (×2), *Summer Fun at Parkgate* (×2, Doodle Afternoon and LEGO
Build-a-thon), *Intro to Dungeons and Dragons (Tweens)*, *Camp Parkgate Stuffy Sleepover*,
*Capilano Library Summer Reading Club Celebration*, *Family Fun Day and Lynn Valley Summer
Reading Club Celebration*. **Being honest about the weakest of those:** 3 of the 13 are
*Family Storytime with CCS*, which the scoping pass's own "Family Storytime" name plausibly
already intended to cover — so the genuinely-additional count is nearer **10**, not 13.
Note the **Summer Reading CLUB Celebration** items are correctly IN (medal ceremonies for
children who completed 50 days of reading) while the **RAVE** items are correctly OUT; that
distinction is the whole reason the veto had to be narrow rather than a blanket "summer
reading" exclusion.

**All three numbers are recorded here on purpose** — 31% floor, the wrong 48%, the corrected
43% — so nobody reads a single figure as gospel, and so nobody assumes the whole feed is kid
programming, which is the failure mode this row exists to prevent. The classifier is
`classifyKidRelevance()` in `worker/adapters/library/generic-rss.ts`; its vocabulary is
documented inline with the measurement each token is justified by, including which candidate
markers were **rejected** and why (`after hours` does not discriminate — *Camp Parkgate
Stuffy Sleepover* is a real after-hours event for children).

**Structurally:** NVDPL is the library family's **4th tenant** and the first on a new
`generic_rss` platform handler. Adding it needed **no change to
`worker/core/adapter-registry.ts`** — the registry iterates `LIBRARY_SYSTEMS`, so the wiring
was a config entry plus a seed row, which is the family's original design premise holding up.

#### 6.5.4 Payload traps, each one measured (and two the scoping pass missed)

The feed is **materially thinner** than BiblioCommons: every item carries exactly `title`,
`link`, `guid`, `pubDate`, `description`, `media:content`. **No** branch, age, cost,
cancellation or location element. Hence:

1. **The event date is FREE TEXT inside `description`** —
   `<strong>Date/Time:</strong> Tue, 4 Aug 2026, 10:30am - 11:00am`. Deterministic parser,
   rejecting rather than guessing on anything off-shape (impossible dates included: `31 Feb`
   is refused, not silently rolled to 3 March).
2. **`pubDate` is the PUBLICATION date, not the event date.** **Measured: 96 of 97 items
   carry a pubDate on a different calendar day from the event** (spread March→July for an
   August window). Using it would have produced a wrong date for ~99% of records while the
   run looked perfectly healthy. It is retained as provenance only, and an item with no
   parseable description date is **dropped, never back-filled from `pubDate`**.
3. **Local wall clock, no offset.** Converted via the shared DST-correct
   `worker/core/time.ts` (`zonedLocalToUtcIso`, `America/Vancouver`) — reused, not
   reimplemented. Asserted for both PDT and PST so a fixed offset cannot pass.
4. **No structured venue.** Resolved from the payload alone, strongest evidence first: the
   feed's own trailing address block (4/97 items, e.g. Viewlynn Park) → a curated location
   name in the title → the same in the description prose. **Resolution rate on the live
   pull: 11 of 41 records** to a specific location; the other **30 degrade gracefully** to
   the system as venue with municipality `North Vancouver` and **no address and no
   coordinates** — an honest gap, not a fabricated pin. **The curated table carries NO
   coordinates at all**, deliberately: they would have to come from a geocoder (never
   called) or from memory (fabrication). Geo for NVDPL branches is a job for the venue-geo
   constant workstream against a verified dataset. A test pins the absence so adding
   unverified coordinates is a visible change.
5. **NOT EVERY ITEM IS AN EVENT — missed by the scoping pass.** `Library Closure: BC Day`
   publishes a valid `Date/Time` ("Mon, 3 Aug 2026, 10:00am - 6:00pm") and would ingest as
   an 8-hour drop-in activity on a statutory holiday when the library is shut. Filtered on a
   title-anchored notice pattern, and counted.
6. **THE DATE SHAPE IS NOT UNIFORM — the scoping pass's "100% one consistent shape" is
   wrong, and this was found by re-measuring rather than trusting it.** 100% carry the
   *field*; **96/97 carry that *shape***. `Kindergarten Book Bags` publishes a **multi-day
   range with a second full date on the end side** —
   `Mon, 24 Aug 2026, 10:00am - Sat, 29 Aug 2026, 5:00pm`. Both forms are parsed; the
   multi-day form is a registration *window*, not a single occurrence, so it is **excluded
   from records and counted** (`multiDayRanges`) rather than published as a 143-hour
   activity or silently dropped.

#### 6.5.5 Gates and current state

**Triple-gated, all three currently CLOSED:**

1. **config** — `liveCapable: true` on the system entry. *(This replaced a
   `platform === 'bibliocommons'` check that conflated "a parser exists" with "this tenant is
   cleared" — a fail-closed tightening: Coquitlam, and any synthetic config, can no longer
   live-fetch merely by being named in the env var.)*
2. **env** — `KIDS_FUN_LIVE_LIBRARY_SYSTEMS` must name `nvdpl`. **Unset everywhere**;
   `.env.example` documents it commented-out with the D-12 caveat attached.
3. **DB** — `source.terms_status` / `robots_status` via `worker/core/terms-gate.ts`, both
   `pending` for the NVDPL row. Enforced independently of 1 and 2, in **two** places
   (**corrected by QA finding F-C — it is NOT `politeFetch`**, which only does rate-limiting,
   the identified UA and the request deadline):
   - `worker/core/source-runner.ts` — `evaluateLiveFetchGate()` per run;
   - `worker/scheduler/tiered.ts` — the same predicate in SQL, so an un-cleared source is
     never even enqueued.

   The gate is genuinely real and load-bearing; only the earlier file pointer was wrong.
   Worth knowing for the next auditor: `worker/health/policy.ts` **does** export a
   `guardedLiveFetch()` that composes the gate with `politeFetch` and reads exactly like the
   enforcement point — but it currently has **zero callers**, which is almost certainly how
   the wrong pointer got written. Do not rely on it.

Default posture is fixture-only with **zero network calls**, asserted behaviourally. The
fixture is a real 4-item slice of the live feed run through the same parser, so the
no-network path cannot drift from the live one.

**Live fetch was NOT enabled by this task.** Flipping it on is an operator/Jon action, same
as every other adapter — and D-12 explicitly requires a live-fetch proof before any SP
credit.

**Breakage detection (`assessRun`).** This source's date, venue and audience all come out of
free text, so it can answer 200 with a valid feed and yield nothing — or, more likely, yield
*less* — a green run over a half-empty municipality. Codes:

- `empty_feed` — the feed returned zero items.
- `yield_collapse` — two distinct cases under one code. **Absolute:** items in the feed but
  zero records out. **Partial:** a live run emitting **<50% of its trailing baseline**
  (`YIELD_COLLAPSE_RATIO`, mirroring the value ActiveNet and PerfectMind already use, so the
  project has one collapse semantic rather than a third opinion). The partial case is the
  important one here: the realistic failure for a free-text source is 41 records → 5, not
  41 → 0, and every absolute-zero check passes that as green.
- `date_shape_drift` — >20% of items fail the free-text date parse. The single most likely
  way this adapter breaks, since one reworded vendor string degrades it silently.
- `truncated_by_limit` — states **how many** records the cap dropped, not merely that it
  truncated.

⚠️ **A fixture run is never compared to a baseline.** A fixture dry-run emits 2 records;
against a live baseline of ~41 that is a 95% "collapse", so comparing them would fire a false
alert on every fixture run — i.e. the default posture and every CI run. ActiveNet documented
this trap and this adapter would otherwise have repeated it.

Every verdict states the full tally, and the tally **reconciles**: each of the 97 feed items
lands in exactly one bucket (emitted / not-kid / notice / multi-day / unparseable / malformed
/ over-limit), so "why did 97 items yield 41 records?" is answerable off the health board
without re-pulling the feed. Asserted as an invariant across several `liveEventsLimit` values,
because an earlier revision recorded truncation as a boolean and silently failed to reconcile
in exactly the case where the missing number mattered most.

**Classification:** **summarise-only** — same posture as the other library feeds. DB
`terms_status` should be `summarise_only` with `robots_status` recorded honestly (see the
flag in §7).

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

- **F-4 (MEDIUM, added 2026-07-31 by the NVDPL build) — what `robots_status` should the
  NVDPL row actually carry, given robots.txt cannot be read?** `worker/core/terms-gate.ts`
  requires `robots_status = 'allowed'` to permit a live fetch, and the vocabulary has no
  value meaning *"unreadable, risk accepted by named human decision"*. Setting it to
  `allowed` would make the production DB assert something **we did not verify and cannot
  verify** — every other `allowed` row on this project is backed by a robots.txt somebody
  actually read, and flattening this case into the same value erases exactly the distinction
  D-12 was careful to preserve. **Not resolved here, and deliberately not worked around:**
  the adapter ships gated OFF, so nothing depends on the answer yet. Two options for
  whoever enables it — (a) set `allowed` and record the override in the row's own audit
  note, accepting that the field is then imprecise; or (b) add a distinct
  `override_unverifiable` status that the gate treats as passing but which reads honestly in
  the admin UI and in any future audit. **Recommend (b)**, since D-12 is explicitly scoped to
  one source and a value that says so keeps the next source with this fact pattern from
  inheriting the clearance by copy-paste — which is precisely what D-12's own scope
  paragraph forbids. Flagged to the operator/Jon, not decided by the implementing stream.
- **F-5 (info, 2026-07-31) — NVDPL branch geo is genuinely absent, by choice.** 30 of 41
  NVDPL records resolve to no specific branch and none of the curated NVDPL locations carry
  coordinates (§6.5.4 trap 4). This is honest rather than complete: coordinates were not
  invented. Whoever owns the venue-geo constant workstream should treat NVDPL's three
  branches (Lynn Valley, Capilano, Parkgate) plus Viewlynn/Seylynn Park as a small, known
  gap with a verified-dataset fix, not as a bug in this adapter.

- **F-6 (low, 2026-07-31) — `YIELD_COLLAPSE_RATIO` is now declared in three places.**
  `worker/adapters/activenet/health.ts`, `worker/adapters/perfectmind/health.ts` and now
  `worker/adapters/library/generic-rss.ts` each declare `0.5` independently. All three agree
  today, which is exactly when a duplicated constant is cheapest to consolidate and hardest
  to notice. The right home is `worker/core/checkrun.ts`, which already owns
  `loadRecordsFoundBaseline` and is the canonical source of baseline semantics.
  **Deliberately NOT done by the NVDPL stream:** the fix edits two other adapter families'
  files, outside that task's declared `file_scope`, while its branch was under active
  independent review — a scope expansion the collision-avoidance convention exists to
  prevent, over one numeric literal. Verified collision-safe (no in-flight branch touches
  those three files) and mechanical, so it is a clean small follow-up for whoever wants it.

All three live sources are, on the evidence available (verified robots.txt + ToS +
adapter code + passing compliance tests), operating within their terms. No live source
has an *unclear* status that I have silently resolved; F-3 is the one item that needs a
production-DB confirmation I cannot perform from here, and **F-4 is a genuine open
question the NVDPL build declined to answer unilaterally.**

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

### 8.1 NVDPL (§6.5) — evidence added 2026-07-31 by the implementing stream

- **External requests: exactly ONE.** A single GET of
  `https://nvdpl.events.mylibrary.digital/rss` with the identified bot UA. No robots.txt
  re-probe (the scoping pass's 403 was taken as given rather than re-hammering a
  challenge-protected path), no HTML path touched, no per-event page fetched, nothing
  persisted to any database.
- **Response, recorded verbatim:** `HTTP/2 200` · `content-type: application/rss+xml;
  charset=utf-8` · `server: cloudflare` · `cf-cache-status: DYNAMIC` ·
  `set-cookie: PHPSESSID=…; path=/; secure; HttpOnly` · 116,729 bytes.
- **Every figure in §6.5.3 was produced by running the shipped parser over that captured
  response**, not by hand-counting and not by trusting the scoping document — which is how
  the two corrections in §6.5.4 (traps 5 and 6) were found.
- **Re-pulled live a second time (2026-07-31, after QA)** to re-derive §6.5.3 following the
  F-A correction: HTTP/2 200, 97 items again. The Summer Reading Rave descriptions quoted in
  §6.5.3 are verbatim from that pull, and the candidate adult markers were tested feed-wide
  for over-reach before being adopted (`with other adults` hit 4 items, `mocktail` 3, union
  exactly the 5 Raves, nothing else; `after hours`/`after dark` hit only 2 and were rejected
  anyway because a kid event uses that phrasing).
- **Test evidence:** `tests/adapters/library-nvdpl-rss.test.ts` (**68 tests**: date-shape
  matrix incl. DST both ways, 12-hour boundaries, midnight/month rollover, rejection cases,
  pubDate-trap assertions, venue precedence + graceful degradation, classifier
  include/exclude on real feed titles, the **F-A Summer-Reading-Rave regression** with
  verbatim live descriptions plus its no-over-correction counterpart, multi-day exclusion,
  the **bucket-reconciliation invariant** across four limit values, run-health codes incl.
  partial-collapse-vs-baseline and the fixture-run false-alert trap, **entity-decoding
  assertions pinned against QA's own mutation** (deleting the 8 replacements now fails 3
  tests; it previously failed none), and the triple gate) +
  NVDPL cases added to `tests/compliance/no-bypass.test.ts` (single credential-free GET,
  exact feed URL pinned, PHPSESSID never echoed across two fetches, zero calls when not
  env-enabled, off-by-default roster, structural bypass scan extended to the two new
  adapter files). Full local suite: **`tsc --noEmit` ✔ · `eslint .` ✔ · vitest unit
  1274/1274 ✔**.
- **One deliberate behaviour change to shared code, disclosed rather than buried:** the
  library live gate moved from `platform === 'bibliocommons'` to an explicit per-system
  `liveCapable` flag (§6.5.5 gate 1). It is strictly fail-closed — VPL and RPL are
  unchanged, Coquitlam and any synthetic config now cannot live-fetch even if named in the
  env var. One pre-existing test (`tests/adapters/library.test.ts`, the gateway-only
  parser guard) had to add `liveCapable: true` to its synthetic config as a result; the
  assertion itself was not weakened.
