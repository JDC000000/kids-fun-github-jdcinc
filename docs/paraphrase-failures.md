# Paraphrase failures

A failure mode that bit five times on 2026-09-01, in five different kinds of artifact, and was
invisible each time until someone compared the paraphrase against the thing.

## The rule

**When something is standing in for a specific original — a requirement, a defect, a production
data shape, a check — reproduce it verbatim rather than describing it.**

A paraphrase preserves what was salient to whoever wrote it and silently drops what wasn't. That
dropped part is where the defect lives *by construction*: if it had been obviously important, nobody
would have paraphrased over it.

The useful question when reviewing your own work is therefore **not** "what did I change?" but:

> **What did I not think worth preserving?**

## The five instances

Each is linked rather than summarised, on purpose. Summarising them here would be the same mistake
in the same document — the specifics are what make them recognisable next time.

| # | Artifact | The paraphrase | What it dropped |
|---|---|---|---|
| 1 | Consent copy — `lib/sms/consent-copy.ts` | *"…to choose **only** those activities"*, proposed as a fix for a draft that dropped "only" | It contained the word and scoped it to the wrong noun — **which activities**, not **the data's purpose**. PRD §1.3 needs the second. |
| 2 | A regex — `tests/sms/signup_copy.test.ts` | Restating `/only to/` as "must contain the word only" | `/only to/` constrains **grammatical attachment**, not keyword presence. The restatement would have passed instance 1. |
| 3 | Test fixture — the admin-hang investigation | A synthetic `analytics_event` standing in for production's | **Four separate dimensions, found one at a time by being wrong** — see below. |
| 4 | A mutant — `lib/db/client.ts` | Described as "a mutant using bare `SET`" | It also deleted `BEGIN`/`COMMIT`, so it tested "transaction removed" — a **different** regression that the old test did catch. The real one (`SET LOCAL` → `SET`, transaction kept) passed cleanly. See `tests/analytics/trend-query-db.test.ts`. |
| 5 | A safety check — `tests/sms/inbound_route.test.ts` | Grepping for **import paths** before a whole-file string replace | A comment referencing a test file is neither an import nor a URL. The replace corrupted `signup_persistence-db.test.ts` into a path that does not exist. |

Note that #5 is the guard itself. **A paraphrased check reports success**, which is the worst
placement available for this failure.

## The fixture, in detail: four axes, none of them obvious in advance

Instance #3 was wrong four times, and each time the wrongness was invisible until a measurement
disagreed with production. This is the list a synthetic reproduction has to match:

| Axis | How it was wrong | What it cost |
|---|---|---|
| **Size** | 200k rows vs production's 1.19M | A false negative — 5.7ms — that made me discard a correct hypothesis. |
| **Per-entity shape** | Sessions recurring across 24.2 days; real ones average **1.0** | Biased a comparison *toward* "the restructure doesn't help", which would have blocked the right fix. |
| **Temporal concentration** | Events spread over 70 days; production's sit inside ~30 | Hid a sort spill entirely, then later understated a query's cost by **an order of magnitude** (44.9s measured, >600s real). |
| **Value width** | 8-character session ids vs production's ~36 | Under-reported a disk spill as 41MB against production's 237MB. *(Inferred, not measured — flagged as such.)* |

Three of the four made things look **better** than reality, which is the dangerous direction: a
fixture that flatters the code produces confident, wrong all-clears.

There is no reason to think this list is complete — and it wasn't. A fifth arrived later, and it is
a different KIND of mistake from the four above.

### The fifth is not about matching production at all

The four above are all "the fixture didn't resemble production closely enough", and each is fixable
in principle by building a better fixture. This one isn't:

> **One fixture was used to answer two different questions, and it was only valid for one of them.**

A fixture was built with deliberate timestamp ties — 110,653 tie groups — because ties were the
correctness risk in a window-function rewrite, and a fixture without them could not exercise the
edge case at all. **It was exactly right for that question.**

The same run was then used to measure performance, and reported at **7.1s**. The real figure on
realistic data was **35.9s** — slower than the code being replaced. **The very property that made
ties exercisable (few distinct timestamps per session) also made the `GROUPS` window frame cheap to
evaluate**, because such a frame advances once per peer group rather than once per row.

So the fixture was simultaneously the right instrument for correctness and a broken instrument for
timing, on the same data, in the same run. No amount of making it "more realistic" resolves that —
realism for the tie question and realism for the timing question point in **opposite** directions.

    Rule: a fixture is built to answer a question, not to be realistic in general.
          Before reusing one for a second question, ask what property you engineered
          into it, and whether that property is load-bearing for the new question too.

This is the only entry here that was caught by turning someone else's diagnostic technique
(`pg_stat_activity` sampling) on one's own delivery rather than on the code under investigation.

## Adjacent: the same shape in measurement, not description

Not strictly a paraphrase — worth recording because it is the same *mechanism* one step over, and
because it nearly cost real time.

**Comparing two query variants across two separate runs.** The old and new spellings of a rewritten
KPI query returned `dau 299` and `dau 305`, a 2% discrepancy that looked like a correctness bug in
the rewrite. It was `now()` advancing between the two executions: rows crossed the 1-day window
boundary in between. Re-run inside a **single transaction**, both returned `293 / 1701 / 6563`
exactly.

    Rule: compare variants under one clock. Two runs of "the same thing" are not the same thing.

The connection to the rest of this document: *two executions* were standing in for *a controlled
comparison*, and they differed in the one dimension nobody had thought to hold fixed. Same failure,
different medium — and had the discrepancy been larger it would have been investigated, while at 2%
it was small enough to explain away.

## Why measurement is not immune

Instances 3 and 5 are the ones worth re-reading. Both *looked* like verification. A reproduction has
to match production in **size and in shape** — #3 got size right on the second attempt and shape
wrong — and a guard has to test the property you need rather than the category you happened to think
of.

## The pattern-break worth keeping too

Not everything that session went this way, and the exception is instructive. The
"stale statistics after index creation" hypothesis was **killed cleanly by measurement**: run
`ANALYZE analytics_event`, re-time the queries, observe no material change (1186 → 1186 ms), done.
No paraphrase, no ambiguity, no lingering "probably not it".

That is what the good case looks like, and it is worth being able to recognise: a hypothesis stated
precisely enough that one measurement can end it. The five failures below all share the opposite
property — each was stated in a way that *sounded* checkable while the thing actually checked was
something else.

## Related

`docs/migration-drift.md` — the same theme in a different register: a migration file existing in the
repo and the object existing in the database are two different facts.

**Project document: _"Process lesson: paraphrase-vs-actual-thing verification failures
(2026-09-01)"_** (KIDS FUN project docs) covers the same five instances as a session narrative,
with the collaboration context this file deliberately leaves out.

⚠ **Two records of "descriptions drift from the things they describe" can themselves drift apart.**
They are kept separate on purpose — this file is indexed to source paths that move with the code,
the project document is a narrative that does not — so **update whichever matches what changed, and
do not silently let one become the stale copy of the other.**
