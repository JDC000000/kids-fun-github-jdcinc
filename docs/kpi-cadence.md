# KIDS FUN — Product-health KPI review cadence

Source: scope-to-task v1.1 §M7 (T41 / G-T41-3) · TSD v1.2 §12.5 (KPI definitions).
Surface this protocol drives: **`/admin/operating`** (`app/admin/operating/page.tsx`).

**Status: a recommended protocol, not a running job.** This document defines *what* to
check, *who* checks it, and *what escalates*. It deliberately does **not** register a
cron entry — see [§6 Automating this](#6-automating-this-operator-owned) for why that is
an operator decision and how to wire it when Jon wants it.

---

## 1. Why a cadence at all

KIDS FUN launched to production on **2026-07-21**. Before that, "is the product healthy?"
was answered by whoever happened to look. Post-launch it needs to be answered on a
schedule, by a named person, against numbers that mean the same thing every time — which
is what the operating dashboard exists to provide.

Two cadences, because they answer genuinely different questions:

| | **Daily review** | **Monthly review** |
|---|---|---|
| URL | `/admin/operating?view=daily` | `/admin/operating?view=monthly` |
| Window | 30 days, day buckets | 12 months, month buckets |
| Question | *Did something break or move sharply in the last 24h?* | *Is the product compounding?* |
| Time budget | 5 minutes | 45 minutes |
| Output | Nothing, unless something escalates | A written note (see §5) |

The daily review is an **exception scan** — its success condition is finding nothing. The
monthly review is a **judgement** — it should produce an opinion and a decision.

---

## 2. Reading the dashboard honestly

The operating dashboard is built so that a number you can't trust *looks* like a number
you can't trust. Four conventions, and they matter more than any individual KPI:

1. **The headline number is the last COMPLETE period.** The still-running period is shown
   separately as "in progress" and is never used as a trend endpoint. Comparing a
   part-day against a whole day is the most common way a dashboard lies; the code
   refuses to do it (`buildOperatingKpi` in `lib/analytics/operating.ts`).
2. **`—` is not `0`.** An em-dash means *there was no data to state this rate* (a zero
   denominator). A `0` means the number really is zero. Never read one as the other.
3. **`low sample` means "directionally unreliable".** Any rate whose denominator is below
   `MIN_RATE_SAMPLE` (20) carries this badge. 1-of-2 and 500-of-1000 are both "50%", and
   only one of them is worth acting on.
4. **"not enough data" is a real, correct answer.** With fewer than two complete periods,
   the trend verdict is `unknown` rather than an invented arrow. This is expected in the
   monthly view until the first full calendar month since launch closes.

> **Current reality check (as of this document):** KIDS FUN is days old in production.
> Most rates below are currently computed over very small denominators, and the monthly
> view has **no complete calendar month yet**. That is genuine data thinness, not a bug —
> the dashboard says so in a banner at the top of the page. Do not "fix" a KPI that reads
> `—` by lowering a denominator threshold; wait for data.

---

## 3. The daily review — 5 minutes

**Who:** the on-duty developer/operator for KIDS FUN.
**When:** once per working day, early. Consistency beats precision — same time daily.
**Where:** `/admin/operating?view=daily`.

Work top to bottom. Anything in the **Escalate** column goes straight to §4.

| # | Check | Healthy | Escalate if |
|---|---|---|---|
| 1 | **Sentry — production issue trend** | Panel reads `ok`; new-issue count flat or falling | Panel says *unconfigured* or *unavailable* (you are flying blind — fix the read path first); OR new issues spiked vs the prior day; OR any new unresolved issue at all on a day with no deploy |
| 2 | **Data health — ingestion success rate** | ≥95% (the `SLA_CADENCE_TARGET_PCT` target), trend steady | Below 95%, or any *worsening* verdict two days running |
| 3 | **Sources within cadence** (live-state panel) | ≥95% | Below 95% — a source has stopped refreshing |
| 4 | **Corrections / bugs reported** | Flat, and *resolved* keeps pace with *opened* | A spike in opened, or unresolved queue depth growing 3 days running, or "oldest open" older than 7 days |
| 5 | **Search success — non-empty result rate** | ≥90%, steady | A sharp single-day drop (usually a catalogue/ingestion problem, not a search-engine problem) |
| 6 | **Zero-result recovery rate** | Steady or rising | A fall alongside a zero-result-rate rise — parents are hitting dead ends *and* not finding their way out |
| 7 | **DAU + activity volume** | Non-zero, no cliff | Volume drops to ~0 (check the site is actually up before assuming a demand problem) |

**If everything is green, stop.** The daily review is not supposed to produce work.

---

## 4. Escalation

Escalation is deliberately blunt — three levels, and the trigger for each is a *fact*, not
a feeling.

| Level | Trigger | Action | Owner |
|---|---|---|---|
| **P1 — now** | Site down; DAU/volume at ~0 during normal hours; Sentry showing a new high-frequency error; ingestion success rate at 0% | Stop other work. Investigate immediately. Notify Jon in the paired channel with the dashboard screenshot + the Sentry issue link. | On-duty developer |
| **P2 — this cycle** | Any single KPI *worsening* two consecutive daily reviews; ingestion below 95% for 2 days; unresolved corrections growing 3 days; oldest-open correction >7 days | Raise a task in the normal pipeline. Do not fix ad-hoc mid-review — record it and let it be scheduled. | On-duty developer → Development Orchestrator |
| **P3 — note it** | A KPI reading `—` or `low sample` that you *expected* to have data; a KPI whose definition looks wrong for what it is being used to decide | Add to the monthly review note. No immediate action. | Reviewer |

**Two standing rules, both learned the hard way on this project:**

- **Never soften a bad number.** If a KPI is bad, or is `—` because of genuine data
  thinness, report it that way. T36's KPI #2 was reported honestly rather than dressed up,
  and that is the standard.
- **A blind panel is a P1, not a P3.** "Sentry unavailable" is not a cosmetic problem —
  it means the daily review's first and most important check is not running.

---

## 5. The monthly review — 45 minutes

**Who:** Jon (product decision) with the on-duty developer (data integrity).
**When:** first working day of the month, covering the *previous complete* month.
**Where:** `/admin/operating?view=monthly`.

The monthly review looks at the KPIs the daily scan deliberately ignores, because they
only mean anything over a long window:

| KPI | What a healthy trend looks like | The decision it informs |
|---|---|---|
| **Monthly active users** | Growing month over month | Is distribution working? |
| **Activation rate (new actors)** | Rising, or stable at an acceptable level | Is the first-visit experience good enough? |
| **Period-over-period retention** | Rising | Is this a product parents come back to, or a one-time lookup? |
| **Signed-in share of active users** | ≥20% (launch goal) | Is the account worth having? |
| **Saved searches + email opt-ins** | Growing faster than MAU | Are we building a returning audience or renting traffic? |
| **Source click-through rate** | ≥25% (TSD §12.5 KPI #7 — the one ratified target) | Are listings good enough to act on? |
| **Search success (engagement proxy)** | Rising | Are parents finding what they came for? |

**Produce a written note.** Copy the top row of the detail table (it is the text twin of
every sparkline, and copy-pastes cleanly) and add:

1. The three KPIs that moved most, with the numbers.
2. Any P3 items carried in from the daily reviews.
3. One decision, or an explicit "no change this month".

Store it in the project's execution documents, not in someone's head.

### KPI definitions that are NOT yet ratified

Read these with their caveats — all four are documented at their definition site in
`lib/analytics/operating.ts` and shown on each KPI card in the dashboard's `provenance`
line. **Only Source CTR (≥25%, TSD §12.5 KPI #7) is a ratified target**; the rest are
launch goals or definitions proposed by T41 and should be confirmed or moved deliberately.

| KPI | Definition used | Why it needs ratifying |
|---|---|---|
| **Activation** | A *new* actor (first-ever event in the period) that reached `listing_viewed`, `outbound_source_click` or `saved_search_created` in the same period | TSD §12.5 names the KPI but not its numerator. "Searched but never opened a listing" is currently **not** activation — a defensible call, not a mandated one. |
| **Retention** | Of the previous period's actors, the share active again in this period | Standard period-over-period return rate. Day-over-day in the daily review is a noisy measure by nature; month-over-month is the one to make decisions on. |
| **Search success** | Reported **twice**: an exact *non-empty result rate*, and a behavioural *engagement proxy* (a search followed by a same-actor listing view/source click within 30 min) | The §9 event catalog carries **no relevance grade**, so a true graded "success rate" is not computable from the data we capture. If a graded measure is wanted, it needs a new event, not a new query. |
| **Zero-result recovery** | Of zero-result searches, the share where the same actor re-searched within 30 min and got results | Engine-side broadening is counted separately (`broadenedSearches`) — "the engine broadened" and "the parent recovered" are different things and are not merged. |
| **"One-time login rate"** | Implemented as TSD §12.5 KPI #15, *share of active actors who signed in at least once* (`signedInSharePct`) | The phrase is ambiguous: it can mean "logged in **at least** once" (adoption — what is implemented, reusing the canonical existing helper) or "logged in **only** once" (churn). **Needs a product ruling.** |

---

## 6. Automating this (operator-owned)

**Deliberately not wired here.** Registering a live recurring job is an infrastructure
action with an owner, an on-call implication and a notification target — an operator/Jon
decision, not something a development task should switch on unilaterally. This section is
the recommendation, ready to action.

**Intended mechanism: the satellite's own `schedule` skill** — the same recurring-job
pattern KIDS FUN already uses for the weekly digest email
(`app/api/email/weekly/run`) and the analytics retention sweep
(`app/api/analytics/retention/run`, see `lib/analytics/retention.ts`). No new
infrastructure, no `pg_cron`, no second scheduler.

Recommended jobs, when approved:

| Job | Cadence | What it should do |
|---|---|---|
| `kids-fun-daily-product-health` | Every working day, early | Wake an agent, run §3's checklist against `/admin/operating?view=daily`, post to the paired channel **only if** something in the Escalate column trips |
| `kids-fun-monthly-product-health` | 1st of the month | Wake an agent, assemble the §5 note as a draft, and hand it to Jon for the decision — the *judgement* stays human |

Two constraints on whoever wires these:

- **The daily job must be silent when healthy.** A job that posts "all green" every day
  gets muted within a week, and then the one day it matters, nobody reads it.
- **The admin surface is gated.** `/admin/operating` requires a real admin session (or the
  interim shared-secret token) — an automated reviewer needs a credential path decided
  *before* the job is registered, not improvised by the job.

---

## 7. Known gaps

Honest list. None of these are blockers for running the cadence; all are worth knowing.

- **Sentry issue trend is unverified against a live Sentry.** The read path is built and
  fully unit-tested, but it needs `SENTRY_ORG`, `SENTRY_PROJECT` and a **read-only**
  `SENTRY_ISSUES_API_TOKEN` (scopes: `project:read`, `event:read`) in the runtime
  environment. `SENTRY_AUTH_TOKEN` is **not** it — that is CI-only, for source-map upload,
  and a write token is the wrong credential for a long-lived web process. Until the token
  is provisioned the panel honestly reports *unconfigured* rather than showing zeros.
- **The interim admin token is not carried across the review-mode switch.** Switching
  daily↔monthly drops `?token=`, so a token-authorised reviewer must re-append it. This is
  deliberate: rendering a shared secret into the HTML of a dashboard whose whole purpose is
  to be screenshotted into a review note is a real leak vector. A reviewer using a proper
  admin **session** is unaffected. Retiring the interim token removes the issue entirely.
- **Lifecycle queries do a full-table scan of `analytics_event`.** Determining whether an
  actor is *new* requires a whole-history `min(created_at)` per actor, and
  `analytics_event` has no index on `user_or_session`. Correct, and comfortable at the
  table's current (retention-bounded, 13-month) size. If the monthly review ever feels
  slow, the fix is a covering index on `(user_or_session, created_at)` — a small additive
  migration, not a query rewrite.
- **Search-outcome rates read slightly low on the in-progress period.** Searches in the
  last 30 minutes have not had their full window to convert. This is exactly why the
  in-progress period is excluded from trend comparisons.
