# KIDS FUN SMS pivot — OPEN DECISIONS

**Branch:** `feat/kf-sms-pivot-draft` · **as of commit `b7f4f5a`** (rounds 1–18)
**Checked against:** PRD **v3.13** (read fresh from the project document, not from memory) and
`docs/sms-pivot-draft-feasibility-notes.md` §a–§cg.

> **What this is.** The feasibility notes are 59 sections written across eighteen rounds. That is a
> record, not a briefing. This is the short list of what is still waiting on a human, with the
> archaeology left behind a pointer.
>
> **Every item below was re-derived from the PRD and the notes.** An earlier from-memory list I
> wrote had at least three items on it that Jon had already ruled on — they are in §RESOLVED at the
> bottom rather than silently dropped, because "I thought this was open and it wasn't" is itself
> useful to whoever inherits this.
>
> ⚠ **The PRD stops at round 13.** Its own header says "round-4 through round-13 findings", and it
> contains no mention of rounds 14–18. Everything in §NEW below has never been through the
> PRD/Operator channel at all. That is the single most important thing on this page.

---

# A. NEEDS JON — product or copy decisions

## A1. The coverage swap picks a band champion and then hides it
**Blocked:** `applyCoverageSwap` appends the forced pick to the **tail** of the selection, so on a
full week it ranks 10 of 10 — and only the first 3 picks are named and linked in the text. The pick
chosen *specifically because* a child's age band had no organic match is the one pick guaranteed to
be folded into the anonymous "+N more".
**Needs:** Jon. It is a question about what the feature is *for*.
**Cost if left:** a parent of a 12-year-old gets a text naming three toddler activities and a count.
The feature's own docstring claims otherwise, so at minimum the docstring is wrong.
**Options:** (a) promote forced picks above the direct-link cutoff — costs a visible ranking change,
a lower-relevance activity displaces a higher-ranked one on every short-band send; (b) accept
"counted but not named" for MVP — zero code change, defensible if the swap exists so the *hub* shows
something for every child rather than so the *text* names one.
**Reproduced by a test** that pins current behaviour without endorsing it, so either answer is
measurable. → notes §cd

## A2. A previously-stopped number that re-signs-up gets a silent dead end
**Blocked:** Twilio 21610 on the confirmation send means the number already blocked our sender. The
form says "check your phone" and no message will ever arrive — until *they* text START, which
nothing tells them to do. Reachable by anyone who texted STOP and later signed up again.
**Needs:** Jon — it is one sentence of user-facing copy that does not exist, roughly *"text START to
+1 877-835-7776 to turn our texts back on."*
**Cost if left:** a signup that silently never completes, for the users most likely to be
re-engaging. `errorCode` is surfaced so it is at least visible in logs; nothing tells the parent.
**Note:** the PRD flagged this at v3.7 as "not urgent". Round 12 flagged it; still open. → notes §av.1

## A3. The START signup-invite copy has never been signed off
**Blocked:** round 14 originated the reply sent when someone texts START from a number with no
signup: *"KIDS FUN: We text weekly kid activity picks for Metro Vancouver. Not signed up?
https://kidsfun.ca/sms/signup / Reply STOP to end"* (127 septets, one segment).
**Needs:** Jon. Same class as the unknown-keyword reply he approved verbatim at PRD v3.11 — that one
went through the channel; this one has not, because the PRD stops at round 13.
**Cost if left:** it ships unapproved, or door 2 stays silent. It is the only message that can reach
somebody with no record of us at all.
→ notes §be

## A4. A TFV filing needs a real domain
**Blocked:** `kidsfun.ca` does not point at this Vercel project (PRD v3.12 correction), and the
`.vercel.app` address is staging-only and not fit for the filing's `BusinessWebsite` field. Jon
asked the Operator to recommend rather than decide; the Operator's shortlist was checked live and
available at the time: `kidsfunapp.ca`, `getkidsfun.ca`, `trykidsfun.ca`, `mykidsfun.ca`,
`kidsfunapp.com`.
**Needs:** Jon — pick one and register it.
**Cost if left:** **the Toll-Free Verification filing cannot proceed**, and TFV lead time is itself
an unverified launch gate (PRD §7). This is the critical path.
→ PRD v3.13

---

# B. NEEDS THE OPERATOR — configuration and credentials, not decisions

## B1. START must be configured as a custom inbound keyword
**Blocked:** Twilio's default handling of START may be a canned carrier-level auto-reply that never
reaches our webhook. PRD §1.4 has said "must be explicitly configured and verified, not assumed"
since round 1.
**Needs:** Operator — a Messaging Service console change, then a test against a real Canadian
toll-free number.
**Cost if left:** **round 14's entire START branch is dead code and no test of ours can tell us** —
the failure is in Twilio's console, not the repo. Door 2 of PRD §2.1's three doors silently does not
work. If Twilio's canned reply *also* fires, subscribers get two messages.
**This became load-bearing in round 14** — it was tidiness before that. → notes §bh

## B2. `SMS_STATUS_CALLBACK_URL` needs provisioning
**Blocked:** round 16's real Twilio integration sends this as `StatusCallback` on every message and
verifies the delivery-status webhook's signature against the same value. Documented in
`.env.example` and `config.ts`; not set anywhere.
**Needs:** Operator. **Not a decision** — a value and a console field.
**Cost if left:** sends still work; `sms_send_log.delivery_status` never fills in, so there is no
record of what the carrier actually did with any message. → notes §bq.6

## B3. Web unsubscribe never reaches Twilio's suppression list
**Blocked:** a web-initiated unsubscribe correctly writes our own state but makes no Twilio API
call, so it lacks the carrier-level backstop a texted STOP has.
**Needs:** Operator — needs a live credential this branch does not hold.
**Cost if left:** a buggy send job could text someone who unsubscribed on the web, with nothing at
the carrier layer to stop it. → PRD §7 (round 8)

## B4. No rate limiting on `POST /api/sms/preferences`
**Blocked:** the token is a full-width HMAC so brute force is not realistic, but "nothing stops
unlimited attempts" is the honest state.
**Needs:** Operator — most likely platform-level (Vercel/WAF) rather than app code.
**Cost if left:** low today, because no real preferences links exist yet. **Worth closing before
they do, not after.**
**Related and deliberately ranked lower:** the inbound webhook's unknown-keyword reply is
signature-gated, so the realistic risk there is an accidental auto-reply loop with another automated
system, not abuse — a per-number cooldown needs a table the PRD already declined for MVP.
→ PRD §7 (round 8), notes §bb

## B5. `SMS_PHONE_HASH_SALT` has no owner, and its absence fails SILENTLY
**Blocked:** nothing. It is documented in `.env.example:78` and has simply never appeared on this
page, unlike every other production value. Found while checking this list against what a live send
actually needs, not by anything failing.
**Needs:** Operator — a generated secret in the production environment. **Not a decision** — a
value. It must be generated ONCE and never rotated casually: `sms_send_log.phone_hash_version`
exists precisely because rotating the salt makes every historical hash unmatchable.
**Cost if left:** **the weekly send succeeds and the CASL audit trail silently does not get
written.** Traced, in order:

| where | what happens |
|---|---|
| `weekly-send-io.ts:539` | the Twilio dispatch runs FIRST — the text is already gone |
| `send-log.ts:95-96` | `phoneHash()` returns null, so `recordSmsSend` throws `MissingPhoneHashSaltError` |
| `weekly-send-io.ts:586` | the audit write is wrapped in `bestEffort(...)` |
| `bestEffort` | `try { await write() } catch { }` — **a bare catch. No logging, no metric.** |

So with sending enabled and no salt: every weekly text goes out and no `sms_send_log` row is ever
written, with no error anywhere. `phone_hash` is `NOT NULL` and migration 0035 calls it the CASL
audit trail "retained INDEFINITELY" — so the failure is *we texted Canadians at scale and kept no
record that we did*. It surfaces as a complaint, not an alarm.

**There is no pre-flight.** `config.ts:225`'s `phoneHashSalt()` returns null and nothing validates
it before a send — no startup check, no cron guard. The only detection is the reactive throw that
`bestEffort` then swallows.

**Unreachable today** only because `SMS_SENDING_ENABLED` has never been set. It becomes reachable
on exactly the day the Operator flips it — the day nobody is re-reading this page.

**A CODE FIX WAS PROPOSED AND IS NOT APPROVED.** Making the weekly send refuse to dispatch when the
salt is absent is ~5 lines, and it is a deliberate behaviour change rather than a bug fix: the
argument cuts both ways. `bestEffort` exists so that bookkeeping cannot break a subscriber's week,
which is correct for a transient database blip. A missing secret is not transient — it fails
identically on every send forever, and "no audit trail" is arguably the one bookkeeping failure
worth stopping a send for. **That is a judgement about what happens to a real subscriber, so it
belongs to the Operator or Jon, and the code has deliberately been left alone.**

---

# C. NEEDS NEITHER — recorded so nobody re-derives them

- **`applied` bundles two unlike situations.** `decideStart` returns `applied` for both
  `stopped → active` (Twilio already sent its own resubscribe confirmation) and `paused → active`
  (Twilio said nothing, so the parent's texts silently resume with no acknowledgement). The route
  cannot tell them apart — `TransitionResult` carries the target status, never the prior one.
  Uncommon path; a fifth piece of copy and a widened result if anyone wants it. → notes §bg
- **An emoji-only or empty inbound body gets the unknown-keyword reply.** A thumbs-up normalises to
  empty and classifies as `unknown`, so a happy subscriber gets "Sorry, we didn't catch that."
  Arguable; named as the first lever to pull if it reads badly or a reply loop appears. → notes §bc
- **Twilio's `numSegments` is never compared against our own estimate.** Would make a segmentation
  surprise visible on the first real send. Cheap follow-up; widens `DispatchResult`. → notes §bq.6
- **No retry anywhere.** A failed dispatch is logged and left. Consistent with the existing design —
  but "real Twilio integration" should not be read as "resilient". → notes §bq.6
- **The 16 KiB inbound payload cap is enforced after the body is buffered.** Defence-in-depth gap,
  almost certainly bounded by the platform's own request limit first. Closing it means streaming the
  body, and both webhooks' correctness rests on reading the raw body exactly once for signature
  verification. → notes §ce
- **`sendWeeklySmsBulk`'s own loop has no direct test** (its per-subscriber unit now does).
- **Novelty lookback is 1 send**, deliberately conservative because a longer window in a sparse
  municipality can itself trigger the 3-empty-weeks auto-pause. V1 tuning with real data.
  → PRD §3 item 14
- **Registration-duration detection is a title-vocabulary approximation.** The durable fix
  (`activity_series.recurrence_rule`) is shared-search-infrastructure work this branch has never
  touched. → PRD §3 item 12
- **Five smaller round-8 risks** stand unchanged in PRD §7: `consent_method` cannot distinguish a
  web-unsubscribe from a STOP-text; `preferences_token` width not independently confirmed as full
  HMAC; no UI to rotate a leaked preferences link; salted `phone_hash` approach not yet reviewed
  against a real complaint scenario; CTR reads low in heavy-archiving weeks (a schema fact, not a
  bug).
- **`link_origin` is spoofable via `?via=hub`.** Accepted on the record: the blast radius is one
  column of one analytics row, the token is a separate signed path segment, and only somebody
  holding valid tokens can do it. → notes §bl

---

# D. RESOLVED — listed because I expected them to be open and they are not

Each of these was on a from-memory list before it was checked against PRD v3.13.

| Item | Status |
|---|---|
| The `/privacy` SMS disclosures | **LIVE in production** (v3.12, commit `275c7c9`, merged into this branch in round 17) |
| Consent checkbox: 3 items vs 4 collected | **Ruled** — Jon: *"(B) Leave the checkbox as-is"* (v3.9). Policy lists four, checkbox stays at three, no version bump. |
| Immediate vs 30-day "delete my data" | **Approved** (v3.2) — a confirmed erasure request deletes immediately; the grace window exists for *accidental* STOP. |
| Confirmation-request HELP text | **Ruled and shipped** (v3.13 → round 16). Measured at 153/160 septets worst case, one segment. |
| Unknown-keyword reply copy | **Approved verbatim** (v3.11) — matches the implementation exactly. |
| Twilio HELP-text console config | **Done by Jon directly** (v3.10). |
| TFV `NotificationEmail` | **Resolved** (v3.4). |
| CASL support contact | **Resolved** (v3.1) — the toll-free number itself. |
| §8 Q1 registration / Q2 novelty / Q3 "activity gone" copy | **All ruled** (v3.0, v3.1). |
| The module-graph coupling flagged in round 12 | **Done** in round 16 — `twilio-client.ts` + `send-log.ts`. |
| The concurrent-transition race flagged in round 17 | **Fixed** in round 18 on the shared contract, all three transitions. |

---

# E. One process note for whoever inherits this

**Rounds 14–18 are not in the PRD.** Everything in §A3, §B2, §A1 and most of §C reached only the
delegating agent, whose reports to the Operator lineage have been held across several unconfirmed
rotations. If the PRD is the source of truth for what Jon has seen, then five rounds of work —
including a real Twilio integration, a live credential leak fixed, and four QA-found defects — are
invisible to it.

That is a reporting-channel gap, not an engineering one. It is the first thing a new Operator should
close.
