# SMS pivot — feasibility notes from actually drafting it

**Status: DRAFT on `feat/kf-sms-pivot-draft`. Nothing here is applied, pushed, or deployed.**
No migration in this branch has been run against any database, including a local one. The
Operator holds migration-apply, push and credential authority on this project.

These are the things I learned by *building* the v2 PRD's data model and short link, as
distinct from the things that are visible from reading the PRD. Two of them need a decision
before this is treated as settled; the rest are recorded so nobody has to rediscover them.

---

## a. The short link cannot be ~8 characters. I built ~13. **This needs your sign-off.**

**PRD §2.3 asks for** an ~8-base62-character token encoding "occurrence id + a truncated HMAC
check value", computed on request, with no new lookup table.

**The arithmetic does not close.** 8 base62 characters is `8 × log₂(62) = 47.6 bits` of total
capacity. Three things have to fit inside it:

| what has to fit | why it must be there | cost |
|---|---|---|
| a reference to the occurrence | the link has to point somewhere | `activity_occurrence.id` is a uuid = **128 bits** |
| a reference to the subscriber | PRD wants clicks attributed per subscriber (`sms_click_event.subscriber_id`); a token identical for every recipient cannot carry that | ~24 bits minimum |
| an integrity check | otherwise a guessed token is indistinguishable from a real one | 16–20 bits to be worth anything |

The occurrence reference **alone** is 2.7× the entire budget, before either of the other two.
And widening the token to hold a raw uuid is not the escape hatch it sounds like: 128 + 24 + 16
bits is ~29 base62 characters — *longer than the uuid it was supposed to shorten*.

**What I built instead.** The token stops carrying uuids. Two new
`short_ref bigint GENERATED ALWAYS AS IDENTITY` columns — one on `sms_consent` (inside
migration 0034, since that table is new) and one on the existing `activity_occurrence`
(migration **0037**, which is a fourth migration the PRD did not name and which exists only
because of this) — give each row a compact integer alias. `id` stays the primary key and the FK
target everywhere; `short_ref` is *only* a link-encoding alias.

```
occurrence short_ref   32 bits    4.29e9 values (catalogue is ~5,600 rows today)
subscriber short_ref   24 bits    16.7M values (Metro Vancouver's whole population is ~2.6M)
HMAC-SHA256 check      20 bits    1-in-1,048,576 per forgery attempt
────────────────────────────────────────────────────────────────────────────────
TOTAL                  76 bits →  ceil(76 / log2(62)) = 13 base62 characters
```

Roughly 5 characters more than the PRD imagined, on a URL that is ~35 characters regardless:
`https://kidsfun.example/k/7bQ2mX9pLa4Rd`.

**The PRD's actual constraint is preserved.** "No new lookup *table*" — nothing to join, no
mapping table, no write when a link is minted — still holds. Decoding resolves `short_ref → row`
with one indexed read, which is the same single indexed read the uuid would have cost. What is
*not* preserved is the literal character count.

Every width is a named, adjustable constant in `lib/sms/short-link.ts`; `TOKEN_LENGTH` is
derived from them, so re-budgeting later is a one-line edit and the unit test tells you
immediately.

**Honest note on the 20-bit check.** It is not cryptographically strong and is not meant to be.
A forged token lands on public catalogue data and writes one bogus `sms_click_event`; the check
exists to keep enumeration from silently polluting click analytics, not to protect a secret. If
the token ever carries something confidential, `CHECK_BITS` is the constant to raise.

> **This is my call, not the PRD's.** I chose 32/24/20 because they fit the actual data with
> real headroom. Please confirm the ~13-character link is acceptable, and confirm you are happy
> adding a column to `activity_occurrence` (migration 0037 — see the deploy note in §d.4).

---

## b. `lib/search/text/trigram.ts` `similarity()` — reusable, with two measured caveats

**Yes, it is directly reusable.** It is pure (`normalize()` + set arithmetic, no DB import), it
takes two strings and returns Jaccard-over-trigram-sets in `[0,1]`, and it is a faithful
reimplementation of Postgres `pg_trgm.similarity()`. Nothing needs reimplementing and nothing
needs changing for the dedup pass to call it. Use `similarity()`, **not** `typoSimilarity()` —
that one applies an edit-distance guard designed for single-word search queries and will return
0 for almost every real title pair.

I measured it on realistic catalogue-shaped titles rather than assuming. Two things you should
know before fixing the threshold at 0.85:

**Caveat 1 — 0.85 is tighter than it sounds; real duplicates score below it.**

| pair | score | verdict at 0.85 |
|---|---|---|
| `Public Swim` ~ `Public Swim` | 1.000 | dup ✓ |
| `Drop-In Basketball` ~ `Drop In Basketball` | 1.000 | dup ✓ (hyphens/case already handled by `normalize()`) |
| `Lego Club` ~ `LEGO Club` | 1.000 | dup ✓ |
| `Family Public Swim` ~ `Public Family Swim` | 1.000 | dup ✓ (metric is word-order-insensitive) |
| **`Parent & Tot Swim` ~ `Parent and Tot Swim`** | **0.800** | **MISSED** |
| **`Preschool Storytime` ~ `Preschool Story Time`** | **0.783** | **MISSED** |
| `Storytime` ~ `Baby Storytime` | 0.667 | not a dup — correct |
| `Saturday Family Swim` ~ `Sunday Family Swim` | 0.583 | not a dup — correct |
| `Public Swim` ~ `Public Skate` | 0.471 | not a dup — correct |

`&`→`and` and compound-splitting (`Storytime`/`Story Time`) are *exactly* the cross-source
variation the dedup pass is for — two municipalities writing the same programme differently —
and 0.85 lets both through as separate picks. Something in the **0.75–0.80** range catches them
while still rejecting `Storytime`/`Baby Storytime` (0.667). I have not changed anything; the
threshold is the PRD's to set. It just should not be set at 0.85 on the assumption that it is
loose.

**Caveat 2 — title similarity alone is not a dedup key, and this one can bite.**
`Public Swim` at Delbrook and `Public Swim` at Karen Magnussen score **1.000**. Generic titles
recur verbatim at every rec centre in the region, so a dedup pass keyed on title alone will
collapse two genuinely different weekend options into one and hand the parent five picks where
it thinks it gave them six. The dedup comparison needs venue and/or start time alongside the
title. (Interestingly, once the venue *is* in the string the metric separates them correctly on
its own: `Public Swim at Delbrook` ~ `Public Swim at Karen Magnussen` = 0.385.)

---

## c. Age from a birth *year* is off by up to a year near a birthday — accepted, documented

`sms_consent.birth_years` stores one **year** per child (no month, no day), derived at signup
from a plain "how old is your child now" number: `birth_year = current_year - entered_age`. The
send job recomputes the age every week.

The consequence, stated plainly: **we do not know the month, so a computed age can be wrong by
close to a year, in the "too old" direction, until the real birthday passes.** A child born in
December 2020 reads as 5 for all of 2025 even though they are 4 until December. Near an
age-band boundary that puts them in the next band up for most of a year — a 4-year-old getting
5–9 programming.

**This is an accepted PRD tradeoff, not a bug, and I have not attempted to fix it.** The
alternative is asking parents for a child's date of birth, which is a materially more sensitive
piece of data about a minor for a product that texts weekend suggestions. I have recorded the
tradeoff in the migration's column comment so a future reader hits it before they "fix" it. If
it ever needs tightening, the cheap half-measure is asking for birth *month* as an optional
field — a year plus a month is enough to be exactly right, without holding a date of birth.

(Observation only, out of scope as instructed: `user_profile.saved_child_ages` is a second,
unrelated child-age representation that already exists. I have not touched it. Worth a decision
eventually about whether two live representations is intentional.)

---

## d. Other concrete risks I hit while drafting

**1. A real bug in my own first draft: a decomposed accent got deleted into a consent
confirmation.** The keyword normaliser originally did "delete everything that is not a letter,
a digit, or whitespace," which reads as conservative and is the opposite. Phone keyboards emit
**decomposed** Unicode — `í` arrives as plain `i` + a separate combining acute (U+0301) — and a
combining accent is a Mark, not a letter. So `Joín` had its accent deleted and became a clean
`JOIN`: a reply that does not say JOIN, silently promoted into a CASL express-consent record.
Caught by the unit test, not by reading the code. Fixed two ways: `.normalize('NFC')` first, and
the filter inverted from an allowlist (`keep \p{L}\p{N}`) to a denylist (`remove \p{P}\p{S}`) so
that unforeseen categories make the body *less* keyword-shaped rather than more. Pinned in
`tests/sms/keywords.test.ts`. **Generalisable lesson: for consent matching, every normalisation
step must fail toward `unknown`.**

**2. The `sms_send_log` FK/purge tension — resolved, but it leaves one unguarded assumption.**
Migration 0017 chose `ON DELETE CASCADE` for `weekly_email_send` and explained why: account
deletion should take the send history with it. That is the wrong answer here and I went the
other way — `subscriber_id` is nullable with `ON DELETE SET NULL`, and `phone_hash` is `NOT
NULL` on every row. The reason is that the two tables sit under different obligations:
`weekly_email_send`'s recipient is already a pseudonymous `user_id`, whereas `sms_send_log`'s
entire evidentiary value is the link between a **real phone number** and a commercial message.
If a purge takes the log with it, the exact scenario CASL exists for — "you texted me and I
never consented" — is the scenario in which we destroyed our own evidence.

The unguarded assumption that leaves: **`SMS_PHONE_HASH_SALT` is effectively non-rotatable and
nothing enforces that.** Rotate it and every historical `phone_hash` becomes unmatchable — the
audit trail is still there, still queryable, and silently no longer findable by phone number,
with no error anywhere. Options, none of which I implemented (they are past the PRD's data
model and yours to call): add a `phone_hash_version` column, or write the salt's non-rotatable
status into the credential vault entry. **My recommendation is the version column** — it costs
one `smallint` and turns a silent failure into a visible one.

**3. `sms_click_event` needed three *different* `ON DELETE` answers, and one of them is a trap.**
`subscriber_id → sms_consent` is `SET NULL` (same argument as above, lower stakes).
`send_log_id → sms_send_log` is deliberately left at `NO ACTION` — the audit trail is never
deleted, so if that FK ever fires an error is the *correct* outcome rather than a cascade that
quietly helps destroy it. But `occurrence_id → activity_occurrence` had to be **CASCADE**, and
that is the non-obvious one: catalogue rows are normally soft-deleted (`archived_at`), but hard
`DELETE FROM activity_occurrence` **does** exist in the admin path and in ~20 test teardowns.
Without the cascade, this table becomes a brand-new FK dependency that makes those deletes fail
with 23503 — which is precisely the failure 0017's comment already records having hit once.

**4. Migration 0037 is not a free `ALTER`.** Unlike 0032's nullable `ADD COLUMN`, an identity
column is implicitly `NOT NULL` and must be materialised for every existing row, so
`ALTER TABLE activity_occurrence ADD COLUMN short_ref bigint GENERATED ALWAYS AS IDENTITY`
**rewrites the table under an `ACCESS EXCLUSIVE` lock**. At ~5,600 rows that is sub-second and
safe to run live. It would not be at a thousand times the size, and it is worth knowing before
someone copies the pattern onto a big table.

**5. Twilio signature verification: the URL must be *configured*, never inferred.** The
signature is computed over the full request URL, and behind TLS termination or a platform edge
the URL a Next handler observes can differ from the one Twilio used — `http` vs `https`, an
internal host, a trailing slash. Rebuilding it from request headers means letting a caller shape
the very string its own auth check runs over. So `SMS_WEBHOOK_PUBLIC_URL` is an env var that
must match the Twilio console value character for character, and a mismatch **fails closed**
(every request rejected — loud misconfiguration, not silent bypass). Note this applies to the
outbound *status callback* route too, when it exists: different URL, needs its own config value.

**6. RLS is correct by construction but I could not verify it by running anything.**
`tests/rls_public_tables.test.ts` enumerates the catalog live, so the three new default-deny
tables are covered by that invariant automatically with no list to edit — but it is a `db`-lane
test and there is no database here, so that is an argument, not a green check. Likewise
**none of the four migration files has been parsed by a real Postgres.** They are reviewed SQL,
not verified SQL. First apply should be to staging with the usual staged-deploy discipline
(0027), and the two `CHECK` constraints with regex/enum lists are the most likely place for a
typo to surface.

**7. Small design clarification on `preferences_token`.** The PRD calls it "HMAC-derived,
regenerable". Those two properties are in mild tension: a value that is *purely* derived from
the row and a server secret cannot be regenerated for one subscriber without rotating the secret
for everybody. So I made it a stored, nullable column with a partial unique index — the value is
still HMAC-derived at mint time, and rotation is now a per-row `UPDATE` that invalidates a leaked
link without touching anyone else's. It is a bearer credential at rest; default-deny RLS plus
service-role-only access is what protects it.

---

## e. `npm install twilio` — **it worked.** Ran cleanly, no workarounds.

```
$ npm install twilio --save
added 606 packages, and audited 607 packages in 47s
```

Exit 0. `twilio ^6.1.0` is now in `package.json` `dependencies`; `package-lock.json` grew by
~285 lines. Both are committed on this branch — revert them if you would rather the dependency
arrive with the send path than with this draft. (`node_modules/` was empty in the fresh
worktree, which is why the count is 606 rather than 1 — most of that is the existing dependency
tree being installed, not Twilio's.)

Full disclosure of what came with it: `npm audit` reports 16 vulnerabilities (2 moderate, 13
high, 1 critical) across the whole tree. **I did not investigate whether any of them are in
Twilio's subtree or were pre-existing in the repo's own dependencies, and I did not run
`npm audit fix`** — changing the lockfile to chase advisories is not something a draft branch
should do unilaterally. Flagging it so it gets looked at deliberately rather than discovered
later.

**The webhook code does not actually use the SDK**, deliberately. `lib/sms/twilio-signature.ts`
implements the documented signature algorithm in ~30 lines of `node:crypto`, which keeps the
module pure, keeps it testable in the `unit` lane with no SDK import, and keeps the
configured-not-inferred URL decision visible instead of buried inside a helper. The SDK *is*
used in the test, as an independent reference implementation — `tests/sms/twilio_signature.test.ts`
asserts our hand-rolled output matches `twilio`'s own `getExpectedTwilioSignature` for the same
input, so a subtly wrong algorithm (wrong sort, a separator, SHA256 instead of SHA1) fails the
build rather than every production webhook. The SDK will be genuinely needed by the *outbound*
send path, which is not in this branch — so if you would rather it landed there, nothing here
breaks by dropping it.

---

## What is in this branch

| file | what it is |
|---|---|
| `supabase/migrations/0034_sms_consent.sql` | subscriber + CASL consent record, default-deny RLS, unique phone, status/method CHECKs, `short_ref` |
| `supabase/migrations/0035_sms_send_log.sql` | append-only send/audit log; nullable `subscriber_id` + `NOT NULL phone_hash` so the audit trail outlives a purge |
| `supabase/migrations/0036_sms_click_event.sql` | click attribution; three FKs with three different `ON DELETE` answers |
| `supabase/migrations/0037_activity_occurrence_short_ref.sql` | **not one of the PRD's three** — the column that makes the short link possible (§a) |
| `lib/sms/config.ts` | every SMS env var in one place; `smsSendingEnabled()` mirrors `lib/email/config.ts` |
| `lib/sms/short-link.ts` | the 13-char token: encode/decode, HMAC check, constant-time compare, bit budget as named constants |
| `lib/sms/keywords.ts` | inbound keyword classification — fully implemented, pure |
| `lib/sms/twilio-signature.ts` | signature verification — fully implemented, pure, `node:crypto` only |
| `lib/sms/consent-transitions.ts` | **stubs**: the four inbound state transitions, with the exact SQL and the non-obvious correctness note for each |
| `app/api/sms/inbound/route.ts` | the webhook: signature check first, payload cap, keyword dispatch, dry-run gate, TwiML reply |
| `tests/sms/*.test.ts` | 19 unit tests, all passing |
| `.env.example` | the SMS env block (names only, all unset) |
| `package.json` / `package-lock.json` | `twilio ^6.1.0` |

Full suite green after these changes: **209 files / 3485 tests passing** in the `unit` lane
(`npx vitest run --project unit --fileParallelism`), plus `tsc --noEmit` and `eslint` clean on
the new files. The `db` and `invariants` lanes were not run — no database in this environment.

---
---

# Round 2 — npm audit classification, `phone_hash_version`, and the real selection algorithm

**Still DRAFT on `feat/kf-sms-pivot-draft`. Nothing applied, nothing pushed, no migration run.**

Round 1's two findings (the ~0.78 dedup threshold and `phone_hash_version`) were verified and are
now in the PRD as v2.3 §2.2 and §5. This round implements them and adds the selection algorithm.

---

## f. npm audit: **all 16 are pre-existing. Twilio introduced zero.**

Method — a real A/B, not a guess. `origin/main`'s `package.json` + `package-lock.json` were
checked out to a scratch directory and audited in isolation; the branch was audited as-is; the
two advisory sets were then diffed by (package, severity).

| | base (`30e232a`, no twilio) | branch (with twilio) |
|---|---|---|
| critical | 1 | 1 |
| high | 13 | 13 |
| moderate | 2 | 2 |
| **total** | **16** | **16** |

The two sets are **identical, package for package**. No advisory path in the branch audit passes
through `twilio` at all.

**The one critical is pre-existing and is `vitest` itself** (`<=3.2.5`, a *direct devDependency*
at 2.0.5): RCE when the Vitest API server is listening and a malicious site is visited, plus
arbitrary file read/execute via the Vitest UI server, inherited through `vite` / `vite-node`. It
is a test-runner vulnerability with no production reachability — it cannot be hit by a deployed
Next.js app, only by a developer running `vitest --api`/`--ui` while browsing. The 13 highs are
the same shape: `next`, `postcss`, `minimatch`, `brace-expansion`, `glob`, `js-yaml`, `nanoid`,
`fast-uri`, `vite`, and the eslint/typescript-eslint chain.

Still **not** auto-fixed, deliberately. `npm audit fix --force` on this tree would want to move
`vitest` across a major version and touch `next`, which is a real upgrade with its own testing —
a decision for a dedicated change, not a side effect of adding an SMS dependency.

---

## g. `phone_hash_version` — added to `0035_sms_send_log.sql`

`phone_hash_version smallint NOT NULL DEFAULT 1`, in the **same migration file** (it has not been
applied anywhere, so there is nothing to migrate *from*). It carries a header block and a
`COMMENT ON COLUMN` stating the reasoning the PRD now records: it says which salt generation
produced the row's `phone_hash`, so a future rotation of `SMS_PHONE_HASH_SALT` becomes an
explicit branch a lookup can handle instead of a silent, permanent, undetectable break in the
CASL audit trail. `DEFAULT 1` so the writer needs no awareness of it until there is a second
salt. It is a generation number, not a salt and not a hint about one.

---

## h. The selection algorithm — `lib/sms/weekly-picks.ts`

Pure over a wired engine, same posture as `lib/recommend/three-things.ts` and
`lib/email/digest.ts`: it takes a `SearchEngine`, a clock, a resolved origin, birth years,
interests and the empty-week counter, and returns a decided set of picks. No DB, no network, no
Twilio, no `new Date()`. **`lib/recommend/three-things.ts` was not modified** — two of its
exports (`isShowableOnFrontDoor`, `foldTitleForComparison`) are imported rather than copied.

All six PRD steps are implemented: age bands from birth years at call time → engine search →
dedup → capped coverage swap → one non-compounding retry → outcome branches. 30 unit tests
against a fixture-backed real `SearchEngine`.

### h.1 **"Same parent org" cannot be implemented from the current schema. I did not fake it.**

This is the flagged item from the brief, and the answer is a clean no.

* The `organisation` table exists (migration 0003) and is **orphaned**. Nothing in the schema
  references `organisation(id)` — there is no `organisation_id` on `venue`, on `activity_series`
  or on `activity_occurrence`. Migration **0010's own header already says so**: *"the current
  schema has no organisation link on activities (no organisation_id on series/occurrence). We use
  venue.name + source.name for [weight C] … wiring a direct organisation_id is a candidate."*
* Consequently `lib/search/postgres-repository.ts` fills `ListingRecord.organisation` with the
  **ingestion source's name** (`source.name`), not a parent organisation.

Using that field as a proxy would be **actively harmful, not merely imprecise**. One source
covers an entire municipality's recreation feed, so "same organisation" would be true for every
pair of listings in that municipality. Because the PRD's venue test is an **OR** (`within ~500m`
**or** `same parent org`), that arm would swallow the 500m guard entirely — and the guard is the
only thing standing between this pass and the exact failure the PRD names: "Public Swim" at two
unrelated rec centres scoring 1.000 on title alone.

**What I built instead:** the arm is an injected predicate, `sameParentOrg`, defaulting to
"never". Venue distance (plus exact venue-name identity, which needs no coordinates and matters
because un-geocoded venues are normal here) carries the condition for the draft. The day an
`organisation_id` exists this is a one-line wiring, not a rewrite. A test covers both settings.

**Open question for the Operator:** is wiring `organisation_id` in scope for the SMS launch, or
does venue-distance carry it for MVP? MVP-with-distance-only is defensible — it under-merges
rather than over-merges, which is the safe direction.

### h.2 Other findings from building it

**1. The `saved_home` origin mode is unusable for SMS subscribers.** The engine has an origin
mode that takes a postal code — exactly what a subscriber has — and `resolveOrigin` throws
`auth_required` on it unless `signedIn` is true (`lib/geo/origin.ts:66`). An SMS subscriber is
never signed in; that is the product's premise. So postal→point happens in the *caller* (which
holds the geocoder) and the module takes a resolved `GeoPoint`, using `near_me` purely as the
transport for a raw coordinate. Not a blocker, but it means the send job needs the geocoder
wired, and a postal code that fails to geocode is a case the job must handle.

**2. Category interests have no structured engine parameter, so they are a post-filter — and
being a *filter* has a cost the PRD should see.** `SearchRequest` has no category field; the only
way to express one is free text in `q`, which turns a browse into a scored text search that
reorders everything and drops whatever the matcher scores below threshold. So interests are
applied to the engine's ranked output instead. The PRD calls this a *filter* (§2.2 step 2) and it
is implemented as one — which means **a subscriber who ticks one narrow interest can be filtered
below the floor and get an empty week on a weekend that was full of things for their kids.** The
PRD's retry widens radius and dates but explicitly **not** interests, so I implemented exactly
that and pinned the consequence in a test rather than quietly softening it. Worth a V1 decision:
should the retry drop interests before it declares an empty week?

**3. Registration-shaped courses are excluded, inherited from the engine's default.**
`includeRegistration` defaults to false, so `isRegistrationShaped` drops any title matching
`\bclass(es)?\b`, `\blessons?\b`, `\bcamps?\b`, `\bworkshops?\b`, `\bcourses?\b` and friends. That
is the right default for "what can we do this weekend" and it matches /search — but it materially
shapes what a weekly text *can* contain: a rec centre's Saturday programme is largely registered
courses, and none of it is eligible for a pick. This found me rather than the other way around —
two fixture rows named "Cooking Class" and "Skate Lesson" vanished before the selector ever saw
them and made a cap test look like a cap bug. Pinned in a test now.

**4. "Weekend + Mon/Tue" is not expressible as a `when` quick-pick.** The vocabulary is
`any | today | tomorrow | weekend`. The retry therefore sends a structured `dateRange` of
Saturday→Tuesday and drops `when` (the two are mutually exclusive). The Saturday itself comes
from `relativeDate('weekend', now)` — the same resolver /search uses — so "this weekend" means
the same pair of days in a text as it does on the site.

**5. The 0.78 threshold matches titles that differ only by a trailing number.** Measured:
`"Toddler Session 0"` ~ `"Toddler Session 1"` = **0.800**, above the cutoff (`"Camp Week 1"` ~
`"Camp Week 2"` = 0.714, below). Combined with the required same-time and same-place conditions
this is usually *right* — two numbered sittings of one thing at one venue are one outing. But it
would also merge, say, "Drop-In Gym 1" and "Drop-In Gym 2" running simultaneously in two rooms of
one facility. Not a defect at 0.78 specifically; a property of trigram similarity on short
titles, recorded so it is a known behaviour rather than a surprise.

**6. Coverage-swap interpretation, stated because the PRD phrase is slightly ambiguous.** "One
forced pick per band, max 2 total displacements" is implemented as: **at most 2 forced picks
total**, at most one per band, reaching only into the top 20 of the ranked deduped list. When the
selection is already full a forced pick displaces the lowest-ranked **non-forced** pick (so two
forced picks can never evict each other); when the selection is not yet full it simply appends,
and that still counts against the cap of 2 — because the cap is about how much forcing the
surface does, not about how many slots happened to be occupied. If you meant "2 displacements but
unlimited appends", that is a one-line change.

**7. The retry *replaces* the primary result set rather than merging with it.** The retried
search is a superset by construction (wider radius, wider window, same filters), so merging could
only reintroduce candidates the retry's own dedup pass had already collapsed. Non-compounding is
enforced *structurally*: `buildPicksRequest` reads only the original input, so there is no state
to widen twice from — pinned by a test that builds the retry ten times and asserts the radius is
still 20km.

**8. The floor is 3; "5–10" is not a gate.** A 4-pick week sends as a 4-pick week and does **not**
trigger the retry, because the PRD makes only the floor a gate. Implemented as specified and
flagged: whether a below-5 week should also degrade is a V1 tuning question.

### h.3 Verification

`tests/sms/weekly_picks.test.ts` — 30 tests over a real `SearchEngine`, covering normal fill and
the direct/hub split; the coverage-swap cap actually capping at 2 (three unrepresented bands, two
forced, one left unrepresented); the top-20 reach boundary; append-vs-displace; the retry firing
once and not compounding; both PRD dedup calibration pairs merging; same-title-different-venue
**not** merging; the 500m arm; edge-inclusive time overlap; open-hours handling; the injected
`sameParentOrg` arm; both empty-week reasons; and the pause flag.

Whole SMS suite: **49 tests**. Full `unit` lane after these changes: **210 files / 3515 tests
passing**, `tsc --noEmit` and `eslint` clean. The `db` and `invariants` lanes were not run — no
database in this environment, and no Postgres has parsed any of the four migrations.

---
---

# Round 3 — the interest-drop retry, and the public signup form

**Still DRAFT on `feat/kf-sms-pivot-draft`. Nothing applied, nothing pushed, no migration run.**

---

## i. Retry step (b) — drop the category filter before declaring an empty week

PRD v2.4 §2.2 step 5(b), implemented in `lib/sms/weekly-picks.ts`. The ladder is now:

```
primary                          the weekend, their radius, their interests
  ↓ below floor
(a) widened                      one radius step out, window relaxed to Sat–Tue
  ↓ below floor AND they stated an interest
(b) interests dropped            the same widened search, minus the category post-filter
  ↓ below floor
empty week
```

Three properties, each pinned by a test:

1. **Step (b) reuses step (a)'s response — it does not search again.** Interests are a
   post-filter on ranked results, not a query parameter, so (b) asks the engine an identical
   question. Issuing it twice would be wasted work *and* a place for two answers to the same
   question to differ. `buildPicksRequest` returns the same request for both attempts, and the
   pipeline is split into search / `selectFrom(applyInterests)` so "drop the filter" is a
   one-argument change rather than a second pipeline. A test spies the engine and asserts exactly
   two calls.
2. **It is skipped when there is nothing to drop.** A subscriber who stated no interests has no
   filter to relax, and firing it would record a degradation they never suffered — into
   `sms_send_log`. `degradation` stays `'widened'`.
3. **It widens what qualifies, never what we stand behind.** `isShowableOnFrontDoor`, the dedup
   pass and the coverage-swap cap all still run. Pinned by a test where everything on offer is
   postponed: (b) fires and the week is still, correctly, empty.

The result now carries `degradation: 'none' | 'widened' | 'widened_and_interests_dropped'` and
`interestsDropped`, reported rather than inferred so the message copy and the send log cannot
reach a different conclusion than the selection did.

Also aligned `MAX_FORCED_PICKS`' comment with v2.4 §2.2 step 4, which resolved round 2's
ambiguity in the direction already built: **2 forced picks total across all bands**, not 2 per
band. No code change — the implementation already matched.

`tests/sms/weekly_picks.test.ts` is now 35 tests.

---

## j. The public signup form

Reachable at **`/sms/signup`**, posting to **`POST /api/sms/signup`**.

| file | what it is |
|---|---|
| `lib/sms/consent-copy.ts` | every word the form says about consent, in one **versioned** place |
| `lib/sms/interests.ts` | the optional interest checkboxes, keyed on the seeded category taxonomy |
| `lib/sms/signup-validate.ts` | the whole accept/reject surface — pure, no `pg`, no `next` |
| `lib/sms/sparse-areas.ts` | the "just getting started in your area" decision |
| `lib/sms/signup-store.ts` | **stubs**: the `sms_consent` upsert and the confirmation send |
| `app/api/sms/signup/route.ts` | flag, caps, validation, error mapping |
| `app/sms/signup/page.tsx` | server component; measures the sparse municipalities |
| `app/sms/signup/_components/SmsSignupForm.tsx` | the form |
| `app/sms/signup/signup.css` | co-located, `--kf-*` tokens only |
| `tests/sms/signup_{validate,copy,form,route}.test.*` | 57 tests |

`npx next build` succeeds with `/sms/signup` (5.43 kB) and `ƒ /api/sms/signup` in the route
manifest — so this is genuinely deployable to staging, not just type-correct.

### j.1 How it is flagged off

`SMS_SIGNUP_ENABLED`, default **false**, mirroring `lib/email/config.ts`'s `sendingEnabled()`.
The page calls `notFound()` and the route returns **404** (not 403 — while the sign-off gate is
unrecorded this endpoint does not exist as far as the outside world is concerned, and a 403 would
advertise a disabled consent-collection endpoint on a public host). The route is gated *before*
it reads the body, so a flagged-off endpoint will not buffer an unauthenticated caller's payload
at all; a test asserts that.

> **Reviewing this locally or on staging? Set `SMS_SIGNUP_ENABLED=true` or you get a 404.**

**It is a separate flag from `SMS_SENDING_ENABLED`, and that is the point.** Staging wants
`SIGNUP=true` + `SENDING` unset: the form renders and validates for real, a screenshot can be
taken for the Toll-Free Verification submission, and not one text is dispatched and not one
consent row is written. One combined flag could not express that, and the alternative — turning
on real sending in order to take a screenshot — is not a thing anyone should have to do. The
success response returns `{ ok: true, dispatched: false }` in that mode, so a screenshot session
cannot mistake a dry run for a live signup.

### j.2 Validation

One pure validator, `parseSmsSignupBody`, **used by both sides** — the client renders its inline
errors from the same function the route enforces with, so the two cannot disagree. The server
still re-validates from scratch and trusts nothing from the client.

- **Phone → E.164.** Checks the only two things knowable from digits alone: length, and the NANP
  rule that area code and exchange both begin 2–9. That catches the whole typo class a parent can
  see and fix (dropped digit, transposed pair, `064`); anything subtler is the confirmation
  text's job, which is why the confirmation text exists. A test asserts the output matches
  **migration 0034's `sms_consent_phone_e164` CHECK regex verbatim** — if those two ever drift,
  every signup fails at the database with an error the form cannot explain.
  *Canada vs the US is not distinguishable from a +1 number and this does not pretend otherwise;
  the geographic gate is the postal code.*
- **Postal.** Imports `normalizePostal` from `lib/user/profile-validate.ts` — imported, never
  modified, and a pure string normaliser with no account semantics. A second Canadian postal
  regex would be a second thing to keep in step. Nothing else crosses that boundary, and
  `user_profile.saved_child_ages` is untouched (confirmed by diff).
- **Ages.** One whole number per child, 0–18, converted to a birth year at entry so an age never
  reaches the database. **18, not 19**: the audience filter excludes adult-only content from 19,
  so a 19 entered as a "child" would have every match excluded downstream.
- **Consent.** Checked *first* — nothing else about a submission matters if it is absent, and
  reporting a phone typo to someone who never ticked the box asks them to fix the wrong thing.
- Errors never echo the submitted value back (a public endpoint that repeats its input is a
  reflector), and each carries the `field` it belongs to so the form renders it in place.

### j.3 Open questions — the three I would most like an answer on

**1. An out-of-area postal code is REJECTED, not warned about. The PRD does not specify this.**
A postal outside the five covered municipalities resolves to no FSA, so `fsaGeocoder` returns
null, so the weekly send job has no origin and can never select anything — not "few picks",
*none, ever*. Accepting the signup would mean taking a phone number and a child's age from
someone we can demonstrably never serve, holding that data under CASL, and texting them an empty
week every Friday until they opt out. So the form rejects and names the five areas we do cover.
*This is distinct from the sparse-area case, which is a warning: West Van has thin coverage but
real coverage, and it can improve.* **If you would rather capture them as a waiting list,
`region_notify_signup` (migration 0033) is the table that already does exactly that, and this
rejection is where the hand-off would go.**

**2. The PRD says "static lookup" for the sparse municipalities. The codebase already argues
against one — in writing.** `lib/search/coverage.ts`'s header says: *"It is deliberately NOT a
per-region allowlist of West Van and Burnaby. Naming the two municipalities that happen to be
thin today would go stale silently in both directions."* That argument is **stronger** at signup
than on /search: stale in the first direction, a hardcoded list talks a parent out of a product
that would have worked; stale in the second, it takes their consent without the warning that was
the whole reason for the notice. So the page **measures** — one search over all five area chips
with no query constraint, reading the engine's own `regionCoverage` verdict — and falls back to
the static `['wvan','bby']` only when the catalogue is unreachable. The fallback warns rather
than going quiet, because over-warning a good area is cheaper than silence in a thin one.
**Flagging in case "static lookup" was a deliberate simplification rather than shorthand.**

**3. `class_program` is deliberately NOT offered as an interest, and that is downstream of the
still-open PRD §8.** The selection module inherits `includeRegistration: false`, so class /
lesson / camp / course / workshop titles are dropped *before* the interest filter runs. Offering
"Classes & programs" would offer a near-unmatchable box: a parent ticks it, the filter narrows to
a category the pipeline has already excluded, and the most likely outcome is step (b) firing for
them every single week. **If Jon answers §8 by including registration content, add the key back —
it is one line, and the comment in `lib/sms/interests.ts` says so.**

### j.4 Two things about the compliance artefact specifically

**The form renders a visible draft banner, and it should not be screenshotted until that banner
can come down.** CASL §1.4 requires a legal sender name, a mailing address and a reachable
support contact. All three are real-world facts I must not invent, so the page renders
`MISSING_SENDER_IDENTITY` — a visible note saying they are missing — rather than placeholder
text that would read as real in a screenshot. Same reasoning as `/terms`' visible draft notice: a
code comment reaches developers; the person who could be misled by an incomplete consent form is
the parent, or the verification reviewer, reading the live page. **This is a direct blocker on
the screenshot's usefulness, not a nitpick.**

**I added carrier-facing disclosures the PRD does not list, and I am flagging that rather than
folding them in silently.** PRD §1.3/§1.4 specify the PIPEDA and CASL disclosures — those are
about the subscriber and the regulator. Message frequency, "message and data rates may apply",
STOP and HELP are about the *carrier*, and are the elements an opt-in screenshot is commonly
rejected for missing. Since this form's stated purpose includes being that screenshot, omitting
them would produce a form that satisfies the PRD and fails the job it was built for. They render
as a separate block, outside the consent checkbox, so what is being consented to stays distinct
from standing facts about the service. **These should be checked against the current Twilio
Toll-Free Verification form before submission rather than trusted from here — the expectations
are Twilio's and they change. My claim is only that these are commonly-required elements, not
that this list is authoritative.**

**A smaller gap in the same area:** §1.3 requires naming where to view/edit/delete "the
preferences page, **linked**". The consent copy *names* it but does not link it, because that
page is token-linked per subscriber (§2.4) and therefore has no address until someone is a
subscriber — a link here would 404 for every reader of this form. Naming the destination
satisfies the disclosure; inventing a URL would not. It becomes a real link when §2.4 ships.

### j.5 Consent copy is versioned, and the version is enforced by tests

`sms_consent.consent_text_version` is NOT NULL so that "which wording did this subscriber agree
to?" has an answer. That is only worth something if the wording and the version move together, so
all of it lives in `lib/sms/consent-copy.ts` next to the constant, with a file-header instruction
to bump on any edit — and `tests/sms/signup_copy.test.ts` asserts each of §1.3's four required
disclosures is actually present, so a future edit that was only trying to shorten a sentence
cannot quietly drop one. The version string is also **rendered on the page**, so a screenshot
taken today is self-identifying.

The form splits the consent sentence to emphasise "preferences page" in place; a test asserts the
split-and-reassemble is lossless, because a component that reordered or dropped a clause would
make `consent_text_version` point at wording no parent ever saw.

### j.6 Should there be an E2E?

**Yes, later — and worth one.** `renderToStaticMarkup` covers the initial render, which is the
state the compliance claims are about (unchecked consent, the full sentence present, one child
row, no pre-ticked interests, no leaked identifiers). What it structurally cannot reach is every
interactive path: add/remove child, the sparse notice appearing as the postal code is typed,
submitting with consent unticked, the submitted state. Playwright is already in this repo
(`npm run e2e`), so it is a file, not a project. I did not write one for a draft-only pass, and
it should not gate this review — but it should exist before the form takes real traffic, because
"the checkbox cannot be bypassed" is exactly the kind of claim that deserves a browser.

### j.7 Verification

`tsc --noEmit` clean, `eslint` clean, **`npx next build` succeeds** with both new routes in the
manifest. Full `unit` lane: **214 files / 3577 tests passing** (up from 210/3515). SMS suite is
now **111 tests** across 8 files. `db` and `invariants` lanes not run — no database here, and no
Postgres has parsed any of the four migrations.
