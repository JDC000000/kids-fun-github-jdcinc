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

---
---

# Round 4 — the weekly send orchestration

**Still DRAFT on `feat/kf-sms-pivot-draft`. Nothing applied, nothing pushed, no migration run.**

The I/O layer around `lib/sms/weekly-picks.ts`, mirroring `lib/email/weekly.ts`'s split.

| file | what it is |
|---|---|
| `lib/sms/message.ts` | pure message rendering + GSM-7/segment math |
| `lib/sms/empty-week.ts` | the counter and pause rule — one pure function, its own file |
| `lib/sms/weekly-send.ts` | **pure** per-subscriber builder: geocode → ages → select → render |
| `lib/sms/weekly-send-io.ts` | the orchestrator: deps, per-subscriber unit, bulk driver, stubs |
| `app/api/sms/weekly/run/route.ts` | the scheduled entrypoint |
| `tests/sms/{weekly_send,empty_week,weekly_run_route}.test.ts` | 38 tests |

`lib/sms/config.ts` gains `smsCronSecret()`, `siteUrl()`, `shortLinkUrl()`, `preferencesUrl()`;
`.env.example` gains `SMS_CRON_SECRET`.

---

## k. **The finding: PRD §2.6's punctuation costs 3× per message.** Needs sign-off.

An SMS is GSM-7 (**160** characters per segment, 153 concatenated) only if *every* character is
in the GSM 03.38 alphabet. One character outside it switches the whole message to UCS-2 at **70**
per segment. There is no partial penalty.

The characters that do this are exactly the ones a careful writer reaches for — em dash `—`, en
dash `–`, curly apostrophe `’`, curly quotes `“ ”`, ellipsis `…`. **PRD §2.6's example copy
contains an em dash and curly apostrophes.** Measured, not estimated:

| message | rendered verbatim from §2.6 | GSM-7-safe ASCII |
|---|---|---|
| empty week | 143 chars, UCS-2, **3 segments** | 143 chars, GSM-7, **1 segment** |
| ~~pause notice~~ | ~~183 chars, UCS-2, 3 segments~~ | see correction below |

Identical character counts. Identical words. Three times the bill on the empty-week text — the
message a struggling subscriber gets most often — every week, forever.

> **CORRECTION (round 5, mine).** The pause-notice row above is wrong and is struck out. I
> produced it by *reconstructing* the copy with curly apostrophes rather than reading the
> document's bytes: the real pause notice had straight apostrophes and no dash at all, so it was
> **already GSM-7 — 2 segments before and 2 segments after**, with nothing to save.
>
> The Operator separately caught the same class of error in `lib/sms/message.ts`'s comment, which
> said the copy contained "an em dash **and curly apostrophes**". It contained only the em dash.
>
> **The finding itself stands and is confirmed** — one em dash in the empty-week message really
> did force UCS-2 and really did cost 3 segments instead of 1, which is the whole point: a
> *single* character outside the alphabet converts the entire message. What was overstated is its
> SCOPE. It was one message, not two. Both the comment and the measurement test now say so, and
> `tests/sms/weekly_send.test.ts` pins the pause notice at 2-segments-either-way so the corrected
> record is enforced rather than merely written down.

**So the templates are written in GSM-7-safe ASCII**: em dash → `" - "`, curly quotes → straight,
ellipsis → `...`. Nothing else about §2.6's wording changes.

> **This is a deviation from approved consumer-facing copy, made by the implementer.** It is
> typographic rather than editorial, but it is still a change to copy Jon signed off, and it
> should be a decision rather than something that happened.

Three things keep it true afterwards: `estimateSegments()` is exported, every rendered message
carries its own segment count, and the bulk run returns `totalSegments` — so a copy edit that
reintroduces a curly apostrophe triples that number on the same run and is visible in the
response. A test (`assertGsm7Safe`) is the wall.

---

## l. `geocode_failed` is its own outcome — the design, and why

A postal code that resolves to no covered municipality returns **`geocode_failed`**, which maps
to the counter's **`not_attempted`** branch: **no message, no counter change, nothing written.**

Folding it into "below floor with 0 matches" would have been wrong twice over. It would have
texted a parent *"nothing new matches your area this week"* about a search that never ran — a
claim we never checked. And it would have incremented the empty-week counter, so three of them
would have **paused a subscriber for a defect on our side**.

The signup form now rejects out-of-area postals (round 3), so a subscriber in this state is
either a row that predates that check or an FSA table that has moved. Either way it is an
operational problem someone should see, which is why it surfaces as
`skipped_geocode_failed` with an explicit reason rather than blending into the empty count.

---

## m. `short_ref` as an input worked well — one consequence worth knowing

`occurrenceShortRefs: ReadonlyMap<string, number>` is a direct mirror of
`WeeklyDeps.createdAtMs` in `lib/email/weekly.ts`: that one carries occurrence timestamps for the
"new since last send" watermark, this one carries short-refs for link minting. Loaded once per
bulk run (`SELECT id, short_ref FROM activity_occurrence WHERE archived_at IS NULL`), reused for
every subscriber, and it keeps the pure builder free of any DB import. **No awkwardness — if
anything it made the mirror tighter.**

The one consequence: **a pick whose occurrence is missing from the map loses its direct link and
folds into "+N more" — it is not dropped from the week.** The selector decides the *intent*
(which picks deserve a direct link); the renderer decides what is *possible*. Dropping the pick
instead would silently shrink a week below the floor for a reason unrelated to the catalogue.
`unlinkableOccurrenceIds` is reported so a stale map is visible rather than merely survived.

*(bigint note: node-postgres returns `short_ref` as a string to avoid precision loss;
`Number()` is exact far past anything this sequence will reach, and `encodeShortLink` rejects an
over-range value rather than truncating it.)*

---

## n. Two seams I tightened rather than shipped as they were

**1. `consent_text_version` was an optional argument defaulting to `'unknown'`.** That would have
written a plausible-looking placeholder into the one column a CASL audit reads. It is now a
required field on the subscriber row (`sms_consent.consent_text_version` is `NOT NULL` in
migration 0035 anyway), so there is no default to leak.

**2. The phone number.** It is deliberately **not** on `SmsSubscriber` — the pure builder
geocodes, selects and renders, and none of that needs a number, so the type system keeps it out
rather than a convention someone has to remember. `loadActiveSubscribers` returns
`{ subscriber, phoneNumber }` pairs; the number goes only to `dispatchSms` and never reaches a
result object, a log line or an error string. The first draft passed `''` from the bulk driver,
which was the awkward bit the brief asked me to flag — this is the fix rather than the flag.

---

## o. Open question: "Nothing **NEW** matches your area this week"

The email digest sends only what is **new since the last send** (a watermark over
`activity_occurrence.created_at`). **PRD §2.2's selection algorithm has no equivalent step** — it
asks "what is on this weekend", and a weekly public swim is on every weekend. So a subscriber can
receive substantially the same picks several Fridays running, while §2.6's own empty-week copy
says *"Nothing **new** matches your area this week"*, implying a novelty notion the algorithm
does not have.

**Not silently fixed** — inventing a novelty filter would change what the PRD specifies. The
schema already supports it: `sms_send_log.picks_snapshot` exists precisely so a future run can
read last week's occurrence ids. If that becomes the decision, `loadActiveSubscribers` is where
the previous snapshot joins in and `selectWeeklyPicks` grows one `excludeOccurrenceIds` argument.

**This is a retention question more than a correctness one**, which is why it is worth a ruling:
the MVP's three metrics include churn, and "the same three swims every Friday" is a churn shape.

---

## p. Smaller decisions, each recorded where it lives

- **A failed dispatch changes nothing.** No counter advance, no status change — otherwise a
  Twilio outage would pause subscribers three weeks later.
- **A dry run reaches no writes at all.** `weekly_email_send` has a `dry_run` column and records
  both; `sms_send_log` deliberately has none (0035 defines it as a record of messages that were
  *sent*), so the orchestrator simply does not call the writer on a dry run.
- **21610 (opted out at the carrier)** marks the subscriber stopped immediately and skips the
  empty-week state — they are not paused, they are stopped. `COALESCE(stopped_at, now())` in the
  stub's SQL, so a retry cannot push the 30-day purge deadline out.
- **`applyEmptyWeekState`'s `WHERE ... AND status = 'active'`** guards the race where an inbound
  STOP lands mid-run; the inbound path wins and this write simply does not apply.
- **`loadActiveSubscribers` filters on `phone_number IS NOT NULL`**, not just `status = 'active'`
  — a purged row (0034 NULLs personal columns in place) is not a subscriber.
- **The run route's `sanitize` is an allowlist, not a redaction.** A field added to
  `SubscriberSendResult` later would pass through a denylist silently, and on this lane the thing
  that would pass through is a phone number. A test feeds it a result carrying a phone number, a
  message body and a preferences token, and asserts none reach the response.
- **`SMS_CRON_SECRET` is separate from `WEEKLY_EMAIL_CRON_SECRET`** — rotating one must not
  silently disarm the other, and a credential that triggers real text messages has a different
  blast radius from one that triggers emails. Unconfigured → 503, fail closed.

---

## q. Verification

`tsc --noEmit` clean, `eslint` clean, **`npx next build` succeeds** with `/api/sms/weekly/run` in
the route manifest. SMS suite: **149 tests across 11 files**. Full `unit` lane: **217 files /
3615 tests passing**. The `db` and `invariants` lanes were not run — no database here, and no
Postgres has parsed any of the four migrations.

---
---

# Round 5 — the four inbound state transitions

**Still DRAFT on `feat/kf-sms-pivot-draft`. Nothing applied, nothing pushed, no migration run.**

`lib/sms/consent-transitions.ts` rewritten from generic no-op stubs into real logic behind two
injected seams. `app/api/sms/inbound/route.ts` is **untouched** — its dispatch was already correct.

| file | change |
|---|---|
| `lib/sms/consent-transitions.ts` | rewritten: pure decisions + injected lookup/applier |
| `tests/sms/consent_transitions.test.ts` | new, 24 tests |
| `lib/sms/message.ts` | comment corrected (see §k correction above) |
| `tests/sms/weekly_send.test.ts` | measurement corrected + pause-notice row pinned |

---

## r. The shape: the WHERE clause as a pure function, the SET clause as data

```
decide*(row)      pure, total over ConsentRow | null — the documented WHERE clause, as a function
ConsentChange     the SET clause as data
findByPhone       STUB — one SELECT, injected
applyChange       STUB — one UPDATE, injected
```

Same injection idiom `selectWeeklyPicks` uses for `sameParentOrg`. Every row state is reachable in
a test today, and filling in the two seams is mechanical.

**`ConsentChange.stoppedAt` is a three-way enum — `'set' | 'clear' | 'leave'` — and that is the
whole reason the type exists.** "Leave it alone" is a *different instruction* from "set it to
null", and a `Date | null` field cannot express the difference. That difference **is** the
repeat-STOP bug: without it, a second STOP re-stamps `stopped_at` and pushes the 30-day purge
deadline out every time.

**`no_such_subscriber` falls out rather than being special-cased.** The lookup's WHERE clause is
`phone_number = $1`, and the 30-day purge NULLs `phone_number` in place — so a purged row is
invisible to it *by construction*. START-after-purge resolves to null with nothing testing for a
purge. That is the cleanest possible expression of the correctness note the comment already made.

---

## s. A fourth START case the original comment did not name

The documented START SQL is `WHERE phone_number = $1 AND status IN ('stopped','paused')`. There
are **four** row states, not three, and the fourth is **`pending`**: someone submitted the form,
never replied JOIN, and now texts START.

The UPDATE matches zero rows — *correctly*, because **START is not the double opt-in.** Activating
there would bypass the CASL confirmation entirely, which is the one thing this product's consent
design exists to prevent.

But it is not `no_such_subscriber` (the row is right there) and not `already_in_state` (pending is
not what START targets), **and the webhook's reply differs in all three cases**: "sign up here" /
nothing / "reply JOIN to confirm". Collapsing it into either existing outcome would make the
webhook say the wrong thing to someone who is one text away from being a subscriber.

So it gets its own outcome, **`awaiting_confirmation`** — nothing written, and the route can reply
correctly. Flagged as an addition beyond the five outcomes the brief listed; all five of those
remain reachable and tested.

---

## t. HELP — **recommendation: do not log it for MVP.** Implemented as a true no-op.

The question was whether an inbound HELP belongs in `sms_send_log`, in a new inbound log, or
nowhere. Four reasons it is nowhere:

1. **`sms_send_log` is the wrong table, and 0035 says so.** Every column is send-side —
   `send_type` has no inbound member, `outcome`'s values are send outcomes, and `picks_snapshot` /
   `twilio_sid` / `consent_text_version` all describe a message *we* composed. Writing an inbound
   event there means abusing a `send_type` or adding one, and it weakens the table's stated
   meaning — which is exactly what the CASL argument in that migration's header rests on.
2. **A separate inbound log is real surface for no consumer.** A migration, its RLS, its retention
   rule and its purge job — for a signal PRD §6 lists no metric against. MVP measures growth, CTR
   and churn; HELP volume is in none of them.
3. **Twilio already keeps it.** Every inbound message is in the Twilio console with full history,
   searchable, at zero storage cost to us — and it is the same place the Operator already goes to
   check delivery.
4. **Data minimisation.** §1.2's whole posture is holding the minimum that makes the product work.
   Storing inbound message events we have no use for cuts directly against it.

So HELP does no lookup, no write, and no state change, and returns `no_change` so the route can
tell "handled, nothing to do" apart from "we did not recognise that".

**What would change this:** a V1 metric needing HELP volume correlated with churn. *"How many
people ask for help immediately before they STOP"* is a genuinely interesting question and the one
plausible reason to build the inbound log. That is a product decision with a real cost, and it
belongs in V1 scope rather than being pre-built here.

---

## u. Behaviours worth reviewing

- **`dry_run` displaces only `applied`.** `no_such_subscriber` and `already_in_state` are facts
  about the database that are true whether or not writing is enabled, and a dry run that hid them
  would be useless for the thing a dry run is for. A dry run also reports the **change it would
  have made**, not just that it made none.
- **JOIN is a reactivation.** `stoppedAt: 'clear'`, `reconsent: true`, `confirm: true`, keyed on
  the *found* row's id — so a stopped-inside-retention subscriber revives their existing row
  rather than colliding with the UNIQUE index on `phone_number`.
- **START does NOT set `reconsent`.** It is a carrier resume signal, not a fresh express-consent
  event; re-stamping `consent_timestamp` / `consent_text_version` would record a consent act that
  never happened, in the columns an audit reads.
- **`applyChange` is keyed on `id`, not on the phone number.** The lookup already resolved it, and
  re-matching on the number would be a second place that has to get the purge semantics right.
- **The default seams are inert.** An unwired call reads nothing and finds nothing, so every
  transition lands on `no_such_subscriber` rather than pretending to have acted. Tested.
- **Decision functions cannot see personal data.** `ConsentRow` is `{ id, status, stoppedAt }` —
  no number, no postal code, no birth years — so a decision cannot leak one into a result or a log
  line. A test asserts the result object's key set exactly.

---

## v. Verification

24 new tests, covering all four transitions and every outcome: `applied`, `dry_run`,
`no_such_subscriber`, `already_in_state`, `awaiting_confirmation`, `no_change` and `error` (both
the failed-lookup and failed-write paths). Specifically requested cases all present — JOIN
reactivating a stopped-within-retention row without a second row; JOIN from an unknown number as
`no_such_subscriber` rather than an error; repeat STOP writing **nothing at all**; START after the
purge as `no_such_subscriber` rather than a resurrection; and the dry-run default holding on all
four.

`tsc --noEmit` clean, `eslint` clean. SMS suite **174 tests across 12 files**. Full `unit` lane:
**218 files / 3640 tests passing**. `db` and `invariants` lanes not run — no database here, and no
Postgres has parsed any of the four migrations.

---
---

# Round 6 — the click-through redirect (`/s/[shortId]`)

**Still DRAFT on `feat/kf-sms-pivot-draft`. Nothing applied, nothing pushed, no migration run.**

Closes the loop `shortLinkUrl()` has been minting URLs into since round 4: the link-*minting* half
of PRD §2.3 existed, the *redirect-and-log* half did not.

| file | what it is |
|---|---|
| `lib/sms/click-through.ts` | the decision table + three stubbed reads + the click recorder |
| `app/s/[shortId]/route.ts` | thin transport: resolve, set headers, redirect |
| `tests/sms/click_through.test.ts` | new, 18 tests (resolver + route) |

`npx next build` succeeds with `ƒ /s/[shortId]` in the manifest.

---

## w. Redirect target: **`/activity/[id]`**, and the source settles it

Not a judgement call — the codebase already decided. `app/activity/[id]/page.tsx`'s own header:

> *"CANONICAL activity detail / source page … the product's stable, shareable, SEO-canonical URL
> for a single occurrence"*

and `app/preview/[id]/page.tsx` confirms it from the other side: *"its metadata canonical points AT
`/activity/[id]` so the two never compete for the same content in search."* Both render the same
body from the same loader; only the canonical URL, the share metadata and the back-nav differ.

Sending a text-message link at `/preview/[id]` would put the interim demo shell's URL into
people's browser history and into whatever they forward it to.

---

## x. **The finding: the token cannot satisfy `sms_click_event` on its own.**

`sms_click_event.send_log_id` is `uuid NOT NULL` (migration 0036). The token carries
`(occurrence short_ref, subscriber short_ref)` and **nothing that identifies which send the tap
came from** — so the send row has to be *recovered*:

```sql
SELECT id FROM sms_send_log
 WHERE subscriber_id = $1
   AND send_type = 'weekly'
   AND picks_snapshot @> $2::jsonb        -- [{"occurrence_id": "<uuid>"}]
 ORDER BY created_at DESC
 LIMIT 1
```

**Two alternatives, both rejected:**

- *Widen the token to carry a send-log reference.* It is already 76 bits / 13 characters; a 24-bit
  third field pushes it to ~100 bits ≈ **17 characters** — undoing the shortening the whole design
  exists for, on every link in every message, to serve a lookup that only happens on the small
  fraction of links actually tapped.
- *Make `send_log_id` nullable.* That column is what ties a click to the message that caused it.
  Nullable, it stops being able to answer "which send produced this click" — the only question CTR
  asks.

**No new index is needed, and I checked rather than assumed.** This looks like it wants a GIN index
on `picks_snapshot`; it does not, because the query is **subscriber-scoped**.
`idx_sms_send_log_subscriber (subscriber_id, created_at DESC)` already exists (0035), one
subscriber accumulates ~52 weekly rows a year, and the containment test runs over a few dozen rows
rather than the table. `ORDER BY created_at DESC` because a recurring activity legitimately appears
in several sends — the most recent is the one in their phone.

---

## y. Open question: **there is no "this activity is no longer listed" experience.**

I checked before choosing, as asked. **There is nothing to reuse:** `/activity/[id]` and
`/preview/[id]` both call `notFound()` for a missing id, and there is **no `app/not-found.tsx`
anywhere in the tree** — so a missing activity currently gets Next's bare default 404.

So both failure modes go to **`/search`** for now. That is defensible (it is the honest "here is
what *is* on" destination) but it is not *good*: a parent who taps "Sat: Story Time (VPL Renfrew)"
for a since-cancelled session lands on a generic search page with no explanation, and concludes the
product is broken. That is precisely the silent-substitution pattern /search's own coverage notice
exists to end.

**I did not invent a page**, because the copy is a product decision and PRD §2.7 is explicitly
wary of new page types. But the two reasons are kept as **separate `ClickOutcome` values** even
though they resolve to the same path today, so giving `occurrence_gone` its own destination is a
one-line change in `click-through.ts` and needs no change in the route.

**Recommendation:** a small honest interstitial before real messages go out. It only bites once
links are in the wild, so it is not urgent — but it is the first thing a real subscriber will hit
when a session is cancelled, and that will happen in week one.

---

## z. Decisions, each with its reason

- **307, and explicitly never 301/308.** A *permanent* redirect is cached by the browser and every
  intermediary, so the **second** tap on a link would never reach this route — it would go straight
  to the cached target and vanish from `sms_click_event`. Repeat taps are exactly the engagement
  signal that table exists to measure. A permanent redirect would also be a lie: the mapping is
  per-subscriber and the target can be archived tomorrow. 307 over 302 only because it is
  unambiguous about being temporary; the route is GET-only so method preservation is moot.
- **`cache-control: no-store` set explicitly.** Even a 307 can be cached when a downstream cache
  decides to. This is the one header protecting the click data, so it is stated rather than assumed.
- **`referrer-policy: no-referrer`.** A parent tapping through to a rec centre's booking page
  should not hand that site a Referer identifying which KIDS FUN link they came from.
- **Redirect on the REQUEST's origin, not `NEXT_PUBLIC_SITE_URL`.** This route is reached from a
  text message and may be hit on a preview or staging host; bouncing a parent to the production
  domain mid-tap would be surprising and would lose the click.
- **Malformed and tampered tokens are indistinguishable.** `decodeShortLink` already refuses to
  tell them apart; an endpoint that answered differently would confirm to a prober when they were
  one character away, turning a 20-bit check into a guided search. Asserted by a test comparing the
  two resolutions for deep equality.
- **No feature flag**, unlike signup and inbound. The token *is* the authorization, and a token
  that has never been minted cannot be guessed. What it needs instead is to be unable to do
  anything worse than redirect to `/search` — which is what `resolveClickThrough` never throwing
  guarantees.
- **The redirect never depends on the logging.** Four ways a genuine tap goes uncounted, all
  normal: the activity was archived (schema-mandatory — see below), the subscriber row was deleted
  by the 90-day purge, no matching send log (a dry-run send writes none), or the insert failed.
  All four still redirect; `clickLogged: false` reports it honestly.
- **`findSubscriberIdByShortRef` has no `phone_number IS NOT NULL` clause**, unlike the weekly
  job's loader — deliberately. `short_ref` and `id` survive the 30-day purge, so a purged
  subscriber's old links still attribute correctly. The click is a fact about a message we sent,
  and it stays countable after their data goes.

---

## aa. A CTR consequence worth knowing before the metric is read

**A tap on a since-archived activity can never be logged** — `sms_click_event.occurrence_id` is
`NOT NULL` and FK-constrained to a live `activity_occurrence` row, so there is literally no row to
write. That is a schema fact, not a policy choice.

It is arguably correct (a tap that reached no content is not a click-*through*), but it means CTR
is measured against links that still resolve, **so a week with heavy archiving will read low**.
Recorded here so the number is not misread later.

---

## ab. One risk I could not close: link prefetching

Some messaging clients and carrier gateways **prefetch** URLs to render previews. Any such fetch
hits this route and would be counted as a tap, inflating CTR — and unlike a web link there is no
`Referer` or session to distinguish it by. User-agent sniffing is unreliable enough that building
it would give false confidence rather than protection.

Not mitigated, and flagged rather than papered over. It is measurable once real sends start: a
click logged within a second or two of the send timestamp, for many subscribers at once, is a
prefetch signature rather than a human. `sms_click_event.created_at` and `sms_send_log.created_at`
are both there, so the check needs no new schema.

---

## ac. Verification

18 new tests: the canonical redirect and exact click-event shape; repeat taps logged as two;
subscriber attribution taken from the token; ten unverifiable-token cases (tampered, wrong length,
outside base62, empty, null, path traversal, SQL-ish) all failing closed with no lookup attempted;
malformed and tampered asserted deep-equal; `occurrence_gone` distinct from `invalid_token`; all
four uncountable paths still redirecting; the resolver's exact key set with no subscriber id, send
log id or short_ref in it; and at the route layer — 307, `no-store`, `no-referrer`, never
301/308, hostile path segments neither erroring nor echoed, and the request-origin redirect.

`tsc --noEmit` clean, `eslint` clean, **`npx next build` succeeds** with `ƒ /s/[shortId]` in the
manifest. SMS suite **192 tests across 13 files**. Full `unit` lane: **219 files / 3658 tests
passing**. `db` and `invariants` lanes not run — no database here, and no Postgres has parsed any
of the four migrations.

---
---

# Round 7 — the novelty filter, and Jon's registration ruling

**Still DRAFT on `feat/kf-sms-pivot-draft`. Nothing applied, nothing pushed, no migration run.**
**No file outside `lib/sms/**`, `app/api/sms/**`, `tests/sms/**` and the docs was modified.**

| file | change |
|---|---|
| `lib/sms/registration.ts` | **NEW** — the multi-session vs one-off distinction |
| `lib/sms/weekly-picks.ts` | `excludeOccurrenceIds` input, novelty filter, registration gate |
| `lib/sms/weekly-send.ts` | threads `excludeOccurrenceIds` |
| `lib/sms/weekly-send-io.ts` | `loadRecentlySentPickIds` stub + `NOVELTY_LOOKBACK_SENDS` |
| `app/api/sms/weekly/run/route.ts` | `novelExcluded` added to the PII allowlist |
| `tests/sms/registration.test.ts` | **NEW**, 11 tests |
| `tests/sms/weekly_picks.test.ts` | +7 (novelty) +1 (registration behaviour change) |
| `tests/sms/weekly_send.test.ts` | +3 (novelty through the builder) |

---

## ad. The novelty filter

`excludeOccurrenceIds?: ReadonlySet<string>` on `WeeklyPicksInput`, applied **after dedup, before
the age-coverage swap**, exactly as §2.2 step 4 specifies. Neither part of that ordering is
arbitrary:

- **After dedup** — a repeat and its duplicate collapse first, so the exclusion removes *one*
  candidate rather than two, and `novelExcluded` reports one. Pinned by a test.
- **Before the coverage swap** — the swap both *selects from* and *reaches into* the candidate
  list, so filtering afterwards would let an already-sent occurrence back in through the
  forced-pick path. Pinned by a test that shows the same listing being forced in without the
  exclusion and the band going unrepresented with it.

**Not relaxed by either degradation step, structurally.** The exclusion lives on the input and
`selectFrom` applies it unconditionally — there is no branch a retry could take that skips it.
Tested against both: step (a) widening radius/window, and step (b) dropping interests. In the
step-(b) test, `degradation` is asserted to be `widened_and_interests_dropped` — i.e. (b) genuinely
fired — and the week is *still* empty, because novelty survived it.

`novelExcluded` is reported all the way to the run route, because it is the number that
distinguishes *"this municipality is thin"* from *"we have already sent them everything it has"* —
two very different problems producing the same empty week.

### The window: **`NOVELTY_LOOKBACK_SENDS = 1`**, and why not more

**Sends, not weeks.** A subscriber who had an empty week has no weekly send from last calendar
week at all, so a time-based window would look back at nothing and re-serve the picks from a
fortnight ago. Counting *sends* looks back at the last thing they actually received, whenever that
was.

**Why the PRD's floor rather than something larger.** A longer window is the obvious instinct and
it interacts badly with the thing §2.1 already worries about: in a sparse municipality the whole
eligible set is a handful of activities, so excluding four weeks of picks can push a subscriber
under the floor of 3 *every* week — and three empty weeks in a row **auto-pauses them** (§2.2 step
7). Novelty is a nice-to-have; being auto-paused is losing the subscriber. Starting at 1 cannot
cause that.

> **Tuning question, flagged not guessed:** raising this is one constant, and it is worth raising
> for the dense municipalities once there is real per-municipality data. It should probably not be
> a single global number — the right window in Vancouver and the right window in Burnaby are
> unlikely to be the same.

---

## ae. Jon's registration ruling — **built SMS-scoped, no shared-infra change.** Follow-up flagged.

### The insight: the shared classifier's vocabulary already contains both ideas, mixed

`lib/search/filters/registration.ts`'s `REGISTRATION_TITLE` is one alternation, but its terms
answer **two different questions**:

| | terms | Jon's ruling |
|---|---|---|
| **How long is it?** | camp, lesson, course, class, workshop, clinic, academy, series, "intro to", "learn to", "Level/Stage/Star N", "Session N", "Week N", certificate, + `PROGRAM_LEVEL` | **exclude** |
| **How do you get in?** | "Reserve In Advance:", registration, register, registered | **keep** |

Jon's line falls exactly along that seam. The distinction needs **no new data** — only a way to ask
which half fired.

### How it asks, without copying the vocabulary

Restating the commitment half in the SMS lane would be a second copy of a fifteen-term alternation
audited against 9,988 live rows, free to drift. So `isMultiSessionCommitment` **re-runs the shared
classifier on the title with the booking-mechanism wording removed**:

- still registration-shaped without them → a **commitment** fired → exclude
- no longer registration-shaped → only the **booking mechanism** fired → keep

Two properties a copied list would not have:

1. Only **four** patterns live in `lib/sms/` — the booking-mechanism ones — instead of fifteen.
2. A term added to `REGISTRATION_TITLE` later is **automatically treated as a commitment**, i.e. it
   keeps being excluded. That is the safe direction: a new multi-session word slipping into a text
   is noise; a drop-in wrongly excluded is a thinner week.

`buildPicksRequest` now sets `includeRegistration: true` and the gate runs in `selectFrom`. That
switch is documented as an inclusion widener that "can only ever ADD results", so this is strictly
a **narrowing** of what arrives — net effect: the engine's exclusion *minus* the one-offs. A test
asserts the SMS exclusion set is a strict subset of the site's, so the text can never hide
drop-in content the website shows.

### The behaviour change, in real titles

| title (from the shared filter's own fixtures) | before | after |
|---|---|---|
| `Reserve In Advance: Table Tennis All Ages` | excluded | **included** |
| `Reserve In Advance: Badminton (8-17yrs)` | excluded | **included** |
| `Reserve In Advance: Squash Court #1` | excluded | **included** |
| a registration-**flagged** one-off library event | excluded | **included** |
| `Reserve in Advance: Figure Skating (Level Star 2 +)` | excluded | excluded |
| `Frozen Ballet Dance Camp 3-5yrs` | excluded | excluded |
| `My First Dance Class: 2-4yrs` | excluded | excluded |

**The flagged-one-off row is the biggest change.** `registrationRequired === true` is the strongest
signal the shared classifier has and it outranks even the drop-in veto — correctly, because it
answers *"must you book?"*. That is not the question Jon asked. A BiblioCommons event whose
`registrationInfo` says you must log in to register is very often a single Saturday session. So the
re-run neutralises the flag along with the words, and duration is judged on what the title says.

### >>> THE FOLLOW-UP THIS DOES NOT PRE-EMPT — needs a decision, not taken here <<<

**This is a TITLE-LEVEL APPROXIMATION of a DATA question and should be read as one.** The real
signal is `activity_series.recurrence_rule` (migration 0004: *"RRULE-style string; null for
one-off/open-hours series"*) — a structural "is this a single occurrence" fact no vocabulary can
match for reliability.

**I did not wire it, and I am not asking to without a ruling.** The specific change it would need:

| | |
|---|---|
| **File 1** | `lib/search/types.ts` — add to `ListingRecord`, e.g. `recurring: boolean` (or `recurrenceRule: string \| null`) |
| **File 2** | `lib/search/postgres-repository.ts` — select `ser.recurrence_rule` (the query already joins `activity_series ser` for `ser.canonical_title`, so this is a column added to an existing join, not a new one), add it to the `GROUP BY`, and map it in `rowToListing` |
| **File 3** | `lib/search/__fixtures__/factory.ts` — a default, so every existing fixture still compiles |
| **Blast radius** | `ListingRecord` is the read-model contract for the whole search stack. Adding a field is additive and low-risk, but it is **shared search infrastructure this branch has deliberately never touched**, and it would want its own review rather than riding in on an SMS change. |

**My recommendation:** ship the vocabulary approximation now (it implements Jon's ruling correctly
on every title in the shared filter's own audited fixture set), and treat the `recurrence_rule`
wiring as a separate, small, independently-reviewable change — ideally alongside §3 item 12's
series-dedup work, which the PRD itself notes is where this signal naturally belongs.

**Known limits of the approximation, stated plainly:**

- A multi-week course whose title says nothing — the PRD's own examples, *"Sportball Multisport
  (3-5 yrs)"*, *"Indoor T-Ball (3-5 yrs)"* — is invisible to both the shared classifier and this.
  It was already getting through before this change; this does not make it worse.
- `workshop` and `clinic` are treated as commitments, and both are *often* one-off. That is the
  conservative call — it preserves today's exclusion rather than widening it — but they are the two
  terms most likely to be worth moving once `recurrence_rule` exists.

---

## af. Verification

`tsc --noEmit` clean, `eslint` clean, `npx next build` succeeds. SMS suite **214 tests across 14
files**. Full `unit` lane: **220 files / 3679 tests passing**. `db` and `invariants` lanes not run
— no database here, and no Postgres has parsed any of the four migrations.

One existing test changed meaning rather than behaviour and says so in its own comment: round 3's
"multi-week courses stay out" passed because the engine's `includeRegistration` defaulted to false;
it now passes because `lib/sms/registration.ts` decides. Same assertion, different — and now
correct — reason.

---
---

# Round 8 — the preferences / hub page (`/u/[preferencesToken]`)

**Still DRAFT on `feat/kf-sms-pivot-draft`. Nothing applied, nothing pushed, no migration run.**

| file | what it is |
|---|---|
| `lib/sms/preferences.ts` | **NEW** — decisions + three stubbed seams |
| `lib/sms/signup-validate.ts` | `parseProfileFields` **extracted** so both surfaces share one copy |
| `lib/sms/consent-copy.ts` | preferences copy, sharing the signup form's gap markers |
| `app/u/[preferencesToken]/page.tsx` | **NEW** server component |
| `app/u/[preferencesToken]/_components/PreferencesForm.tsx` | **NEW** |
| `app/u/[preferencesToken]/preferences.css` | **NEW** |
| `app/api/sms/preferences/route.ts` | **NEW** — POST-only mutations |
| `tests/sms/preferences.test.ts` | **NEW**, 26 tests |

`npx next build` succeeds with `ƒ /u/[preferencesToken]` and `ƒ /api/sms/preferences` in the
manifest.

---

## ag. Point 7 — what "renders PII **and** mutates state" actually changes

`/s/[shortId]` reads a token, resolves a public catalogue row, redirects. It reveals nothing and
changes nothing. This page does **both** of the things that one does not, and six decisions follow:

1. **The token is in the URL — the weakest place to keep a credential.** It goes into browser
   history, `Referer` headers, server and proxy logs, screenshots, and whatever gets forwarded.
   Most of that is *inherent* to a no-login link in a text and CASL positively wants the
   unsubscribe that frictionless. What can be stopped is us making it worse:
   - **`noindex, nofollow` — the most important header on this page.** If a token URL ever reaches
     a crawler, an indexed copy would put a child's ages and a household postal code into a search
     engine. There is no undoing that. This is the difference between a *leaked* link and a
     *published* one.
   - **`no-referrer`** — every outbound link (an activity's booking page) would otherwise hand
     that third party the full URL, **token included**. This one header is what stops a rec
     centre's analytics from receiving a working credential for somebody's subscription.
   - **`no-store`** — the rendered HTML holds those values; the back button on a family computer
     should not resurrect them.
2. **The lookup is exact-match on a unique column**, so a wrong-but-well-formed token resolves to
   *nothing*, never to a neighbouring row. A property of the query, not of care.
3. **One failure outcome for every reason** — never existed, purged, malformed. No "that looked
   close", and the shape gate runs before the database so there is no distinguishable branch.
4. **Mutations are POST-only, in their own route.** This URL is exactly what a messaging client
   *prefetches* to render a preview — round 6's CTR risk. Any state change hanging off the GET
   would mean preview fetches unsubscribing people.
5. **Transitions are guarded by current state, not just by holding the token** — see §aj.
6. **The phone number is never read, rendered or returned.** It is the one field a leaked link
   would turn into a contactable identity, and the page has no use for it. A test asserts the
   view's exact key set.

**CSRF, honestly:** classic CSRF does not apply — there is no cookie or session to ride. The
credential *is* the token, and anyone who has it already has everything. The threat is **leakage**,
not forgery, which is why the effort goes into the three headers rather than into a CSRF token. The
token travels in the POST **body**, not the URL, because a POST path lands in access logs exactly
like a GET path and this is the one request that need not put it there.

### >>> What I am NOT confident about <<<

**There is no rate limiting, and this branch has no infrastructure to add any.** With a
256-bit token, brute force is not a real threat — but the honest statement is that nothing stops
an attacker making unlimited attempts, and I have not measured whether the platform provides
anything upstream. **This should be checked before real links are in the wild**, and it is the one
item in this round I would not want signed off silently.

Two smaller ones: I have assumed `preferences_token` is minted at **full** HMAC-SHA256 width (the
signup-store TODO says so) — it must **not** be truncated the way the short-link token deliberately
is; a short link's 20-bit check protects public catalogue data, this token protects a child's age.
And rotating a leaked token is supported by the schema (it is a stored, regenerable column) but no
UI offers it.

---

## ah. Point 4 — is the web unsubscribe the same transition as a STOP text?

**Same destination, different journey. So: shared decision, separate entry point.**

It **reuses `decideStop`** — the identical pure decision the carrier mirror uses — because the
target state is identical in every column: `status = 'stopped'`, `stopped_at` stamped once and
never re-stamped, the 30-day purge clock started. Forking that would mean two places that both have
to remember not to re-stamp `stopped_at`, and one would eventually forget.

But it is a **separate entry point** rather than a call to `mirrorCarrierStop`, because that
function's own contract is not true here. Its documentation says, correctly: *"Twilio has ALREADY
suppressed the number by the time this runs… This write is not what stops the messages."* On a web
unsubscribe **nothing has suppressed anything, and our write is the entire mechanism** — the Friday
job's `WHERE status = 'active'` is what stops the texts. Reading that comment on this path would be
actively misleading.

**Two consequences worth knowing:**

- **Twilio will not know.** A carrier STOP puts the number on Twilio's suppression list — a second,
  independent barrier that survives a buggy send job. A web unsubscribe has no such backstop: our
  `status` column is the only thing between that person and next Friday. Propagating the opt-out to
  Twilio's list would restore the belt-and-braces, and it is a real API call this branch cannot
  make. **Worth doing before launch.**
- **The database cannot say which path was used.** `sms_consent` records how someone *joined*
  (`consent_method`) but not how they *left*. After the fact a web unsubscribe and a STOP text are
  indistinguishable. Fine for operating the product; a genuine hole for a complaint investigation
  (*"they say they never texted STOP"* — correct, they clicked). Adding a column is a migration and
  not mine to decide.

---

## ai. "Delete my data" — a reading of §1.3's intent over its letter. **Needs confirming.**

§1.3 puts profile purging at *"30 days later"* on `stopped`, *"via STOP **or explicit delete
request**"*, justifying the grace window as protection *"in case of accidental unsubscribe"*. Read
literally, pressing "Delete my data" would stop the texts and then keep the data for a month.

**That reasoning does not transfer.** The grace window guards against an **accident**, and an
explicit, confirmed delete request is the one case that is definitionally not accidental. Holding a
child's age for thirty days after their parent deliberately asked us to erase it — for our own
complaint-resolution convenience — is the weaker position under PIPEDA and the harder one to
explain.

**So the accident risk moves to where it belongs:** a two-step confirmation in the UI, and the
deletion is immediate. That is a *stronger* guard than a timer, because it stops the mistake
instead of giving you a month to notice it.

**Nothing is lost.** The row survives with its id, `short_ref`, consent timestamps and
`consent_text_version`; `sms_send_log` keeps `phone_hash` + `phone_hash_version` and was designed in
round 1 precisely so the CASL audit trail outlives the subscriber's personal data. The
complaint-resolution capability the grace window protected is already protected by that.

> Reverting to the literal 30-day behaviour is **one line**: emit an `unsubscribe` change instead of
> a `delete` one and let the purge job do it. The two-step confirmation in the UI is load-bearing
> for this argument — deleting it would quietly invalidate the reasoning.

---

## aj. Saving un-pauses — but must never resurrect

§2.4: *"Saving resets the empty-week counter and un-pauses if paused."* That is the only way a
paused subscriber resumes without signing up again, so it has to work. But "un-pause on save" must
not generalise into "any save reactivates":

| current status | on save |
|---|---|
| `active` | fields updated, counter → 0 |
| `paused` | fields updated, counter → 0, **status → active** |
| `pending` | fields updated, counter → 0, **status untouched** — activating here would bypass the double opt-in, exactly as START-on-a-pending-row would (round 5's `awaiting_confirmation` finding) |
| `stopped` | **`not_permitted`, nothing written** — they withdrew consent, and silently resurrecting them because they opened an old link and hit Save is the CASL violation this design exists to avoid |

The counter reset is unconditional for any row that may be saved: someone who just told us where
they live and how old their kids are has given us new reason to look, and holding three old strikes
against them would pause them on a stale judgement.

`not_permitted` and `not_found` both return **404** from the route — telling an unrecognised caller
*"that token is real, it just belongs to someone who unsubscribed"* is a fact about another person.

---

## ak. Two smaller things

**One validator, three callers.** `parseProfileFields` was extracted from `parseSmsSignupBody` —
the postal code, ages and interests are the same three fields under the same rules at signup
(§2.1) and on edit (§2.4). A rule enforced at signup and not on edit is a rule that does not
exist; *"V5L 1A1 was fine when I signed up but is rejected when I change it"* is exactly what a
second implementation produces. The signup form, this page's client and the API route all run the
same function. A move, not a rewrite — the signup suite passed unchanged.

**The unknown-token page is a rendered notice, not `notFound()`** — the one place this branch
deviates from the click-through route's posture, deliberately. That route redirects an unresolvable
tap to `/search`, which is a fine answer for *"go find something to do"*. This link's whole purpose
is to reach the unsubscribe and delete controls, so a bare 404 would leave someone trying to opt out
with nowhere to go. **This is not a fix for the missing not-found experience round 6 flagged** —
that gap is now §8 Q3 and Jon's/the Operator's, and this does not pre-empt it.

---

## al. Verification

26 new tests. The isolation suite is the one to read: two subscribers in the store, five
near-miss token shapes each resolving to nobody, all three actions on a wrong token writing
nothing, and a body claiming another subscriber's id proven inert (the change is built from the
resolved row, so there is nothing to influence).

`tsc --noEmit` clean, `eslint` clean, **`npx next build` succeeds** with both new routes in the
manifest. SMS suite **240 tests across 15 files**. Full `unit` lane: **221 files / 3705 tests
passing**. `db` and `invariants` lanes not run — no database here, and no Postgres has parsed any
of the four migrations.

---
---

# Round 9 — the real CASL footer, and the "activity gone" interstitial

**Still DRAFT on `feat/kf-sms-pivot-draft`. Nothing applied, nothing pushed, no migration run.**

| file | change |
|---|---|
| `lib/sms/consent-copy.ts` | `MISSING_SENDER_IDENTITY` → real `SENDER_IDENTITY`; support number; gone copy; **version bumped to `2026-08-26.v2`** |
| `app/sms/signup/page.tsx` | draft banner → real CASL footer |
| `app/u/[preferencesToken]/page.tsx` | same |
| `app/sms/signup/signup.css`, `.../preferences.css` | identity block styles; dead draft-banner CSS removed |
| `app/activity-unavailable/page.tsx` + `.css` | **NEW** — the interstitial |
| `lib/sms/click-through.ts` | `GONE_DESTINATION`; `occurrence_gone` now routes there |
| `tests/sms/signup_copy.test.ts` | +3 (identity, support number, verbatim gone copy) |
| `tests/sms/click_through.test.tsx` | updated for the split; +4 interstitial render tests |

The support number is written down **exactly once** (`SUPPORT_PHONE_E164`); the display form, the
`tel:` href, the identity block and the interstitial all derive from it. A test asserts the display
form's digits equal the E.164 form, so the two can never drift.

---

## am. The Twilio TFV check — **I DID have web access, and I did the check.** Findings below.

**Answer to the direct question: yes, this environment has live web access.** I verified it rather
than assuming — the fetches returned real content. What I could and could not reach:

| source | reachable? |
|---|---|
| `twilio.com/docs/messaging/compliance/toll-free/api-onboarding` | ✅ full field list |
| `twilio.com/docs/api/errors/30475` | ✅ full rejection reason |
| `twilio.com/docs/messaging/compliance/toll-free/console-onboarding` | ✅ but defers to the Help Center |
| `support.twilio.com/.../Required-Information-for-Toll-Free-Verification` | ❌ **HTTP 403** |
| `help.twilio.com/articles/...Toll-Free-Message-Verification` | ❌ JS-rendered, empty body |
| CTIA Messaging Principles (via search) | ✅ summarised |

**So the single authoritative "required information" article is NOT reachable from here.** Anything
below that comes from the API docs or the error docs is Twilio's own text; the consumer-facing
disclosure requirements are from CTIA, which is the standard the carriers enforce, not from
Twilio's own enumeration. That distinction matters and I am not going to blur it.

### ✅ My round-3 addition is CONFIRMED, not just plausible

I flagged in my own comment that the carrier disclosures I added should be checked rather than
trusted. CTIA's Messaging Principles require the opt-in call-to-action to display: **program name,
message frequency, "message and data rates may apply", STOP opt-out information, and terms (or a
link to them)**. Our form carries all five. That claim is now sourced rather than asserted.

### 🔴 Five things the Operator needs, that I did not know before checking

1. **`BusinessRegistrationNumber` is "required for all business types EXCEPT `SOLE_PROPRIETOR`."**
   Jon is a sole proprietor, so the CRA BN is **optional** on the submission. Including it does no
   harm and I have put it in the CASL footer anyway — but nobody should hold up a filing over it.
2. **`NotificationEmail` is a REQUIRED submission field**, and **`BusinessWebsite` is too.** This
   does *not* conflict with "support contact is SMS-only" — they are different things (one is where
   Twilio sends the verification RESULT, the other is what consumers see) — but **the Operator
   needs an email address to file at all.** Worth knowing before opening the form.
3. **Error 30475 — "Cannot combine messaging consent with service requirement"** is a real, named
   rejection. Its listed causes include *"phone number collection combined with consent in a single
   action"* and *"pre-selected checkboxes"*. **We are structurally fine** — the website is fully
   usable without subscribing, and our checkbox is unchecked-by-default and separately bordered
   (tested). But a reviewer applies this mechanically to a screenshot, so **the `UseCaseSummary`
   should explicitly state that kidsfun.ca is fully usable without opting in to texts.** That is a
   sentence in the submission, not a code change.
4. **CTIA requires the privacy policy to state that "mobile information is not shared or sold to
   third parties."** Our consent checkbox says it; **`/privacy` does not have an SMS section at
   all.** PRD §1.3 already calls for a privacy-policy changelog entry — this is the specific
   sentence it needs. `/privacy` is a signed-off document outside this branch's footprint, so this
   is **flagged, not edited**.
5. **CTIA requires HELP to return support contact information.** Ours is handled by Twilio's
   Advanced Opt-Out with a console-configured help text — so **that configured text must now be set
   to include +1 877-835-7776**, which was impossible before this round because the contact did not
   exist. A console setting, not code.

### One thing I checked and it is fine

The confirmation SMS (§2.6) must, per CTIA, repeat program name / frequency / opt-out / customer
care. Ours carries *"KIDS FUN"*, *"weekly"*, and *"Reply STOP"*. Customer care is the number they
are already texting, which is the one case where it is self-evident — and HELP covers it formally
(see 5 above).

---

## an. `occurrence_gone` vs `invalid_token` — **yes, this creates an oracle. Reasoned, not assumed.**

You asked me to think this through rather than wave it off, and the honest answer is not "no".

**What round 6 actually protected, and still does.** The concern was distinguishing **malformed**
from **checksum-failed** — telling a prober they were one character away and turning a 20-bit check
into a guided search. **That is unchanged.** `decodeShortLink` returns null for both, both are
`invalid_token`, both land on `/search`. There is still no warmer/colder signal *inside the space of
failing tokens*, and a test asserts the two resolutions are deep-equal.

**What is newly visible.** A prober can now tell *"my token PASSED the HMAC but named no live
activity"* from *"it did not pass"*. That is a **validity oracle that did not exist before**, and
it is a real change rather than a technicality.

**Why it is acceptable — three reasons, on the record:**

1. **It does not compound.** The check is an HMAC over each payload independently, so learning that
   one forged token verified reveals nothing about the secret and makes the next forgery no
   cheaper. The oracle answers one question, once, per attempt — it does not narrow the search
   space the way a "you were close" signal would.
2. **The attempt rate is the real bound, and it is unchanged.** ~1 in 2²⁰ random tokens verify, and
   this only tells them which ones did — something they could already infer from a successful
   redirect whenever the decoded `short_ref` happened to be live.
3. **The prize is small.** A verified forgery reaches public catalogue data (or this page) and can
   write one bogus `sms_click_event`. It cannot read a subscriber, mutate anything, or reach the
   preferences page — that is a different token entirely, with 256 bits and no shared secret.

**What the alternatives cost**, since "keep them identical" was on the table:

- *Send both to the interstitial.* A parent whose link was mangled by their messaging app would be
  told an activity had been **cancelled when nothing had** — inventing a fact to protect a 20-bit
  check. This project does not make that trade.
- *Send both to `/search`* — round 6's status quo, which is exactly what Jon's ruling changed.

So the oracle is **accepted deliberately** and named in `GONE_DESTINATION`'s own comment so nobody
has to rediscover it.

**One related cost I want on the record:** a failed occurrence *read* (database outage) also takes
the `occurrence_gone` branch, so an outage tells a handful of parents an activity was cancelled when
it was not. The alternative is a bare error page — worse for them, and no more truthful about what
happened. Named in the code and here rather than left to be discovered.

---

## ao. Verification

`tsc --noEmit` clean, `eslint` clean, **`npx next build` succeeds** with `○ /activity-unavailable`
in the manifest (statically rendered — it has no state and no identifiers). SMS suite **247 tests
across 15 files**. Full `unit` lane: **221 files / 3713 tests passing**. `db` and `invariants` lanes
not run — no database here, and no Postgres has parsed any of the four migrations.

The version-bump discipline worked as designed: changing this copy broke the copy test, which is
what that test is for. `CONSENT_TEXT_VERSION` is now `2026-08-26.v2` and the assertions were updated
to the new facts rather than relaxed.

---
---

# Round 11 — the welcome text (PRD §2.1 / §2.6)

**Still DRAFT on `feat/kf-sms-pivot-draft`. Nothing applied, nothing pushed, no migration run.**

PRD §2.1 is one sentence with two halves: *"JOIN reply (tolerant match) → status = active,
confirmed_timestamp set → same send path immediately fires one static welcome text."* Round 5 built
the first half. This is the second.

| file | change |
|---|---|
| `lib/sms/welcome.ts` | **NEW** — the welcome-send step |
| `lib/sms/message.ts` | `renderWelcomeMessage`; **extension-table correction** (see §ap) |
| `lib/sms/signup-validate.ts` | `agesFromBirthYears` — the inverse of `birthYearFromAge`, moved beside it |
| `lib/sms/preferences.ts` | `childAgesFrom` delegates rather than keeping a second implementation |
| `app/api/sms/inbound/route.ts` | `confirmAndWelcome` — the JOIN branch |
| `tests/sms/welcome.test.ts` | **NEW**, 17 tests |
| `tests/sms/weekly_send.test.ts` | the welcome added to the all-templates GSM-7 wall |

---

## ap. A correction to this branch's own GSM-7 implementation

**Implementing §2.6's approved welcome copy broke the guard — for a reason that was not true.**

The copy contains *"land Friday ~4pm"*. Round 4's `GSM7_BASIC` deliberately excluded the GSM 03.38
**extension table** (`^ { } \ [ ~ ] | €`) with the comment: *"they are encodable, but each one
costs TWO characters of the budget, which makes them a trap rather than a saving."*

The reasoning about cost was right. **Leaving them out of the set was not**, because it made
`isGsm7` conflate two different things — *"not in the basic table"* and *"forces UCS-2"*. A message
containing `~` is **GSM-7 with one double-width character**, not a UCS-2 message. The old code
reported it as UCS-2 at 70 characters per segment, and `assertGsm7Safe` would have rejected Jon's
own approved wording.

Fixed properly rather than by editing the copy: a `GSM7_EXTENDED_SET`, a `septetCost` helper, and
`estimateSegments` now measuring **septets** rather than characters — which is the unit the segment
budget is actually in.

**The round-4 finding is unaffected and still stands.** An em dash is in *neither* table, so UCS-2
was and is the correct verdict for it, and the 3-segments-vs-1 measurement is untouched. Only these
nine characters were misclassified. A test pins both facts side by side.

---

## aq. Where the dispatch belongs — **not inside `confirmSubscriber`**, and not merely for symmetry

The lean was to keep the transition decision-only and let the route trigger the send. That is what
was built, but the reason is stronger than consistency:

`confirmSubscriber` decides against **`ConsentRow`**, which is `{ id, status, stoppedAt }`, and
whose own doc says why:

> *Deliberately the minimum: no phone number, no postal code, no birth years. A decision function
> that cannot see personal data cannot leak it into a result object or a log line.*

The welcome text needs **a phone number** (to send to), **a postal code** (to name the area),
**birth years** (to name the ages) and **a preferences token** (for the link). **Every one of those
is a field `ConsentRow` deliberately excludes.** Putting the send inside the transition would mean
widening that type with exactly the four things it was defined to keep out, and round 5's property
— that a consent *decision* cannot leak personal data — would be gone.

So the decision layer stays PII-free and `sendWelcomeText` does its own read, keyed on the `id` the
transition already resolved.

**The guard is a positive test on `applied`**, not a list of exclusions, so a future outcome is
silent by default rather than accidentally triggering a text. What each other outcome means:

| outcome | why it must send nothing |
|---|---|
| `already_in_state` | they were **already active** — a repeat JOIN is normal (a parent replying twice, a carrier redelivering) and re-welcoming them is the duplicate-message failure this ordering prevents |
| `awaiting_confirmation` | not reachable from JOIN today (it is START's pending case), but covered by the positive guard anyway |
| `no_such_subscriber` | there is nobody to welcome |
| `dry_run` | nothing was written, so nothing should be announced |
| `error` | the transition failed; a welcome would announce something that did not happen |

**The welcome never changes what the webhook returns.** `sendWelcomeText` does not throw and its
result is deliberately discarded: the subscription is already active, which is the part that
matters, and a non-2xx would make Twilio **retry the whole inbound message and replay the
transition**. One lost welcome beats one duplicated confirmation.

---

## ar. Reuse rather than second implementations

- **The area label** comes from `areaLabelForPostal` (lib/geo/postal-fsa) — the same resolver the
  weekly send uses, so the area named in the welcome is the area the picker will actually search.
- **The ages** come from `agesFromBirthYears`, which this round **moved beside its own inverse**
  (`birthYearFromAge`) in `signup-validate.ts`. It previously lived in `preferences.ts` and read the
  local year through `Intl` directly while its inverse used `localIsoDate` — *two ways of asking
  what year it is in Vancouver, which is one more than is safe on December 31st.* Both now go
  through `localIsoDate`. `childAgesFrom` is kept as a delegating export so its existing callers are
  unchanged.
- **The dispatch and the send-log write** are `dispatchSms` and `recordSmsSend` from
  `weekly-send-io.ts` — one Twilio call site, one `sms_send_log` writer, one place that knows the
  columns. `SendLogType` already listed `'welcome'`; this is its first caller.

**Two small deliberate choices inside the loader**, both in its doc comment: it is keyed on `id`
rather than the phone number (the transition already resolved it, and re-matching would be a second
place that has to get 0034's purge semantics right), and it has **no `status = 'active'` clause** —
re-asserting a status that was just set introduces a race with nothing to gain.

**The copy degrades in two independent directions.** An unresolvable postal code drops the area
clause; an empty age list drops the ages clause. Neither prints a placeholder — *"for null, ages"*
would be a worse first impression than a shorter sentence. Both are tested.

---

## as. Verification

17 new tests. The copy matches §2.6's shape exactly; the welcome passes the same
`assertGsm7Safe` wall as every other template **and has been added to the all-templates wall test**
so it is not exempt; the `~`-is-two-septets correction is pinned alongside the em-dash-is-UCS-2 fact;
exactly one dispatch and one `sms_send_log` row with `send_type = 'welcome'` and
`picks_snapshot: null`; dry-run by default writes nothing; missing subscriber, Twilio failure and a
21610 carrier opt-out each map to the right log outcome; nothing throws and no error string carries
the number; and the JOIN guard sends for `applied` and for **no** other outcome.

`tsc --noEmit` clean, `eslint` clean, `npx next build` succeeds. SMS suite **264 tests across 16
files**. Full `unit` lane: **222 files / 3730 tests passing**.

---

# Round 12 — the confirmation request (PRD §1.4 / §2.1 / §2.6)

The **first message this product ever sends**, on form submit, to a number that has not yet
consented to anything. It was the last template on the branch that had never been built.

| File | What changed |
|---|---|
| `lib/sms/message.ts` | `renderConfirmRequestMessage` — §2.6's body, real code |
| `lib/sms/signup-store.ts` | `sendConfirmationRequest` builds + dispatches + logs; a TODO correction (§au) |
| `app/api/sms/signup/route.ts` | passes `subscriberId` through for the audit row; header corrected |
| `tests/sms/confirm_request.test.ts` | **NEW**, 19 tests |
| `tests/sms/weekly_send.test.ts` | the confirmation request added to the all-templates GSM-7 wall |

## at. What "never built" actually meant here

`sendConfirmationRequest`'s non-dry-run branch was a single hardcoded line:

```ts
return { outcome: 'error', twilioSid: null, error: 'not implemented (draft scaffold)' };
```

The §2.6 body existed **only inside that function's doc comment**. Three consequences, none of
them cosmetic:

1. **It had never been through the GSM-7 wall.** Every other template is asserted in
   `tests/sms/weekly_send.test.ts`'s "every template this product sends is GSM-7 safe". A body
   living in a comment is invisible to that test by construction. Round 11 found a real bug in
   that guard by implementing a message against it — "never actually built" is not a formality.
2. **The dry-run branch returned before building anything**, which is NOT what the other send
   paths do. `sendWeeklySmsForSubscriber` and `sendWelcomeText` both build the message on every
   path and let `dispatchSms` decline to send it, so a verification run in an unconfigured
   environment renders and costs exactly the message a live run would send. This one produced no
   message and no segment count at all. Fixed: build first, dispatch with `dryRun`.
3. **`send_type = 'confirm_request'` had no writer.** Migration 0035's CHECK has listed it since
   round 1 and nothing ever inserted one — so the message with the *highest* CASL exposure was
   also the one with no audit row.

**Measured, now pinned:** 1 segment for every covered municipality. Worst case is
"North Vancouver" at **135 septets of 160**, so the whole covered set fits with 25 to spare.

## au. A TODO that would have produced two audit rows for one message

`createPendingSubscriber`'s doc said it should "write one `sms_send_log` row for the confirmation
request". `sendConfirmationRequest` is the function that performs that send. Implementing both
from their own comments would have inserted **two rows for one message** — and the row written by
the store could only ever have claimed `'sent'`, because at that point nothing has been sent.

Corrected in place: the store mints the token, the send step writes the row, with the outcome that
actually occurred (including `'failed'`). "We tried and Twilio refused" and "no record" are
different answers and only one of them is true.

## av. 🔴 Three things surfaced by building it — all need a decision, none silently resolved

### 1. A 21610 on THIS path is a dead end the form cannot see

On the weekly path, Twilio error 21610 means an active subscriber opted out at the carrier, and we
mark them stopped. On the confirmation path it means something different: **the number signing up
has already blocked our sender.** The confirmation text is undeliverable and stays that way until
*they* text START or UNSTOP to us — which nothing on the form tells them, and which we cannot do
on their behalf.

The route then answers `{ ok: true }` and the form says "check your phone". No message will ever
arrive. This is a real, reachable path: anyone who ever texted STOP and later signs up again on the
web lands in it, and STOP-then-return is exactly the sparse-area churn pattern §2.2 step 7 creates.

Not invented a fix. `sendConfirmationRequest` now returns `errorCode` so the case is at least
**visible** rather than flattened into a generic failure. The product answer — most likely a
specific form message along the lines of *"text START to +1 877-835-7776 to turn our texts back
on"* — is copy that does not exist and is Jon's to write.

### 2. The confirmation message states STOP but never HELP

CTIA's Messaging Principles expect an opt-in confirmation to carry program identity, message
frequency, "Msg&data rates may apply", **and both STOP and HELP instructions.** §2.6's approved
copy has the brand tag, "weekly", the rates disclosure and STOP. It has no HELP.

`CARRIER_DISCLOSURES` (round 3) does state "Reply HELP", but that is on the signup *form* — a web
page the carrier's own review of the *message* does not see, and which the recipient of a
wrong-number confirmation never visited.

There is room: 25 septets of headroom on the worst-case area, and `" Reply HELP for info."` is 21.
It fits, exactly, with nothing to spare. **Not added** — this is approved consumer-facing copy and
this branch does not edit it unilaterally (the round-4 ASCII substitution is still flagged for the
same reason). Flagged for Jon, with the measurement, because it is likely to come up during Toll-
Free Verification and the fix is cheaper before submission than after a rejection.

### 3. `signup-store.ts` now pulls the search engine into the signup route's module graph

`dispatchSms` / `recordSmsSend` live in `lib/sms/weekly-send-io.ts`, which top-level imports
`SearchEngine`, `loadPostgresListings`, the alias resolver, the region hierarchy and `lib/db/client`.
Anything importing it inherits all of that. `lib/sms/welcome.ts` already did this in round 11 (via
`app/api/sms/inbound/route.ts`), and the signup route now does too.

Harmless at runtime — nothing is *called* until `loadWeeklySmsDeps` runs — and `next build`
succeeds, with `/sms/signup` unchanged at 2.1 kB. But the two Twilio/log seams have nothing to do
with the weekly job, and their natural home is a small `lib/sms/outbound.ts` that `weekly-send-io`
re-exports. **Deliberately not done here**: it touches a heavily-tested file for a reason nobody
asked about, and unrequested churn on this branch is exactly what round 7's instruction was about.
Named so the next person does it on purpose.

## aw. Two smaller deliberate choices

**It is ONE line, where every other template is several.** The weekly, welcome, empty-week and
pause templates all break before a URL, because a link mid-sentence gets mis-tapped. This message
has no URL and no list, so it renders exactly as §2.6 writes it — one line, no invented breaks.
(The round-11 welcome *did* add breaks to §2.6's single-line blockquote; that was the URL forcing
one, not a house style.)

**It does not use `STOP_LINE`.** Every other template ends with "Reply STOP to end". §2.6 gives
this one "Reply STOP to opt out anytime." inline. Not normalised — it is the approved copy, and the
wording is better suited to its moment: "Reply STOP to end" addresses someone with something to
end, and this message reaches someone who has not confirmed anything yet. Pinned by a test so a
future "consistency" edit is a decision rather than a reflex.

## ax. Verification

19 new tests: §2.6 verbatim; JOIN and never YES; brand tag + rates + free opt-out; its own STOP
sentence and no line breaks; the GSM-7 guard, plus the all-templates wall; one segment for every
covered municipality with the 135-septet worst case pinned; the area clause degrading without a
placeholder; exactly one dispatch to the number on the signup; one `confirm_request` audit row with
`picks_snapshot` null and the consent version copied; the area resolver agreeing with the
`regionId` the validator already stored; dry-run-by-default building and costing but not
dispatching or logging; a real send when `SMS_SENDING_ENABLED=true`; a Twilio failure and a 21610
each mapping to the right code and log outcome; a send with no subscriber id still delivering; a
lost audit row not turning a delivered message into a failure; and nothing throwing or leaking the
number or the body.

`tsc --noEmit` clean, `eslint` clean, `npx next build` succeeds. SMS suite **283 tests across 17
files**. Full `unit` lane: **223 files / 3749 tests passing**.

---

# Round 13 — the unknown-keyword reply (inbound webhook)

Since round 1 the `unknown`/`default` branch of `dispatch()` has been a TODO. Anyone texting our
number anything that is not JOIN/STOP/START/HELP got a truly empty `<Response></Response>` — total
silence, which on SMS reads as "this number doesn't work".

| File | What changed |
|---|---|
| `lib/sms/message.ts` | `renderUnknownKeywordMessage` |
| `lib/sms/config.ts` | `signupUrl()` — one home for `/sms/signup` |
| `app/api/sms/inbound/route.ts` | `escapeXml` + `messageResponse`; `dispatch` returns a reply |
| `tests/sms/inbound_route.test.ts` | **NEW**, 17 tests — this route had no test file at all |
| `tests/sms/weekly_send.test.ts` | added to the all-templates GSM-7 wall |

## ay. The copy — **a SUGGESTION, not approved wording**

> KIDS FUN: Sorry, we didn't catch that. Reply JOIN to confirm your signup, HELP for info, or
> STOP to end. Not signed up? https://kidsfun.ca/sms/signup

**149 septets of 160 — one segment, with 11 to spare.** PRD §2.6 specifies five messages and this
is not one of them; §1.4 and §2.1 both assume "a human-readable nudge" without saying what it says.
So this was originated here and needs Jon's review like the round-9 sender identification did.

What is **not** a matter of taste is which keywords it names:

- **JOIN** is the point. `classifyInboundKeyword` refuses to fuzzy-match, deliberately, because
  promoting "JOIM" into an express-consent record is how consent gets fabricated. That decision is
  only safe if the near-miss is told what the real word is. **This message is the other half of a
  round-1 design decision that has been half-built for twelve rounds.**
- **STOP** is the free opt-out and belongs on anything we send.
- **HELP** routes to Twilio's own canned response, which is where CTIA expects support contact to
  come from. (Dependency: that canned text is still an un-done Operator console task.)
- **START is deliberately absent.** PRD §1.4 records that Twilio's behaviour toward a
  previously-unknown or previously-stopped number "may be a canned carrier-level auto-reply rather
  than a route into our app", and that START must be configured and verified against a real
  Canadian toll-free number before launch. We do not print a keyword we cannot promise works.

**The signup link is load-bearing, not decoration.** Somebody who texts us cold — §2.1's door 2 —
has no `sms_consent` row, so if they follow "reply JOIN" the transition answers
`no_such_subscriber` and the webhook says **nothing at all**. A nudge whose own advice leads to a
second silence is worse than no nudge.

⚠ **The 11 septets of headroom are the real constraint.** `https://kidsfun.ca/sms/signup` fits; a
preview-deployment host (`…git-feat-x.vercel.app`) would tip it into a second segment. Measured and
pinned, not assumed.

## az. TwiML `<Message>`, not the REST API — and why that is not a third pattern

Checked first, as asked: **no branch of this route replies with content today.** JOIN's welcome
goes out through the REST API (`sendWelcomeText` → `dispatchSms`); STOP/START/HELP mutate state and
say nothing, because Twilio's Advanced Opt-Out already answered them before our webhook ran.

So this is the first use of the `body` argument `twiml()` has always taken — the route header has
said "even though it MOSTLY does nothing" since round 1.

The welcome uses the REST API for two reasons and **neither applies here**:

1. It needs a per-subscriber read (area, ages, preferences token) keyed on the id the transition
   resolved. This reply is a static string and does no lookup — which is also what keeps a branch
   that fires on arbitrary inbound text cheap.
2. It writes an `sms_send_log` row. **This one cannot.** Whoever texted us may have no
   `sms_consent` row at all, and `sms_send_log.consent_text_version` is `NOT NULL` — a stranger has
   no consent, so there is no version to record — while `send_type`'s CHECK (migration 0035) has no
   value for an inbound reply. Logging it would mean minting a consent record for someone who never
   gave one, which is the exact thing this product's audit trail exists to make impossible.

Twilio records the message on its own side, and its suppression list still applies: a reply to a
number that has opted out is dropped by Twilio (21610), not sent by us.

**Gated by `SMS_SENDING_ENABLED` like every other outbound message.** "This deployment sends no
messages" has to mean all of them or it is not auditable, and it matters concretely right now:
until Toll-Free Verification is granted, outbound traffic from an unverified number is precisely
what should not be flowing. The message is still **built** on every path, so a broken template
fails in a dry run rather than only in production.

## ba. `escapeXml` — a trap that is already in our own copy

TwiML is XML and `&` breaks it. **§2.6's approved confirmation copy contains one** ("Msg&data rates
may apply"). Nothing routes that template through this response today, but the first thing that
does would emit a malformed document and a Twilio webhook error for a reason invisible in the copy.
Escaped at the boundary, tested directly against that exact string.

Narrowed to `& < >` after an earlier draft also escaped `'` and `"`: valid XML, but quotes are an
ATTRIBUTE-value concern, and escaping them turned every apostrophe in our copy into `&apos;` on the
wire — needless noise in the one artifact a person debugging a webhook actually reads.

**The reply never echoes the inbound body**, which is tested: an inbound webhook that reflected the
sender's text would be both an XML-injection vector and a way to make our number emit arbitrary
content.

## bb. Rate limiting — **a real concern, but a different and lower class than round 8's**

Asked for explicitly, so here is the reasoning rather than a verdict.

**It is not the same vector as `POST /api/sms/preferences`.** That route is unauthenticated HTTP:
anyone can hit it from a script at zero marginal cost, which is what makes "nothing stops unlimited
attempts" worth writing down. **This route is signature-gated** — only Twilio can trigger it — and
the only way to make it emit a reply is to actually deliver an SMS to our toll-free number. That
costs the sender real money or a real SIM, to cost us roughly one inbound plus one outbound
segment. **The amplification is 1:1 and the attacker pays more than we do.** Twilio and the
carriers also apply their own inbound abuse controls upstream of us. As an abuse vector: real,
bounded by economics, low severity.

**The case actually worth bounding is not an attacker — it is a LOOP.** Another automated system
texts our number (a wrong-number notifier, an appointment bot, a "no longer in service"
autoresponder), our nudge goes back, their system replies, and it runs until someone notices. That
is the classic SMS auto-reply failure mode, it is not adversarial, and it is not rare. It argues
for a **per-number cooldown**, not a global rate limit.

**Why no bound was built here.** A per-number cooldown needs per-number state, and there is none
for a stranger:

- `sms_consent` only has a row for someone who used the form. Creating one on inbound garbage
  would mint a consent-adjacent record for someone who never consented — the thing 0034 and the
  double opt-in exist to prevent.
- `sms_send_log` cannot hold it either, for the `consent_text_version NOT NULL` reason in §az.

So a cooldown means new schema (an `sms_inbound_reply` table keyed on `phone_hash`, default-deny
RLS, its own retention rule) or an external store. **And the PRD already declined that table once**:
round 5's finding records that a dedicated inbound-event log was deliberately left out of MVP
because §6 measures growth/CTR/churn only and Twilio's console already retains full inbound history
at zero cost. A reply cooldown is that same table arriving through a different door, and it should
be a deliberate reversal of that decision rather than a side effect of this round.

**Cheaper mitigations, in the order I would reach for them:**

1. **Twilio-side rate limits** on the Messaging Service, plus its built-in inbound abuse controls.
   Configuration the Operator already holds; no code, no schema.
2. **A stateless loop-breaker**: do not reply to a body that contains our own brand tag, which is
   what a naive echo loop carries. One line, no state — but it would also swallow a human texting
   "KIDS FUN what is this", so it is a decision, not a cleanup.
3. **Do not reply to an empty/emoji-only body**, which is the shape most likely to be machine-
   generated. This round chose to reply to those (see §bc); it is the lever to pull first if loops
   actually appear.

**Recommendation: record it in §7 Risks next to round 8's item, explicitly labelled as the lower
class, with the loop — not abuse — named as the thing to watch.** Do not build a cooldown table
before a loop has been observed.

## bc. 🔴 Two smaller things

**An emoji-only or empty body gets the reply too, and that is arguable.** `normalizeInboundBody`
strips `\p{S}`, so a thumbs-up normalises to `''` and classifies as `unknown`. A satisfied
subscriber who thumbs-up their weekly text gets "Sorry, we didn't catch that" — mildly clumsy.
Chosen anyway because the alternative is the silence this round exists to end, and because nothing
can distinguish a friendly emoji from a genuine question that happened to be all punctuation. Named
as the first lever to pull if it reads badly, or if a loop appears (§bb).

**The `start` branch has the same gap, one door over.** PRD §2.1's door 2 is *"Text START to
[number]" — our webhook replies with a link to the form*, and the v2.7 changelog says the reply for
a START from an unknown number should be "here's the signup link". `mirrorCarrierStart` runs and
the route says nothing. **Not built** — it needs the transition's outcome to choose between three
different replies (`no_such_subscriber` → signup link, `awaiting_confirmation` → "reply JOIN",
`applied` → nothing), and all three are copy decisions. But the TwiML seam this round added is the
thing that was missing, so it is now a small piece of work rather than an architectural one.

## bd. Verification

17 new tests, and **this route had no test file at all before them** — so they also pin round 1's
existing behaviour: 403 on a missing signature and on a wrong one, fail-closed with
`TWILIO_AUTH_TOKEN` unset, 413 before the signature check, and silence on a signed request with no
`From` (the path this reply most plausibly could have leaked into, since the body classifies as
`unknown` long before the `From` check runs). Plus: the real `<Message>` body; near-misses of JOIN
("JOIM", "join please", "yes please"); emoji and empty bodies; silence for all four handled
keywords and their aliases; the `SMS_SENDING_ENABLED` gate; no echo of the inbound body; the GSM-7
guard and the 149/160 measurement; the degraded no-link shape; and `escapeXml` against §2.6's own
`Msg&data`.

Requests are signed with **Twilio's own SDK**, not with our implementation, for the same reason
`twilio_signature.test.ts` is differential.

`tsc --noEmit` clean, `eslint` clean, `npx next build` succeeds. SMS suite **300 tests across 18
files**. Full `unit` lane: **224 files / 3766 tests passing**.

---

# Round 14 — the START replies (PRD §2.1 door 2)

The gap flagged at the end of round 13, one door over from the unknown-keyword reply. §2.1's door 2
is *"Text START to [number]" — our webhook replies with a link to the form*, and round 5's own
changelog specified that the reply differs by outcome. The webhook replied to none of them.

| File | What changed |
|---|---|
| `lib/sms/message.ts` | `renderStartSignupInviteMessage`; shared `signupClause` |
| `app/api/sms/inbound/route.ts` | `startReplyFor` — the three-way mapping; `start` branch wired |
| `tests/sms/inbound_route.test.ts` | +10 tests (17 → 27) |
| `tests/sms/weekly_send.test.ts` | the invite added to the all-templates GSM-7 wall |

## be. Only ONE of the two replies needed new copy

Asked directly, so stated directly.

**`awaiting_confirmation` → REUSED, nothing written.** The reply is
`renderConfirmRequestMessage(null)` — §2.6's already-approved confirmation request, with its area
clause degrading exactly as that renderer was built to. This is not a convenient substitute; it is
what PRD §2.1 literally specifies: *"no automated nudge in MVP (resubmitting the form or texting
START again both work)"*. **Texting START again is the thing that works, and this is what makes it
work.** A new "please reply JOIN" sentence would have been a second, unapproved way of saying a
message we already have signed off.

The web-page strings that look reusable are not — but **the reason below was written wrong the
first time and is corrected here.**

> ~~`PREFS_STATUS_PENDING` ("Almost there. Reply JOIN to our confirmation text…") and
> `SUBMITTED_BODY` both contain curly apostrophes, because they are HTML. Either one would have
> silently turned a 1-segment reply into a 2-segment UCS-2 one.~~

**What is actually true, measured against `lib/sms/consent-copy.ts` rather than recalled:**

| string | curly apostrophe | encoding |
|---|---|---|
| `SUBMITTED_BODY` | **yes** — "We’ve" | UCS-2. The claim holds. |
| `PREFS_STATUS_PENDING` | **no** — it contains no apostrophe at all | GSM-7 safe. The claim was wrong. |

So the encoding argument only ever applied to one of the two. **The decision not to reuse
`PREFS_STATUS_PENDING` is unchanged, and its real reasons are better ones:**

1. **No brand tag.** PRD §1.4 requires sender identification on every outbound message; every SMS
   template opens `KIDS FUN:` and this string does not.
2. **No opt-out instruction.** It is a page label, and a page does not need one.
3. **It points at a different message than itself.** "Reply JOIN to our confirmation text" reads
   correctly on a web page, where the confirmation text is somewhere else. Sent AS the text, it
   tells a parent to reply to something other than the thing in their hand.

That is a stronger case than the one originally given, and it does not depend on a fact about the
string that was not true. **Now pinned by tests** in `tests/sms/signup_copy.test.ts` rather than
left to a future re-reading — including the assertion that `PREFS_STATUS_PENDING` IS GSM-7 safe, so
the wrong reason cannot be re-cited from this document.

**The recurrence is the point worth recording.** This is the third time on this branch that copy
was described from memory instead of read: round 4's segment table (corrected in round 5), round
5's "an em dash and curly apostrophes" (corrected by the parent), and now this one. Each time the
underlying finding survived and only the supporting detail was wrong — which is exactly what makes
it easy to repeat. Every claim about a specific character in a specific string on this branch is now
either measured in a test or should be treated as unverified.

**`no_such_subscriber` → NEW copy, ⚠ a suggestion:**

> KIDS FUN: We text weekly kid activity picks for Metro Vancouver. Not signed up?
> https://kidsfun.ca/sms/signup
> Reply STOP to end

127 septets — one segment. §2.1 specifies the behaviour and the v2.7 changelog specifies which
outcome gets it, but no document gives the sentence, so this needs Jon like the round-13 nudge did.

Two things about it that are not taste:

- **It says what the product is before it asks for anything.** This is the one message on the
  branch that can reach somebody with NO record of us at all — a QR code on a noticeboard, a number
  off a poster. A bare link assumes they know what they nearly signed up for.
- **It carries the STOP line** even though it is answering their own text. That number has no
  `sms_consent` row, so there is no recorded consent of any kind behind it; after the confirmation
  request this is the highest-exposure message the product sends, and a brand tag plus a free
  opt-out is exactly what CASL's identification rules want on it.

**The signup sentence is now shared, not written a third time.** `signupClause()` is used by both
the unknown-keyword reply and this invite: they are the two messages that can reach a number with
no `sms_consent` row, and "where do I sign up" must not have two different answers depending on
which word the person happened to text.

## bf. The mapping, and why everything else is silent

`startReplyFor` is a **positive test on the two outcomes that reply**, the same shape as
`confirmAndWelcome`'s `applied` guard, so a future outcome is silent by default rather than
accidentally texting somebody.

| outcome | reply | why |
|---|---|---|
| `no_such_subscriber` | signup invite | door 2: nothing holds this number |
| `awaiting_confirmation` | confirmation request again | §2.1's own recovery path |
| `already_in_state` | — | they are active; nothing happened |
| `applied` | — | Twilio already answered — **but see §bg** |
| `dry_run` / `no_change` / `error` | — | nothing was written |

**Round 5's `awaiting_confirmation` outcome existed for precisely this.** Its own doc said
collapsing it into a neighbour "would make the webhook reply with the wrong thing — 'sign up here'
or nothing, when the right answer is 'reply JOIN to confirm'." That outcome has been carrying a
reply nobody sent for eight rounds. It now sends it.

**Dry-run gated like every other outbound message**, and it matters more here than on the unknown
branch: `no_such_subscriber` and `awaiting_confirmation` are read-only outcomes that
`runTransition` reports **as themselves even in a dry run** (only `applied` is displaced by
`dry_run`). Without the gate, a deployment with sending disabled would have replied. Tested.

## bg. 🔴 `applied` bundles a pause and an opt-out, and they are not alike

`decideStart` returns `applied` for **both** `stopped → active` and `paused → active`.

- **stopped → active** is a carrier opt-out reversal. Twilio's Advanced Opt-Out already removed the
  number from its suppression list and sent its own resubscribe confirmation **before this webhook
  ran**. Ours would be a duplicate message on the one exchange a carrier scrutinises most. Silence
  is clearly right.
- **paused → active** is our own empty-week auto-pause (§2.2 step 7). That number was **never** on
  Twilio's suppression list, so Twilio said nothing, and the parent has now had their texts
  silently switched back on with no acknowledgement at all.

So "nothing" is right for one and arguable for the other — and **the route cannot tell them apart**:
`TransitionResult` carries the TARGET status (`change.status = 'active'`), never the prior one, and
`ConsentRow` is consumed inside `decideStart`.

Not resolved here. Distinguishing them means widening the transition result and writing a fifth
piece of copy ("You're back in - picks resume Friday"), which is a decision, not a cleanup. Worth
noting the pause notice itself points at the preferences page rather than at START, so this path is
uncommon — but it is reachable, and it is the one START outcome where nobody says anything at all.

## bh. ⚠ The whole branch is contingent on an Operator config step

PRD §1.4, unchanged since round 1: *"START must be explicitly configured and verified, not assumed.
Twilio's default behavior toward a previously-unknown or previously-stopped number may be a canned
carrier-level auto-reply rather than a route into our app. Before launch: configure START as a
custom inbound keyword on the Messaging Service routed to our webhook, and verify this against a
real Canadian toll-free number."*

Two consequences worth stating plainly rather than discovering at launch:

1. **If START is not routed to our webhook, none of this code ever runs** — door 2 stays broken and
   nothing in our test suite can tell us, because the failure is in Twilio's console, not here.
2. **If Twilio's canned START auto-reply fires as well**, a parent gets two messages. That is the
   duplicate-reply concern behind `applied` being silent, applied to every outcome. Which of the
   two lands, and in what order, is exactly what §1.4's "verify against a real toll-free number"
   step is for.

This does not change what to build — the mapping is right either way — but the config step is now
load-bearing for a feature rather than for tidiness.

## bi. Round 13's `escapeXml` stopped being hypothetical

It was added for a trap nobody had hit: §2.6's confirmation copy contains a bare `&`
("Msg&data rates may apply"). This round routes **that exact template** through the TwiML response
for the `awaiting_confirmation` reply. Without the escaper this would have emitted a malformed XML
document and a Twilio webhook error, one round after it was written for the hypothetical. Pinned by
a test that asserts the escaped form of the actual reply.

## bj. Verification

10 new tests: the three-way mapping, each outcome asserted individually; every other outcome silent
(as an explicit list, so a new outcome is caught); both replies GSM-7-safe and one segment each
with the 127-septet invite pinned; the invite naming the product and carrying the STOP line; the
shared `signupClause` proven identical in both messages; end-to-end START through the real route
producing the invite; the carrier aliases (UNSTOP, "yes", " Start ") landing in the same place; the
dry-run gate suppressing a reply the read-only outcome would otherwise have produced; and the
`Msg&data` escaping.

`tsc --noEmit` clean, `eslint` clean, `npx next build` succeeds. SMS suite **310 tests across 18
files**. Full `unit` lane: **224 files / 3776 tests passing**.

---

# Round 15 — hub clicks (PRD §2.4 linking through §2.3's instrumentation)

The hub's "last week's picks" list linked straight to `/activity/{id}`, bypassing the short-link
route entirely. The code's own comment said the `'hub'` origin was what these links "produce once
the click recorder is wired for this surface"; nothing came back to wire it.

| File | What changed |
|---|---|
| `lib/sms/click-through.ts` | `LinkOrigin`, `parseLinkOrigin`, `hubClickPath`; `linkOrigin` is a parameter |
| `app/s/[shortId]/route.ts` | reads `?via=hub` and threads it |
| `lib/sms/preferences.ts` | `hubPickLinks`; `PreferencesRow.shortRef`; pick short_refs; `PreferencesViewPick` |
| `app/u/[preferencesToken]/page.tsx` | links through `/s/{token}?via=hub` |
| `tests/sms/click_through.test.tsx` | +9 (23 → 32) |
| `tests/sms/preferences.test.ts` | +6 (26 → 32) |

## bk. Two things were broken, not one

**1. PRD §6's metric was unanswerable by construction.** `SmsClickEvent.linkOrigin` was the literal
TYPE `'direct'` — not a default, a type — so no code path could ever write a hub click. §6's MVP
metric is "click-through rate… split by `link_origin`", and 0036's own column comment says it "is
the only way to answer whether the hub page earns its keep". That question could not have been
answered at any volume of traffic, for any length of time.

**2. A hub pick to an archived activity produced a bare 404.** `app/activity/[id]/page.tsx` calls
`notFound()` when the activity does not resolve (line 28, read not recalled). Links outlive
listings — that is the premise `occurrence_gone` exists for — so a pick cancelled since the send
dead-ended, **from the one page whose entire purpose is being the safe, no-login place to deal with
your subscription.** Round 9 built the interstitial precisely to eliminate that silent failure and
this surface never reached it. Now it does, and it is pinned by its own test rather than left as a
side effect.

## bl. Point 2 — the origin tag rides in a query parameter, and the spoof radius is one column

**Not in the token, and not only because the token is full.** 76 bits with a 20-bit check leaves no
room, yes — but the worse problem is that origin-in-token makes the SAME (occurrence, subscriber)
pair mint TWO different tokens, destroying the determinism that lets a link stay valid across sends
and doubling what `decodeShortLink` has to accept.

**What appending `?via=hub` to a texted link achieves:** `sms_click_event.link_origin` on the row
that tap writes. That is the whole effect.

**What it cannot touch**, because the token is a separate path segment and the query string is not
part of the signed payload — asserted directly in the tests, not reasoned about:

- whether the token verifies. A forgery with `?via=hub` is still `invalid_token`.
- which occurrence or subscriber it resolves to. Attribution stays correct.
- the redirect destination.
- whether a row is written at all — that still needs a live occurrence, a live subscriber row and a
  recoverable send log.
- consent state, PII, or the preferences token, which is a different token on a different route.

**Who can even do it:** only somebody holding valid tokens, i.e. a subscriber, skewing a statistic
about themselves, with nothing to gain. **Confirmed as suspected: one mis-attributed row of one
non-security column.**

The honest residual, named rather than dismissed: §6's direct-vs-hub split informs a V1
build/don't-build decision about the hub page, so sustained deliberate spoofing could in principle
nudge it. That needs effort by someone with valid tokens to influence a decision they cannot see.

**Alternatives considered:** `Referer` — unreliable, and this route already sets
`referrer-policy: no-referrer`, so inferring origin from a header we deliberately suppress
elsewhere would be incoherent. A second route `/h/{token}` — equally spoofable (anyone can
construct it from a direct token), plus a second public route to keep in step.

**The tag does not survive the redirect.** `resolution.destination` carries no query string, so
`?via=hub` is consumed at the route and never reaches the `Location` header — which is written into
browser history and handed to every proxy in between, and has no business carrying our analytics
tagging. Tested.

## bm. 🔴 A bug in this round's own code, caught by its own test

`parseLinkOrigin` was written as an object-literal lookup:

```ts
const VALUES: Record<string, LinkOrigin> = { hub: 'hub', direct: 'direct' };
return (raw && VALUES[raw]) || 'direct';
```

An object literal inherits from `Object.prototype`, so **`?via=constructor` returned the `Object`
function** and `?via=__proto__` returned the prototype — a value typed `LinkOrigin` that is not a
`LinkOrigin`, on a public unauthenticated route, headed for a `NOT NULL` CHECK-constrained column.
It would have defeated the "mapped, never passed through" guarantee written two paragraphs above it,
in the one implementation of that guarantee that does not hold.

Caught because the junk list in the test names `constructor` and `__proto__` explicitly. Fixed with
a `Set`, which has no inherited keys. **The paragraph and the bug were written in the same sitting**
— documenting an invariant is not the same as having one.

## bn. The data the hub did not have

`picks_snapshot` stores `[{occurrence_id, rank}]` (0035) and nothing else, and `PreferencesRow`
extended `ConsentRow` (`{id, status, stoppedAt}`). Neither carried a `short_ref`, so a token could
not be minted from what the page held. Both now do: `findLastWeek`'s TODO gains one keyed read
(`SELECT id, short_ref FROM activity_occurrence WHERE id = ANY($1) AND archived_at IS NULL`), and
`PreferencesRow` gains `shortRef`.

**`PreferencesView` still carries no internal reference.** Minting happens in the resolver, so
`short_ref` goes in and a finished href comes out — asserted by serialising the whole view and
checking neither the field name nor the value appears.

**It degrades to the old link, never to no link.** Three ways a token cannot be minted — no
subscriber `short_ref`, an occurrence archived since the send, or no `SMS_SHORT_LINK_SECRET` (which
`encodeShortLink` throws on rather than truncating, because a truncated ref would point at the
WRONG activity). Each falls back to `activityPath` with `attributed: false`, so an unattributed
panel shows up in a test rather than as a permanently flat metric months later.

**An archived pick stays IN the panel.** The snapshot is the record of what we SENT, and it must
still list a pick that has since been cancelled.

## bo. Verification

15 new tests. Origin: a hub tap recorded as `'hub'`; `'direct'` as the default with nothing passed
(regression); the untrusted value mapped with `constructor`/`__proto__`/case-variants/whitespace all
falling to `'direct'`; the query parameter proven not to affect the token's integrity check in
either direction; `hubClickPath` round-tripping through `parseLinkOrigin`; end-to-end through the
real `GET`; and `via=` absent from the `Location` header. Hub: links matching `/s/{13}?via=hub`;
minting the same token the weekly send would for that pair; no internal reference in the view; all
three degradation paths; and an archived pick staying listed. Gone-from-hub: `occurrence_gone` →
`/activity-unavailable`, uncounted, carrying no occurrence id.

`tsc --noEmit` clean, `eslint` clean, `npx next build` succeeds. SMS suite **328 tests across 18
files**. Full `unit` lane: **224 files / 3794 tests passing**.

---

# Round 16 — Jon's HELP clause, and the real Twilio integration

## bp. The confirmation-request HELP clause (Jon-approved) — MEASURED, not estimated

New copy: `Reply STOP to opt out anytime, or HELP for info.` This closes PRD v3.7's last open item
(the round-12 CTIA flag).

**The real numbers, from the suite rather than from arithmetic:**

| area | septets | segments |
|---|---|---|
| *(no area)* | **133** | 1 |
| Burnaby | 145 | 1 |
| Richmond | 146 | 1 |
| Vancouver | 147 | 1 |
| West Vancouver | 152 | 1 |
| **North Vancouver** | **153** | **1** |

The Operator's estimate was 133 exactly for the no-area case and "~152 with a long area name" —
152 is right for West Vancouver, and the true worst case is 153.

🔴 **Headroom went from 25 septets to 7.** This is now the tightest template the product sends.
Restated as the constraint that will actually bite: **an area label of 22 characters still fits, 23
does not.** Every Metro Vancouver name a coverage expansion could plausibly add is inside that
(New Westminster 15, Port Coquitlam 14, Maple Ridge 11, White Rock 10) — but "City of North
Vancouver" (23) is not. Pinned by a test that asserts both sides of the boundary.

`HELP for info` is the **exact phrase** already in `renderUnknownKeywordMessage`, reused so a
parent meets one wording for the same instruction wherever they meet it. Not hoisted into a shared
constant: three occurrences of a four-word phrase inside three different sentences is copy, not a
rule, and hoisting would make each sentence unreadable at its own call site to enforce something a
test asserts more cheaply.

**One fragile assertion surfaced.** `inbound_route.test.ts` proved "no area clause" with
`not.toContain(' for ')`, which broke the moment the approved copy added "or HELP **for** info."
The intent was right and the proxy was lazy; now asserted against the actual clause
(`not.toMatch(/picks for /)`).

## bq. The Twilio integration is real code now

| File | What |
|---|---|
| `lib/sms/twilio-client.ts` | **NEW** — real `dispatchSms`, memoised client, error mapping |
| `lib/sms/send-log.ts` | **NEW** — `recordSmsSend` moved out (still a stub) |
| `lib/sms/delivery-status.ts` | **NEW** — parse/verify/record the callback |
| `app/api/sms/status/route.ts` | **NEW** — the `StatusCallback` endpoint |
| `lib/sms/config.ts` | `statusCallbackUrl()` |
| `lib/sms/weekly-send-io.ts` | definitions removed, re-exported |
| `lib/sms/welcome.ts`, `signup-store.ts` | import from the new modules |
| `tests/sms/twilio_client.test.ts` | **NEW**, 16 tests |
| `tests/sms/delivery_status.test.ts` | **NEW**, 20 tests |

### bq.1 — Web access: I HAVE it, and I used it

Checked rather than assumed (`curl` to twilio.com returned 200). Two things were verified against
sources rather than recalled:

1. **The SDK surface**, read from `node_modules/twilio` at version **6.1.0** — `MessageStatus`
   union, `MessageListInstanceCreateOptions`, `RestException` (`{status, code, message}`), and the
   `httpClient` injection point. Also exercised at runtime to confirm `RestException` carries
   `code` as a number.
2. **The status-callback contract**, from Twilio's own docs page: POST,
   `application/x-www-form-urlencoded`, `MessageSid` / `MessageStatus` / `SmsSid` / `SmsStatus` /
   `ErrorCode`, and the warning that properties "vary by messaging channel and event type and are
   subject to change… Twilio occasionally adds new properties without advance notice."

That warning is honoured structurally: the signature is verified over the whole `URLSearchParams`
rather than a list of expected fields, and an unrecognised `MessageStatus` is stored verbatim
(0035's `delivery_status` is plain text with no CHECK, which now has a reason attached).

### bq.2 — How it is tested without an account

**Differentially, against the real SDK, with no network.** The genuine `twilio` client is
constructed with its documented `httpClient` option pointed at a fake, so the SDK does all the
request shaping and the assertions are on what it actually produced:

```
POST https://api.twilio.com/2010-04-01/Accounts/{AC…}/Messages.json
{ To, Body, MessagingServiceSid, StatusCallback }
```

A hand-written fake asserting our code called our own fake would pass on a wrong field name, a
wrong URL, or a `From` where a `messagingServiceSid` belongs. This will not.

**What genuinely cannot be verified here, stated plainly:** that Twilio's servers accept the
request, and that a real toll-free number is provisioned behind the Messaging Service. Those need
the credential and the account. Everything up to the socket is covered.

### bq.3 🔴 The PII rule is hardest to keep in exactly this file

**Twilio's own error messages contain the recipient's phone number.** Error 21211 is literally
*"The 'To' number +1604… is not a valid phone number."* Passing `err.message` into
`DispatchResult.error` — the obvious implementation — would have piped a subscriber's number into
every log line and Sentry breadcrumb the send job produces, defeating the discipline
`weekly-send-io.ts` documents at length.

So the error **code** is reported and the message is discarded. The code is the better diagnostic
anyway: it maps to one documented cause and it is what Twilio's console is searchable by. Tested by
serialising the whole result and asserting the number and the body are absent on every failure path.

### bq.4 — Module-graph consolidation: DONE, and the swap is what settled it

Round 12 flagged it and deferred it as unrequested churn. Two things changed:

1. **The new code needed a home, and `weekly-send-io.ts` was the wrong one.** Making the dispatch
   real adds the Twilio SDK to a module that already top-level imports the SearchEngine, the
   postgres listing repository, the alias resolver and the pg pool. Three unrelated features would
   have been importing a search engine *and* an HTTP client to send one text.
2. **Moving only the Twilio half would have fixed nothing.** Every caller pairs a dispatch with a
   log write, so `recordSmsSend` had to move too or `welcome.ts` and `signup-store.ts` would have
   kept importing `weekly-send-io` anyway. That is why there are two new modules rather than one:
   an external API client and a table writer have nothing to do with each other beyond being called
   in sequence, so `lib/sms/outbound.ts` (round 12's suggestion) would have been a bag.

**Risk checked before doing it**, not after: the only `vi.mock` of `weekly-send-io` is in
`weekly_run_route.test.ts`, and it replaces four functions the run route uses — none of them moved.
`weekly-send-io` re-exports both, so every existing importer keeps working, and the SMS suite went
from 330 to 330 on the move itself before a single new test was added.

### bq.5 — The delivery-status callback, and the two things it deliberately does not do

**It does not touch `outcome`.** 0035's header already settled this: the callback is "a
late-arriving fact about the same message, not a rewrite of history." `outcome = 'sent'` is the
CASL fact — what *we* did. `delivery_status = 'undelivered'` is what the carrier then did. Collapse
the second into the first and an audit asking "did you text this person on this date" starts
answering "no" for messages we demonstrably sent.

**It does not stop anyone.** A delivery failure is not an opt-out — phones are off, numbers get
reassigned, `30003` (unreachable handset) is the most common delivery failure there is. The two
paths into `status = 'stopped'` stay exactly the two PRD §2.2 step 6 specifies.

**It is the one write on this branch NOT gated on `SMS_SENDING_ENABLED`**, and the divergence is
deliberate: a callback can only arrive for a message that was actually sent, so the flag cannot
protect anything here — it could only discard delivery receipts for messages **already in flight**.
Recording what happened to a message we already sent is not sending. Tested as its own assertion so
it reads as a decision rather than an omission.

**A separate route from the inbound webhook**, and not only for tidiness: Twilio signs over the full
configured URL, so two endpoints need two configured URLs or neither verifies. Sharing one would
also mean delivery receipts arriving at the handler that classifies inbound keywords — where
`MessageStatus=delivered` would classify as `unknown` and, since round 13, earn an SMS reply to a
parent who never texted us.

### bq.6 — Flagged, not built

- **`SMS_STATUS_CALLBACK_URL` is a new environment variable** and needs Operator provisioning
  alongside the existing `SMS_WEBHOOK_PUBLIC_URL`. Unset, sends still work and the `StatusCallback`
  parameter is simply omitted — `delivery_status` then never gets its later truth.
- **Twilio returns `numSegments` on every create**, and our `estimateSegments` is documented as an
  *estimate* with Twilio as the authority. Comparing the two would make a segmentation surprise
  visible on the first real send. Not done — it would widen `DispatchResult`, which this round was
  explicitly scoped not to redesign. Cheap follow-up.
- **No retry, anywhere.** A failed dispatch is logged and left. That matches the existing design
  (the weekly job explicitly does not advance the empty-week counter on a failure), but it is worth
  being explicit that "real Twilio integration" does not mean "resilient Twilio integration".

## br. Verification

`tsc --noEmit` clean, `eslint` clean, `npx next build` succeeds with `/api/sms/status` registered.
SMS suite **368 tests across 20 files** (was 330/18). Full `unit` lane: **226 files / 3834 tests
passing**.

---

# Round 17 — the Operator's review: six findings

All six confirmed in source before changing anything. Five fixed, one flagged with a sharper
finding underneath it.

| # | File | Fix |
|---|---|---|
| 1 | `next.config.mjs`, `app/u/[preferencesToken]/page.tsx` | the two missing headers, for real |
| 2 | `lib/sms/welcome.ts`, `lib/sms/weekly-send-io.ts` | 21610 now marks the subscriber stopped |
| 3 | `lib/sms/safe-compare.ts` **NEW**, `twilio-signature.ts`, `weekly/run/route.ts` | length-flat compare |
| 4 | `lib/sms/redact.ts` **NEW**, two callers | one `redactPhone` |
| 5 | `app/api/sms/inbound/route.ts` | documented; see §bw for the real mechanism |
| 6 | merge commit | `origin/main` absorbed |

## bs. P1 — the comment was true and the code was not

`no-store` and `no-referrer` were described in the page's header block, with correct reasoning for
each, and **set nowhere**. Only `metadata.robots` existed.

**MECHANISM CHOSEN: `next.config.mjs`'s `headers()`.** A Server Component page cannot set response
headers the way `app/s/[shortId]/route.ts` does — that is a Route Handler returning a
`NextResponse`. Next's declarative `headers()` is the supported mechanism for a page, it matches
dynamic segments (`/u/:preferencesToken`), and it needed no change to `middleware.ts` — which
exists for an unrelated analytics-cookie concern, is owned by another workstream, and would have
meant putting a security header inside a function whose matcher covers the whole site.

**VERIFIED AGAINST A REAL RESPONSE, not against the config object.** Built, ran `next start`, and
curled the route:

```
GET /u/alice-token-0123456789abcdef
  referrer-policy: no-referrer
  cache-control: no-store, max-age=0
  <meta name="robots" content="noindex, nofollow, nocache"/>
GET /search   → no referrer-policy   (the rule is scoped, not global)
```

The automated test loads **the real `next.config.mjs` and Next's own `path-to-regexp`** rather than
a copied literal — a test against a copy keeps passing after somebody deletes the rule it protects —
and asserts the pattern matches `/u/abc` but not `/search`, `/u`, or `/u/abc/extra`.

The page's header block now says where each protection actually comes from.

## bt. P2 — a real bug, and the "correct" half was never tested either

`sendWelcomeText` logged `stopped_via_carrier` and left `sms_consent.status` at `'active'`. Fixed
by calling `markStoppedViaCarrier` on the 21610 branch, before the log write, mirroring
`weekly-send-io.ts`.

**Writing the cross-path test surfaced a second thing:** `sendWeeklySmsForSubscriber` — the half the
review called correct — **had no direct test at all.** It was only ever mocked wholesale by
`weekly_run_route.test.ts`. "Correct" was an assertion nobody had run. It now has the same three
injection seams (`dispatch`, `record`, `markStopped`) that `welcome.ts` and `signup-store.ts` have
carried since they were written, and the agreement test drives **both real functions** with the same
Twilio error code and asserts both mark the same subscriber stopped — rather than asserting one and
describing the other.

Also pinned: no other outcome marks anyone stopped (a plain delivery failure must never
unsubscribe), and a failed state write still leaves the 21610 in the audit trail.

## bu. P3 — the codebase already had the better pattern

Both SMS copies used `if (a.length !== b.length) return false`, which is constant-time in the value
and not in the length. `lib/admin/access.ts`'s `safeEqual` burns a same-length comparison instead.
Extracted to `lib/sms/safe-compare.ts` and used by both.

One implementation detail worth stating: the burn compares **the attacker's input with itself**, not
the secret with itself, so the work done scales with what they sent rather than with the length of
the secret.

**Honest severity:** the Twilio signature is a fixed-length base64 digest, so its length is public
and that leak was theoretical. The **cron secret** is the real one — its length is not public and it
is the only thing between an unauthenticated caller and a live send. Neither was an emergency; the
reason to fix both is that the weaker pattern is the one that gets copied into the next check, and
this branch has now written three.

`lib/email/unsubscribe.ts` left alone as instructed — outside this branch's footprint, its own
judgment call, already made.

## bv. P4 — one `redactPhone`

Byte-for-byte duplicated, and the inbound route's copy carried a comment claiming the redaction
"lives here rather than at each call site" — which was true of neither copy. Now
`lib/sms/redact.ts`, re-exported from `weekly-send-io.ts` so existing importers are unaffected, and
both comments corrected.

## bw. P5 — 🔴 the duplicate risk is real, and its mechanism is NOT the one in the brief

**`after()` does not exist here.** Verified two ways: absent from `next/server`'s exports on the
installed package, and Next's own docs record `unstable_after` arriving in **15.0.0-rc** and
stabilising in **15.1.0**. This repo is on **14.2.35**.

**The Twilio side is narrower than stated.** From Twilio's connection-override documentation: the
total webhook budget including retries is capped at **15s** (`tt`, enforced at maximum when unset),
the default retry count is **1**, and the default retry policy is **`rp=ct` — TCP connect or TLS
handshake failure only.** A handler that is merely SLOW is **not** retried under the defaults; that
requires `rp` set to `rt` or `all`. Which it is, is an Operator console setting.

**But the duplicate is reachable by a shorter path, and this is the actual finding.** A sequential
replay is already safe: the second `confirmSubscriber` reads `active`, returns `already_in_state`,
and round 11's guard sends nothing. A **concurrent** one is not —
`applyConsentChange`'s documented UPDATE is:

```sql
UPDATE sms_consent SET ... WHERE id = $1
```

**No status predicate.** Two in-flight passes can both read `pending`, both write, and both report
`applied` → two welcome texts. Its sibling writes both guard: `applyEmptyWeekState` has
`AND status = 'active'` and `markStoppedViaCarrier` uses `COALESCE(stopped_at, now())` for exactly
this class of reason. JOIN's does not, and its own doc explains the `WHERE id` choice on PII grounds
without noticing it gave up idempotency.

**Not fixed, deliberately**, and the options ranked honestly:

1. **The status predicate on JOIN's UPDATE** is the cheapest real fix and makes the double send
   *impossible* rather than unlikely. It needs `applyChange` to report rows-affected so the
   transition can answer `already_in_state` when it matched none — a change to a stub's contract,
   and a decision rather than a guess.
2. **`waitUntil` from `@vercel/functions`** is the primitive `after()` wraps and would work — not a
   dependency here, and it couples this route to one platform.
3. **Bare fire-and-forget** is *worse than the status quo*: on a serverless runtime the instance may
   be frozen the moment the response returns, dropping the send non-deterministically, with nothing
   in any log to say which times it did not go.
4. **A queue** is real infrastructure, out of scope.

Documented in the route itself, at the guard, so the next person to touch it sees it.

## bx. P6 — merged, clean, and checked rather than assumed

`git merge origin/main` (not a rebase — the 36 commits here have been reviewed individually).
`275c7c9` is now an ancestor. The only commit on `origin/main` since this branch's base
(`30e232a`) is that one, it touches only `app/privacy/page.tsx`, and this branch has **zero**
commits touching that file — verified with `git log --name-only`, not assumed. No conflicts.

⚠ **`git fetch` fails here** (no GitHub credentials on this branch, by design — the Operator holds
them). The `origin/main` ref was already present locally, so the merge used it; but this branch
cannot confirm it is current with the true remote. If main has moved since that ref was written,
this merge does not include it.

## by. Verification

`tsc --noEmit` clean, `eslint` clean, `npx next build` succeeds. SMS suite **376 tests across 21
files** (was 368/20). Full `unit` lane: **227 files / 3842 tests passing**. Plus the live
`next start` header check recorded in §bs.

---

# Round 18 — the multi-agent QA pass: four fixes, one product decision

Six independent agents on fresh worktrees pinned at `b38a8ff`. Four defects fixed, one flagged for
Jon, four smaller items documented.

| # | Files | Fix |
|---|---|---|
| 1 | `lib/sms/weekly-send-io.ts`, `tests/sms/weekly_send_io.test.ts` **NEW** | post-dispatch writes wrapped |
| 2 | `lib/sms/consent-transitions.ts`, `tests/sms/consent_transitions.test.ts` | the shared compare-and-set |
| 3 | `app/api/sms/inbound/route.ts`, `tests/sms/welcome.test.ts` | the real guard, tested |
| 4 | `tests/sms/redact.test.ts` **NEW** | `redactPhone`'s actual output |

## bz. #1 — one unwrapped write, two different defects

The three post-dispatch calls (`log`, `markStopped`, `applyEmptyWeekState`) fell into the
function's single outer `catch`, which returns `error: (err as Error)?.message` verbatim — and
`app/api/sms/weekly/run/route.ts` passes `r.error` straight into the HTTP response.

**It leaks.** Those three are the ONLY calls in the function that hand a phone number to a
database, and drivers routinely echo the offending row's values back in a constraint violation
(`DETAIL: Key (phone)=(+1604…) already exists`). That is a subscriber's number in an HTTP response.

**And it lies.** A message that genuinely went, or a carrier opt-out genuinely detected, was
reported as `status: 'error'` because the AUDIT WRITE afterwards failed — discarding the outcome
the subscriber actually experienced in favour of a fact about our own bookkeeping.

Fixed with a `bestEffort` wrapper, matching what `welcome.ts` and `signup-store.ts` have done since
they were written. **The path that had this pattern first never got it.**

Two things worth noting beyond the fix:

- **A `scrubNumber` backstop** on the outer catch, named as a backstop: it matches only the exact
  E.164 string we hold, so a differently-formatted number would slip past. The real fix is that
  after wrapping, no code path that HOLDS the number can reach that catch at all — the deps load
  and the pure build are the only remaining throwers, and `dispatchSms` never throws.
- **`sendWeeklySmsForSubscriber` now has its own test file** (11 tests). It previously had almost
  none: mocked wholesale by the run-route test, touched once obliquely in round 17. Its branch
  wiring — which `send_type` pairs with which outcome, that a failed dispatch does not advance the
  empty-week counter, that a dry run writes nothing, that an out-of-area postal changes nothing —
  is now covered.

## ca. #2 — the race was never JOIN-specific, and the fix is on the shared contract

Round 17 found it on JOIN and scoped the fix there. The QA pass was right that this was too narrow:
`confirmSubscriber`, `mirrorCarrierStop` and `mirrorCarrierStart` all funnel through the same
`runTransition` and the same `applyConsentChange`. A JOIN-only wrapper would have left the identical
race live on the shared path, to resurface the first time any caller reacted to a STOP/START
`applied`.

**Fixed on the contract**, as round 17 scoped in its own option 1:

- `ConsentChange` gains **`expectedStatus`** — the status the decision READ.
- The UPDATE gains `AND status = $4` and `RETURNING id`.
- `ConsentChangeApplier` returns `'applied' | 'no_match'` instead of `void`. A `Promise<void>`
  applier literally cannot express "the compare-and-set failed".
- `runTransition` maps `no_match` → **`already_in_state`**, which is both true (the end state was
  reached, by someone else) and the outcome every caller already treats as "do nothing further".

**`expectedStatus` carries the status that was read, not a per-decision list of acceptable ones.**
Each decision already narrowed to one row in one state, so the tightest predicate is free — and a
list is a second thing to keep in step with the decision that produced it.

Tested for **JOIN vs JOIN, STOP vs STOP and START vs START** — winner reports `applied`, loser
reports `already_in_state`, loser still attempted the write (losing is decided by the database, not
predicted), and the loser is not an error. Plus: the loser's result feeds `shouldSendWelcome` and
returns false, which is the whole point.

## cb. #3 — a test of a copy is a test of the copy

The guard preventing a repeat JOIN from re-sending the welcome was inline in an unexported
function, and `welcome.test.ts` asserted a hand-written re-implementation of the same condition.
The QA pass proved it: deleting half the real condition left every relevant test green.

`shouldSendWelcome` is now exported and pure, `confirmAndWelcome` is exported with both
collaborators injectable, and the copy is deleted. **Re-ran the QA pass's own mutation** — removing
`&& Boolean(result.subscriberId)` now fails a test, where before it failed nothing.

## cc. #4 — the consolidated helper nobody was checking

Round 17 gave `redactPhone` one home specifically so the rule could not drift. The QA pass showed
that home had no test: changing `slice(-4)` to `slice(-6)` — six digits in every log line instead
of four — passed all 376 tests. **Verified the mutation now fails 4 of the 6 new assertions.**

Giving a rule one home only helps if something checks what the rule says.

## cd. 🔴 FOR JON — the coverage swap picks a band champion and then hides it

**Reproduced and pinned by a test** (`tests/sms/weekly_picks.test.ts`), which asserts the current
behaviour rather than endorsing it:

`applyCoverageSwap` always `push`es the forced candidate onto the **tail** of the selection, so on a
full 10-pick week it is ranked **10 of 10**. `lib/sms/weekly-send.ts` names and links only the first
`DIRECT_LINK_PICKS` (3). So the pick chosen *specifically because* an age band was unrepresented is
the one pick **guaranteed** to be folded into the anonymous "+N more" — the opposite of what the
feature exists for. A parent of a 12-year-old gets a text naming three toddler activities and a
count.

**This is a product decision, not mine.** The two options, and what each costs:

- **(a) Promote forced picks above the direct-link cutoff.** The feature then does what its
  docstring says. Cost: it changes visible SMS content and ranking — a lower-relevance activity
  displaces a higher-ranked one from the named three, on every send where a band was short.
- **(b) Accept "counted but not named" for MVP.** Zero code change, and defensible if the swap's
  real purpose is understood as *"the hub page shows something for every child"* rather than
  *"every child sees a named pick in the text"*. Cost: the docstring currently claims the latter.

**No recommendation, deliberately** — the choice depends on which of those two the feature is
actually for, and only Jon can say. Flagged as a decision, with a test that makes either answer
visible.

## ce. Documented, not fixed

- **`sendWeeklySmsBulk`** still has no direct coverage of its own loop/summary behaviour. #1 covered
  the per-subscriber unit it calls; the bulk driver is a thin loop over it. Not blocking.
- **`SMS_STATUS_CALLBACK_URL`** — added to `.env.example` and to `config.ts`'s env header, which
  was the cheap half of this and is done.
- **Dead code removed.** `void redactPhone(from)` computed a value nothing consumed, under a
  comment implying it was logged. **Removed rather than wired up:** this route has no logging call
  anywhere, and inventing one for a branch that fires on arbitrary inbound text would add a
  PII-adjacent log line with no consumer. The comment now says that, and points at `redactPhone` as
  the required shape if one is ever added.
- **The 16 KiB inbound cap** is enforced after the body is buffered; the cheap pre-check only fires
  on an honest `Content-Length`. Known defence-in-depth gap, almost certainly bounded by the
  hosting platform's own request limit first. Noted, not fixed — closing it properly means reading
  the body as a stream and aborting mid-read, which is a real change to a route whose correctness
  currently rests on reading the raw body exactly once for signature verification.

## cf. Verification

`tsc --noEmit` clean, `eslint` clean, `npx next build` succeeds. SMS suite **402 tests across 23
files** (was 376/21). Full `unit` lane: **229 files / 3867 tests passing**. Both QA mutations
re-run and confirmed to fail now.

> **Corrected.** This originally read 401. The measurement was real but STALE — taken before the
> coverage-swap regression test was added to `weekly_picks.test.ts`, which was the last change in
> the same commit, and never re-run afterwards. Caught on review. See §cg: this is a different
> failure mode from the three before it, and the rule adopted after those did not catch it.

## cg. A note on the verification rule, because it just failed

Four times now a specific value in a report has been wrong while the underlying work held. The
first three were the same shape — a character, a count, a version, recalled instead of read — and
the rule adopted after them was: **measure it, or state it as unverified.**

**The fourth was different and the rule did not catch it.** The round-18 test count was genuinely
measured. It was measured *in the middle of the work*, one edit before the end, and then reported
as though it described the commit. A real measurement of a tree that was never committed.

So the rule needed a second half, and now has one:

> **Measure it or call it unverified — and measure it AFTER the last commit, not during the work.**

The point is not diligence, it is ordering. A figure taken mid-work is a claim about a tree that no
longer exists by the time it is reported, and it is more dangerous than a recalled one precisely
because it feels verified. Every verification run in a report from here is the one that ran against
the committed tree, and the numbers in §cf now come from that run.

---

# Round 19 — the batch driver, which had never been executed

| File | What |
|---|---|
| `lib/sms/weekly-send-io.ts` | `BulkOptions` gains the two batch loaders and the four write seams |
| `tests/sms/weekly_send_bulk.test.ts` | **NEW**, 13 tests |

## ch. It was not under-tested, it was un-runnable

`sendWeeklySmsBulk`'s only appearance anywhere in `tests/sms/` was a `vi.mock` in
`weekly_run_route.test.ts` that replaces it wholesale. That was not an oversight of coverage — the
function **could not be called from a test at all.** `loadWeeklySmsDeps()` is its first statement
and goes straight to Postgres, so a direct call threw before reaching an assertion.

So `BulkOptions` gained `loadDeps`, `loadSubscribers`, and the four per-subscriber write seams the
unit already had. **`loadDeps` is injected rather than a ready-made `deps`**, deliberately: handing
in the read model would leave nothing to COUNT, and "loaded once per batch" is precisely the
property worth counting.

The four write seams also revealed something smaller: `sendWeeklySmsBulk` was not threading
`dispatch`/`record`/`markStopped`/`applyState` down to `sendWeeklySmsForSubscriber` at all. Rounds
17 and 18 added them to the unit; the driver never passed them on. Harmless in production (both
default to the same functions) and fatal to testing the batch.

## ci. Point 5 — the "load once" claim HELD, and is now counted rather than believed

Round 4's design decision, mirroring `lib/email/weekly.ts`: load the read model once, reuse it for
every subscriber, never re-query Postgres per subscriber. **After eighteen rounds of changes it
still holds** — one load for five subscribers.

Checked in two directions, because a load counter alone is not enough:

1. `loadDeps` is called exactly once for a five-subscriber batch.
2. **The same instance is passed down.** Loading once and then not threading it through would look
   identical to the counter and be just as wrong, so the test asserts the engine each subscriber
   searched against is that one object.

**Mutation-tested rather than asserted:** moving the load inside the loop fails both, and only
those two. Restored clean.

## cj. ⚠ One small waste the check found, pinned not fixed

The deps load happens **before** the subscriber query, unconditionally. So a week with zero active
subscribers still pulls the entire listing catalogue, alias resolver and region hierarchy out of
Postgres for nothing — reachable every week before launch, and any week the product is paused.

The reorder is two lines and strictly better. **Not done:** round 19 was scoped to coverage rather
than behaviour, and quietly changing what a driver does under cover of "adding tests" is how a test
round becomes a behaviour round nobody reviewed. A test asserts the current single wasted load, so
the day someone reorders it, the decision is visible rather than silent.

## ck. What the batch survives, and why

**One subscriber's failure does not abort the run — but not because this loop is careful.** There
is no `try`/`catch` in `sendWeeklySmsBulk` at all. It survives because
`sendWeeklySmsForSubscriber` returns a structured result on every failure path and never throws.
That is a contract between two functions, and it was only ever asserted on one side of it. It is
now asserted from the batch's side too: a throwing `record()` for the middle subscriber of three
leaves all three processed, reported, and — since round 18 — still carrying their true outcomes.

Also covered: results keyed to their own subscriber ids; one subscriber's carrier opt-out not
smearing onto its neighbours; a five-way mixed batch aggregating into `counts` that sum to the
candidate list; `limit` capping deterministically; nothing in the serialised summary carrying a
phone number, a driver error or a message body (the run route puts this straight into an HTTP
response); and the dry-run flag being decided once at the top and reaching every subscriber, with
no per-subscriber override — the flag that stands between a verification run and texting real
parents.

## cl. Verification

`tsc --noEmit` clean, `eslint` clean, `npx next build` succeeds. SMS suite **416 tests across 24
files** (was 403/23). Full `unit` lane: **230 files / 3882 tests passing**. Measured after the
commit, per §cg.

---

# Round 20 — Jon's Q4 and Q5 rulings, built

PRD **v3.15** read directly, not from the relay. Both rulings quoted verbatim below from the
document rather than from the brief.

| File | What |
|---|---|
| `lib/sms/weekly-picks.ts` | forced picks jump the queue; docstring rewritten to the new mechanism |
| `tests/sms/weekly_picks.test.ts` | the round-18 pinning test switched sides; +2 tests |
| `lib/sms/consent-copy.ts` | Jon's sentence, verbatim; the version-bump rule narrowed |
| `tests/sms/signup_copy.test.ts` | +4 tests |

## cm. Q4 — ⚠ AN INTENTIONAL, JON-APPROVED BEHAVIOUR CHANGE TO WHAT SUBSCRIBERS SEE

**Not routine test maintenance. Not a refactor.** This changes which activities are named in a
parent's text.

**Jon, verbatim (PRD v3.15):** *"I approve option A. Let it jump the Q so it's always named."*

`applyCoverageSwap` now places the forced pick at the **front** of the selection instead of
appending it to the tail. Since `weekly-send.ts` names and links only the first
`DIRECT_LINK_PICKS` (3), the pick chosen *because* a child's age band had no organic match is now
guaranteed to be one of the named ones — where before, on a full 10-pick week, it ranked 10 of 10
and was folded into an anonymous "+N more".

**THE COST IS THE APPROVED TRADEOFF, NOT A SIDE EFFECT:** a lower-relevance forced pick now
displaces a higher-ranked organic one from the named slots on any short-band send. With
`MAX_FORCED_PICKS` at 2, a thin week can spend two of the three named slots on forced picks. Both
are asserted, so neither is a surprise later.

**Front, not "insert at slot 3."** Inserting at the last named position would displace less and
still satisfy "always named" *today* — but only while `MAX_FORCED_PICKS` (2) ≤ `DIRECT_LINK_PICKS`
(3). Lower the direct-link count to 2 and a slot-3 insertion silently stops being named again, with
no test failing — precisely the failure this ruling exists to end. A test now asserts the guarantee
against the constants rather than against their current values.

**The round-18 pinning test switched sides, and that is it finishing its job.** It was written to
pin the defect explicitly *without* endorsing it — "NOT AN ASSERTION THAT THIS IS RIGHT… so the
product decision is measurable and a future change to it is loud." It is now loud, and it now
asserts the opposite. That is the test being completed, not loosened to fit new code, and its
comment says so at the point where a future reader will ask.

**The docstring was rewritten, not amended.** It described append-to-tail; describing the new
mechanism is the whole point of the ruling, since the old comment claimed a surfacing the code did
not do.

## cn. Q5 — Jon's own sentence, verbatim

**Jon, verbatim:** *"please make up that sentence and insert it. Solve that problem. approved"* — he
authored the copy rather than choosing between options. `SUBMITTED_BODY` now ends:

> If you've texted us before and replied STOP, text START to +1 877-835-7776 first to turn our
> texts back on, then try again.

Closes the round-12 dead end: a 21610 on the confirmation send means the number already blocked our
sender, so the text is undeliverable and the page used to say "check your phone" while nothing ever
arrived.

**SHOWN TO EVERYONE, AND THAT IS A SECURITY DECISION.** The obvious implementation — show it only
when the dispatch returned 21610 — would be a real regression. `app/api/sms/signup/route.ts`
deliberately never surfaces `errorCode` or the dispatch outcome to an unauthenticated caller, so
the form cannot be used to probe whether *someone else's* number is opted out. Conditioning this
copy would rebuild that oracle in prose instead of a JSON field, where it is harder to notice. A
`const string` cannot be conditional; a test pins that too.

`SUPPORT_PHONE_DISPLAY` supplies the number rather than a fourth hand-typed copy.

**Not SMS copy, so no GSM-7 guard.** This is HTML and never reaches a Twilio body — which is why it
can keep the curly apostrophe in "We've" that would cost real money in a text.
`tests/sms/signup_copy.test.ts` already asserts this string is *not* GSM-7 clean and is not
sendable, so the distinction is checked rather than assumed.

⚠ **One inconsistency left deliberately:** Jon's sentence uses a **straight** apostrophe in
"you've" while the sentence above it uses a **curly** one in "We've". Left exactly as authored —
"insert verbatim" was the instruction, and a one-character typographic edit to approved copy is
still an edit to approved copy. One character in either direction if anyone wants them to match,
and no encoding cost either way on a web page.

## co. ⚠ A judgment call inside Q5: the version-bump rule was too broad

This file's header said **"IF YOU CHANGE ANY STRING IN THIS FILE, BUMP CONSENT_TEXT_VERSION"**, and
`SUBMITTED_BODY` is a string in this file. Read literally, Q5 requires a bump. **It was not
bumped**, and the rule was narrowed instead.

`sms_consent.consent_text_version` answers exactly one question: *which wording did this subscriber
agree to.* `SUBMITTED_BODY` is displayed only **after** they have submitted, so it cannot be part of
what was agreed. Bumping would stamp two subscribers with different versions who agreed to identical
wording — **a false statement in an audit column, not extra safety.** Over-recording is not the
conservative direction when the column's meaning is this specific.

The rule now names both sides explicitly (what moves it: the checkbox, its labels, the carrier
disclosures, the sender identification. What does not: the post-submit page, the preferences status
lines). PRD v3.9 declined a bump on adjacent reasoning.

**Flagged because it is mine, not Jon's.** He ruled on the copy, not on the versioning discipline.
One constant and one comment to reverse.

## cp. Q6 — closed, no code

Jon confirmed the round-14 START-reply copy already on the branch. Paperwork, not a build task; it
closes the gap that a shipped string had never been through sign-off.

## cq. Verification

`tsc --noEmit` clean, `eslint` clean, `npx next build` succeeds. SMS suite **422 tests across 24
files** (was 416/24). Full `unit` lane: **230 files / 3888 tests passing**. Measured after the
commit, per §cg.
