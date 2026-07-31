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
| `venue_html` / Vancouver Aquarium, Science World | pending, fixture-only | Semi-automated venue HTML; separate terms review needed |
| `seasonal_watcher` / Stanley Park Miniature Railway, Burnaby Central Railway, Cypress Mountain | pending, fixture-only | Status-page watchers |
| `city_calendar` / (other municipalities) | n/a | Only Vancouver is live |
| `eventbrite_organizer` / placeholder | **adapter BUILT (T10 / G-T10-2), zero organizers authorised** | **partner-required** — none configured. Connector is complete and provably organizer-scoped; it stays off because no organizer has authorised KIDS FUN and Eventbrite has no anonymous read path. See §6.5 |

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

### 6.5 Organizer-scoped Eventbrite (T10 / G-T10-2) — built, provably scoped, ZERO organizers authorised

**Status: an honest zero, of the same kind as Richmond (§6.4) and West Vancouver (§6.3).**
The adapter family `worker/adapters/eventbrite/` is complete, tested and wired into the
adapter registry. It reads nothing today, and cannot, because nobody has authorised it.

**What was checked, and what was found (2026-07-31).**

1. **Eventbrite has NO anonymous read path.** Every organizer-scoped call requires either
   an OAuth app plus that organizer's explicit authorisation, or a private token the
   organizer hands over. There is no public, credential-free endpoint that returns another
   party's events.
2. **The anonymous area-wide search endpoint the acceptance criterion forbids no longer
   exists.** `GET /v3/events/search/` — the one that accepted `location.address`,
   `location.within`, `location.latitude/longitude` — was removed from public access on
   **2019-12-12** and began denying all requests on **2020-02-20**. Eventbrite's own
   migration guidance points callers at `GET /v3/organizations/:organization_id/events/`,
   which is exactly the organizer-scoped endpoint IR-03 requires. For anyone wanting broad
   multi-creator coverage, Eventbrite directs them to apply to its **distribution partner
   programme** — a business relationship, not an API call.
3. **KIDS FUN holds no Eventbrite credential of any kind.** The project credential store
   was checked directly (connector list only — no secret values read): there is no
   Eventbrite connector. This matches what `supabase/seeds/sources.sql` and §6 of this
   register have said since they were written ("partner-required — none configured").

**Therefore G-T10-2 shipped the code half and correctly did NOT ship a live feed.** No
organizer feed was invented to demo against, and no real organizer was approached for data
— that is Jon's call, not an engineering one.

**Two ways to make it live, both business steps:**
- a named partner organizer authorises KIDS FUN directly and provides a token; or
- Eventbrite's distribution-partner programme approves the project.

Once either lands, onboarding is a **data** change: one entry in
`worker/adapters/eventbrite/config.ts`, one `source` row, the token in the env var that
entry names, and `KIDS_FUN_LIVE_EVENTBRITE=<key>` — plus a `terms_status`/`robots_status`
decision recorded here. No new code.

**How the organizer-scoping guarantee is made structural, not promised.** IR-03 says the
connector must only pull configured organizer feeds and that *no anonymous area-query path
exists* — "exists", not "is used". Four mechanisms, so no single edit undoes it:

| Mechanism | Where | What it guarantees |
|---|---|---|
| No URL parameter anywhere | `client.ts` | Callers pass an organizer CONFIG, never a URL. The organizer id is interpolated into a PATH SEGMENT, so the endpoint cannot return another organizer's events |
| Closed query allow-list | `client.ts` `ALLOWED_QUERY_PARAMS` | The builder iterates the ALLOW-LIST, not the caller's object, so `location.*` / `q` / `within` / `categories` are unreachable rather than merely unused |
| Runtime tripwire on the final URL | `client.ts` `assertOrganizerScopedUrl()` | Production code (not a test) that throws unless host, path shape, organization id and every parameter check out. Fails closed at runtime, not just red in CI |
| Compliance suite | `tests/compliance/eventbrite-organizer-scope.test.ts` (71 tests) | Behavioural (spied fetch) + structural (source read from disk, comments stripped, scanned for area-query and bypass fingerprints) + a self-check proving each scanner actually bites |

**Four independent gates keep it off**, any one of which means zero network activity:
config entry with `enabled: true` · the `KIDS_FUN_LIVE_EVENTBRITE` env allow-list · the
organizer's token present in its configured env var · the DB terms/robots gate enforced
inside `politeFetch`. Today gate 1 fails (the list is empty) and gate 3 has nothing to
satisfy it.

**On the `Authorization` header — a NAMED narrowing, recorded here on purpose.**
`tests/compliance/no-bypass.test.ts` bans `Authorization` outright for every adapter in its
`ADAPTER_SOURCES` list, correctly: those adapters read PUBLIC pages, where a credential
could only mean logging in as somebody to reach content we were not offered. This family is
the opposite case by definition — an organizer-granted bearer token is the *only* way to
honour "organizer-owned/authorized feeds only". Rather than quietly omitting the family
from that file's scan, its own compliance suite **re-runs every prohibition from it**
(CAPTCHA · password · Cookie · `credentials:'include'` · headless navigation/library ·
checkout/cart · anti-forgery token · POST · PUT/PATCH/DELETE) and narrows exactly one item:
the `Authorization` header, permitted only in `client.ts`, only as `Bearer ${token}` read
from an env var, with the token proven absent from every URL. Coverage is therefore
complete and the single thing that moved is visible in both files.

**Not yet verified against a live response.** The payload types and the fixture in
`worker/adapters/eventbrite/__fixtures__/` are transcribed from Eventbrite's published API
documentation, not captured from a real call — because no real call has ever been possible.
Re-verify field-by-field the first time an organizer is onboarded.

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
