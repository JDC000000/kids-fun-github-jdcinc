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
