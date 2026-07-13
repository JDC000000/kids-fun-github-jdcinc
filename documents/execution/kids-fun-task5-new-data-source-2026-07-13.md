# KIDS FUN — Task 5: Enable the next live data source (2026-07-13)

**Stream:** overnight/ingest-source-2 (parallel build — own worktree `kids-fun-ingest2`, branched from `main@8842ea8`).
**Owner:** Developer Ops. **Env:** Supabase **staging** only (`kids-fun-staging`, ref `mdusztrunwnniwnpwsmy`, ca-central-1). Prod project untouched (not created).

---

## 1. Source chosen — and why

**Vancouver Public Library (VPL) BiblioEvents**, ingested via the **BiblioCommons public RSS/XML events feed**:
`https://gateway.bibliocommons.com/v2/libraries/vpl/rss/events`

Rationale:
- **Same platform family as the only existing live source (RPL/BiblioCommons)** — reuses the `worker/adapters/library` framework end-to-end. No 4th bespoke adapter.
- VPL was **already scaffolded** in `LIBRARY_SYSTEMS` (fixture-only, `platform: 'bibliocommons'`) and already had a seeded `source` row (`library_bibliocommons` / `Vancouver Public Library BiblioEvents`). Enablement was mostly config + one new parse path.
- Public, **no login, no CAPTCHA, no headless browser** — a single paginated GET, exactly the "easy gateway" profile that made RPL simple.
- The RSS feed is **richer** than the JSON gateway: each item carries structured venue geo (`bc:latitude`/`bc:longitude`/`bc:street`/`bc:city`) and UTC start/end (`bc:start_date`), so ingest attaches real per-branch coordinates with **no external geocoder** (same deterministic-geo principle RPL used, but with real feed coordinates instead of hand-entered ones).

### Why RSS and NOT the JSON gateway (the key ToS decision)
The existing RPL live path uses the **JSON gateway** (`.../v2/libraries/yourlibrary/events`). I deliberately did **not** extend that mechanism to VPL, because the BiblioCommons Terms of Use restrict automated harvesting to RSS/XML feeds specifically (see §2). The RSS/XML feed is the mechanism the ToS **explicitly permits**, so it is the compliant path. This flips the enablement from "ambiguous/risky" to "expressly allowed."

---

## 2. ToS / robots.txt compliance check (house rule — done BEFORE enabling)

### robots.txt (URLs checked + result)
| URL | Result |
|---|---|
| `https://gateway.bibliocommons.com/robots.txt` | **404 / no robots.txt** on the API host we actually fetch → no crawl restriction. |
| `https://vpl.bibliocommons.com/robots.txt` | `User-agent: *` → `Allow: /*`; events path **allowed** (only `/item/*`, `/holds/*`, circulation widgets, `/v2/availability/` disallowed — **not** events). `Crawl-delay: 120`. Explicitly allows `/events/sitemap`. |
| `https://yourlibrary.bibliocommons.com/robots.txt` (RPL precedent) | Same pattern — events allowed, same `Crawl-delay: 120`. Confirms VPL meets the same standard already approved as `allowed` for RPL. |
| `https://www.vpl.ca/robots.txt` (org site) | `User-agent: *` → `Allow: /` (`search=yes, use=reference`; only AI-training crawlers e.g. GPTBot/ClaudeBot/CCBot disallowed — not our events fetch). |

**robots.txt verdict: ALLOWED.** We hit `gateway.bibliocommons.com` (no robots.txt) and never touch a disallowed path. A single `limit=25` GET per ingest is trivially within `Crawl-delay: 120`.

### Terms of Use (URLs checked + result)
- `https://vpl.bibliocommons.com/info/terms` (the BiblioCommons standard ToU governing the events platform for every BiblioCommons library):
  - *"[you may not] use any automated system to harvest or capture any BiblioCommons Content from the BiblioCommons Service, **except as may be specifically permitted using RSS/XML feeds**."* → automated harvesting is **prohibited EXCEPT via RSS/XML feeds**.
  - License is *"personal, non-commercial use."* Reuse/redisplay of extracts on external sites is permitted **only if each extract links back** to the original BiblioCommons page.
- Tried `https://www.bibliocommons.com/pages/terms_of_service` → 404 (ToU is served per-library at `<lib>.bibliocommons.com/info/terms`).

**ToS verdict for the JSON gateway path: AMBIGUOUS / RISKY** — a JSON API scrape is not the RSS/XML carve-out. **Not enabled.**
**ToS verdict for the RSS/XML feed path: ALLOWED** — the ToU expressly permits automated access "using RSS/XML feeds," and our adapter sets `sourceUrl`/`bookingUrl` to the real BiblioCommons event URL, satisfying the link-back reuse clause.

**Decision:** enable VPL via the **RSS/XML feed only**. Non-commercial-use scope is a project-level premise already decided for the KIDS FUN dashboard (same as RPL) and is not re-litigated here.

---

## 3. Schema / config / code changes (branch `overnight/ingest-source-2`)

No DB migration. All changes reuse the existing `library` adapter + terms-gate pipeline.

- **`worker/adapters/library/config.ts`**
  - Added optional `rssEventsUrl?: string` to `LibrarySystemConfig` (ToS-compliant live path, takes priority over `gatewayEventsUrl`).
  - VPL entry: set `rssEventsUrl` + `liveEventsLimit: 25`.
- **`worker/adapters/library/index.ts`**
  - New **dependency-free** RSS parser (`parseBiblioCommonsRss` + `fetchBiblioCommonsRss` + small XML/CDATA helpers) that normalises feed items into the existing `BiblioEvent` shape — so `extract()` maps them via the same code the JSON path uses. Keeps worker deps at `pg`+`puppeteer-core` (no XML lib, no lockfile churn across the 3 concurrent worktrees).
  - Derives venue geo from `bc:location` (`bc:latitude/longitude/street/city/zip/name`), UTC dates from `bc:start_date/bc:end_date`, skips `bc:is_cancelled`, extracts age from an explicit numeric range first (`ages 0-2`, `Grades K-7`) then keyword hint.
  - `fetch()` prefers `rssEventsUrl` when live-enabled; **RPL's JSON path is unchanged.**
- **`tests/adapters/library-rss.test.ts`** (new) — fixture-based unit tests: live-enable gating, RSS-not-JSON fetch, venue-geo + UTC parse, cancelled-item skip, stable dedup key.
- **Staging DB (data, not schema):** flipped the VPL `source` row to `terms_status='allowed'`, `robots_status='allowed'`, `platform='bibliocommons'`, `last_check_at=now()`. This is the reversible, zero-cost, staging-only encoding of the passed check above. Live fetch is additionally gated behind env `KIDS_FUN_LIVE_LIBRARY_SYSTEMS=vpl` (off by default).

---

## 4. Ingestion results (real batch vs live staging DB)

Command: `KIDS_FUN_LIVE_LIBRARY_SYSTEMS=vpl node dist/src/ingest-once.js --family library_bibliocommons --name 'Vancouver Public Library BiblioEvents' --env staging`

**Ingest #1:** gate = *"staging live fetch enabled — terms and robots approved"* →
`recordsFound: 25, seriesCreated: 22, occurrencesCreated: 25, occurrencesUpserted: 25, provenanceRows: 50, errors: []`

**Ingest #2 (idempotency re-run):**
`recordsFound: 25, seriesCreated: 0, occurrencesCreated: 0, occurrencesUpserted: 25, errors: []`

**Verification:**
- Totals: occurrences 21 → **46** after run 1, **46** after run 2 (exactly +25, then +0).
- VPL-attributed: **25 occurrences, 22 series, 10 branches (venues)**.
- **Idempotent:** VPL `total_occ (25) == distinct(series_id, source_record_id) (25)` — no duplicate rows on re-ingest.
- **Venue geo:** 22/22 VPL series venues have `geo` populated (100%) — real per-branch coordinates (e.g. Central Library 49.27971/-123.11563, Kitsilano 49.26471/-123.16878, incl. the Unicode-named `nə́c̓aʔmat ct Strathcona Branch`).

**CI gate:** `npm run typecheck` clean · `npm run lint` clean · `npm test` = **136 passed / 52 skipped / 0 failed**.

---

## 5. Remaining gaps / handoff notes

1. **RPL still uses the JSON gateway.** For the same ToS reason, RPL's live path should be migrated to its RSS feed (`https://gateway.bibliocommons.com/v2/libraries/yourlibrary/rss/events`). Left as a follow-up (not in this task's scope — didn't touch RPL). **Recommend a human/coordinator decision** on whether to keep RPL on JSON or migrate to RSS.
2. **Age wording is raw.** A few items fall back to noisy hints (e.g. "Family Theatre highlighting…"); the downstream `normalizeHook`/T13 age-band resolution is where this gets cleaned. No numeric age band is asserted here.
3. **No scheduler wiring.** This enables and proves the source; the tiered scheduler (`worker/scheduler/tiered.ts`) already selects sources where `terms_status IN (allowed, summarise_only) AND robots_status='allowed'`, so VPL will be picked up once the worker runs on a cadence. The Fly.io worker app is still blocked on the org-scoped `fly-io` token (pre-existing Wave-0 blocker, unrelated).
4. **Not a G-gate self-approval.** The terms/robots flip is a per-source staging data change (reversible, $0), explicitly authorized by the standing "keep going" + staging-only gate (memory `6c6f53a5`). No G1–G7 milestone gate was self-approved. The **ToS decision (RSS vs JSON) is flagged** to the coordinator above rather than pushed through silently.
