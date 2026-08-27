# SMS persistence — scoping brief

> **SCOPING ONLY. No migration written, no persistence code written, nothing applied.**
> PRD §8 item 5, Jon: *"let's start building and solving that problem now."*
> Branch `feat/kf-sms-pivot-draft` @ `3b548a1`.

---

## 0. The constraint this plan is built around

**The Operator applies migrations. I never do — not to production, not to the local test Supabase,
not once.** I can author migration files; running them is always the Operator's step, and this plan
assumes that at every stage rather than treating it as a formality at the end.

Two consequences that shape the ordering below, and they are the reason this is not simply "write
the SQL then write the code":

1. **Every stage has a hand-off in the middle of it.** A seam cannot be verified until its table
   exists, so each block is: I write code + migration → Operator applies → I verify. Sequencing
   that badly means the Operator does five separate apply-and-wait cycles.
2. **I cannot test what I write until it is applied.** So the plan front-loads everything that can
   be proven without a database, and the apply steps are batched into as few as the dependencies
   allow — **two**, as it turns out.

---

## 1. What is actually stubbed — 14 seams, not ~10

Counted from source, `lib/sms/*.ts`, every `Draft scaffold` marker:

| # | Seam | File | Reads/Writes |
|---|---|---|---|
| 1 | `createPendingSubscriber` | `signup-store.ts:88` | W `sms_consent` (upsert) |
| 2 | `findSubscriberByPhone` | `consent-transitions.ts:195` | R `sms_consent` |
| 3 | `applyConsentChange` | `consent-transitions.ts:234` | W `sms_consent` |
| 4 | `findByPreferencesToken` | `preferences.ts:150` | R `sms_consent` |
| 5 | `findLastWeek` | `preferences.ts:189` | R `sms_send_log` + `activity_occurrence` |
| 6 | `applyPreferencesChange` | `preferences.ts:237` | W `sms_consent` |
| 7 | `recordSmsSend` | `send-log.ts:61` | W `sms_send_log` |
| 8 | `loadActiveSubscribers` | `weekly-send-io.ts:164` | R `sms_consent` |
| 9 | `loadRecentlySentPickIds` | `weekly-send-io.ts:215` | R `sms_send_log` |
| 10 | `applyEmptyWeekState` | `weekly-send-io.ts:234` | W `sms_consent` |
| 11 | `markStoppedViaCarrier` | `weekly-send-io.ts:254` | W `sms_consent` |
| 12 | `loadWelcomeSubscriber` | `welcome.ts:81` | R `sms_consent` |
| 13 | `findOccurrenceIdByShortRef` / `findSubscriberIdByShortRef` / `findSendLogIdForClick` / `recordClick` | `click-through.ts:243–319` | R×3, W×1 `sms_click_event` |
| 14 | `applyDeliveryStatus` | `delivery-status.ts:132` | W `sms_send_log` |

**Every one already carries the exact query it will issue**, written when the seam was built and
reviewed at the time. This is transcription against a live schema, not design.

**One seam is NOT stubbed and matters:** `loadWeeklySmsDeps` (`weekly-send-io.ts:94`) is real and
already queries Postgres. It is why the weekly route 500s on the harness today.

---

## 2. Schema — mostly written, two real gaps

**Already written, never applied:** `0034_sms_consent`, `0035_sms_send_log`, `0036_sms_click_event`,
`0037_activity_occurrence_short_ref`. Reviewed across rounds 1–2; I would re-read rather than
assume, but I do not expect to rewrite them.

**Gap A — 0037 is not a free ALTER, and its own file says so.** It adds a
`GENERATED ALWAYS AS IDENTITY` column to `activity_occurrence`, which is implicitly NOT NULL and
must be materialised for every existing row: a full table rewrite holding an ACCESS EXCLUSIVE lock.
On the production catalogue that is a real maintenance window, not a deploy step. **This is the one
migration whose apply needs planning rather than just permission**, and it should be the Operator's
call whether it runs in a window, in batches, or as a nullable column plus a backfill.

**Gap B — the local test Supabase is behind the branch in more than one way.** Round 20 found
`activity_occurrence.short_ref` missing (expected — 0037) *and* `registration_required` missing
(not expected). So the local DB is an older snapshot, and getting it current is its own task before
any SMS table matters. **Worth the Operator knowing before they plan an apply: the local instance
may need re-seeding from a current dump, not just four migrations.**

**No new migration is anticipated** beyond those four. If one turns out to be needed I would write
it and flag it rather than fold it in.

---

## 3. Proposed build order

Dependency-real, not alphabetical. **Two Operator apply-steps total**, marked ⛔.

### ⛔ APPLY 1 — `0034` + `0035` (the two SMS tables)
No dependency on `0036`/`0037`. Unblocks nine of the fourteen seams. `0036` is deliberately held
back — it FKs to both of the above, so it is strictly easier after them, and nothing in stages A–C
touches it.

### Stage A — signup persistence (seams 1, 2, 3, 12)
`createPendingSubscriber`, `findSubscriberByPhone`, `applyConsentChange`, `loadWelcomeSubscriber`.
**This is the first stage that produces a durably testable journey: signup → JOIN → welcome.**
Also mints `preferences_token` (HMAC over the new row id, `SMS_PREFERENCES_SECRET`) — currently a
TODO inside seam 1 and the only piece of *new* logic in this stage.

### Stage B — the send log (seams 7, 14, 9)
`recordSmsSend` first: every other write depends on rows existing to update.
Then `applyDeliveryStatus` (updates by `twilio_sid`) and `loadRecentlySentPickIds` (the novelty
window). Needs the `phone_hash` decision below.

### Stage C — the weekly job + preferences (seams 8, 10, 11, 4, 5, 6)
`loadActiveSubscribers` makes the Friday job real end to end. `findLastWeek` needs `0035` **and**
the `activity_occurrence` join for short refs, so it is the one Stage-C seam that also wants
`0037`; if 0037 is deferred it degrades to unattributed hub links, which round 15 already built for.

### ⛔ APPLY 2 — `0036` + `0037`
### Stage D — click-through (seam 13)
Last on purpose. It is the only seam needing both remaining migrations, it is the least
load-bearing (a failed click write costs one analytics row and never affects a redirect — the
module is explicitly built that way), and by then everything it joins to exists.

---

## 4. Sizing and risk

| Stage | Size | Risk | Why |
|---|---|---|---|
| A | **L** | **🔴 HIGH** | The CASL consent record. See below. |
| B | M | 🟠 medium | `phone_hash` is an unmade decision, not a transcription. |
| C | M | 🟡 low-medium | Mostly mechanical; the empty-week counter is state a bug could corrupt quietly. |
| D | S | 🟢 low | Analytics only; failures are already swallowed by design. |

**Stage A is where the scrutiny belongs, and not because it is hard.** It writes the row a CASL
complaint is answered from. Three specific things:

- **The upsert is not an insert.** `sms_consent` has a UNIQUE index on `phone_number`, so a plain
  INSERT raises 23505 for a parent fixing a typo, a stopped subscriber returning, or a double-tap.
  Re-stamping `consent_timestamp` and `consent_text_version` is the *point* — a resubmission is a
  fresh act of express consent — and clearing `confirmed_timestamp`/`stopped_at` puts them back at
  the start of the double opt-in. Getting this subtly wrong produces a consent record that says
  something that did not happen.
- **It must never write `status = 'active'`.** Only a JOIN may (seam 3). The whole value of double
  opt-in is that nobody can subscribe a number they do not hold.
- **`applyConsentChange` now has a compare-and-set** (round 18): `WHERE id = $1 AND status = $n`,
  returning rows-affected so a lost race reports `already_in_state` rather than a second welcome
  text. That contract is written and tested against a stub; it has never run against a real
  concurrent transaction.

---

## 5. What I would want decided before writing any of it

1. **🔴 `phone_hash` — the only genuinely unmade decision.** `0035` requires it NOT NULL on every
   row with a `phone_hash_version`, and it is the CASL audit trail that outlives the purge. There
   is no implementation anywhere yet. It needs: a hashing construction (HMAC-SHA256 over E.164
   with `SMS_PHONE_HASH_SALT` is what the comments assume), a decision that the salt is a real
   secret provisioned by the Operator, and a documented answer to "a complaint arrives quoting a
   phone number — what do we run?" PRD §7 already flags this as unreviewed. **I would not want to
   pick the construction unilaterally** — it is the mechanism a regulator's question resolves
   through.
2. **0037's apply strategy** (§2 Gap A) — window, batches, or nullable-plus-backfill. The
   Operator's call; it changes what the migration file should say.
3. **Local test DB currency** (§2 Gap B) — is it re-seeded from a current dump, or is SMS work done
   against a different instance?
4. **Where verification happens.** I cannot run migrations, so "does this query work" is answered
   either by the Operator running something for me, or by me writing `db`-lane tests that the
   Operator runs. **I would suggest the latter**: this repo already has a `db` vitest project, and
   tests are a better artefact than a transcript of me asking someone to run `psql`.
5. **Stage A behind the existing flag?** `SMS_SIGNUP_ENABLED` already gates the route. Worth
   confirming real rows only get written where the Operator intends.

---

## 6. What this unblocks

The v1 testing cycle's single biggest finding: **the full signup → JOIN → weekly-receipt →
preferences-manage journey has never been testable end to end.** Stage A alone makes
signup → JOIN → welcome real, which is most of the value and the natural first checkpoint.

Not in scope here: the harness reply-visibility flag (already shipped), and anything about actually
sending real SMS, which stays behind `SMS_SENDING_ENABLED` and TFV regardless of what persists.
