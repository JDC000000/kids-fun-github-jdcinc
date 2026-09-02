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
(`pg_stat_activity` sampling) on one's own delivery rather than on the code under investigation —
diagnostic tool and target were the same person.

**That is weaker evidence than it sounds, and worth stating precisely.** It was caught, but only
*after it shipped and was reported as a success*. A reviewer running the same profile against a
realistic fixture would have caught it before it landed. So this entry shows self-review can find a
mistake nobody else has noticed yet; it does not show self-review is a substitute for the other
kind. The order matters: every other entry here was caught before or during delivery, and this one
was not.

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

## Adjacent: verifying the wrong property entirely

The five above are descriptions drifting from things. This one is different again, and no axis in
this document would have caught it.

**A window-function rewrite was verified correct three separate ways** — byte-identical output
across 16 columns and 30 periods, tie semantics pinned by committed behavioural tests, a structural
guard against the frame being weakened. **Nobody ever asked what it cost.** It was 37.7s, against
18.3s for the correlated-subquery version it replaced. The optimisation roughly doubled the cost of
the thing it optimised, and every check that ran came back green, because every check that ran was
about correctness.

    Rule: "verified" is not a property. Verified FOR WHAT is the property.
          Correct and unusably slow is still a defect, and a correctness suite
          will never say so.

### The mechanism, because it is not obvious and it generalises

    GROUPS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING   -- 32.9s at 1.19M rows
    RANGE BETWEEN CURRENT ROW AND <window> FOLLOWING
      EXCLUDE GROUP                                      --   255ms, same answer

**An unbounded frame that shrinks from the left cannot be maintained incrementally.** Postgres can
add rows to a running aggregate cheaply; it cannot generally remove them. So a frame whose start
advances while its end stays at the partition boundary forces recomputation per row — roughly O(n²)
within each partition. A bounded frame does not.

**The cost model for window functions bifurcates on boundedness**, and that split is invisible
unless the frame is profiled separately from what it computes. `EXPLAIN` attributes the whole cost
to one `WindowAgg` node; it does not tell you the frame shape is the reason. Two spellings that look
equally reasonable, produce identical output, and differ by more than two orders of magnitude.

## Adjacent: two true readings that disagree

Three times in one session, two people reported different values for the same thing and neither was
wrong:

| What disagreed | Why both readings were true |
|---|---|
| An untracked scratch file breaking `tsc` | It exists only between a probe writing it and the same command deleting it — minutes, for a long DB probe. |
| `analytics_event` row count, 90 vs 75 | DB tests insert marker rows and remove them in `afterAll`. Any count taken between reads high **by construction**. |
| The deployed commit hash | A rollout was in progress. One curl caught the old hash, one caught the new, five seconds apart. |

    Rule: when two people sample a mutating system at different times, the disagreement
          IS the signal. Re-read; do not defend either number.

Each of these could have become a dispute about who measured carelessly. None did, for one reason:
the readings were reported as observations with a timestamp attached rather than as settled facts.
*"90 rows, all UUID-shaped, disclosed rather than claimed restored"* reconciles in seconds.
*"The database is clean"* does not.

**The deploy case is the one worth remembering**, because there the naive reconciliation is also
wrong: comparing the deployed hash to your own commit only answers the question when nothing has
shipped since you last looked. `git merge-base --is-ancestor <commit> <deployed>` answers *"is my
change live"* directly, and it stays correct across a rollout. Likewise, `unpushed: N` says nothing
whatsoever about what production is running — the same distinction as a migration file existing in
the repo versus the index existing in the database.

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

## The one underneath all of them: a check that can only return one answer

Every failure in this document is an instance of one thing, and it took a full day of hitting
it in different costumes to see that. Naming it here so the next person gets it in one read
instead of seven.

**Two measurements agreeing is only evidence if they could have disagreed.**

From the outside, a bug that reproduces deterministically is indistinguishable from a fact
that reproduces deterministically. Both are stable, both survive a re-run, and both feel like
corroboration. Stability is not confirmation — it is only stability.

The instances, all from 2026-09-02, all found by someone asking "could this have come out
differently?":

| what looked like evidence | why it was worthless |
|---|---|
| equality check passed across 30 periods | `retained` was 0 on both sides |
| byte-identical output, two runs of a preview | same missing env var, same placeholder, every time |
| mutation testing reported a surviving mutant | the string matched a comment; the SQL was never mutated |
| a second mutant "survived" | multi-line anchor matched nothing; the mutation never applied |
| `agent-browser click` returned `✓ Done` | the element was below the fold; the click never landed |
| a structural guard on the legal footer, green for days | it read a page that 308-redirects and nobody can reach |
| a fixture proving a rewrite was correct | built for tie-handling; reused to measure timing, which it could not do |

Note what these have in common and what they do NOT. They are not sloppy. Every one was
produced by a real check, run honestly, that returned a real result. The defect is upstream of
the result: **the check was incapable of returning the other answer**, so its output carried no
information regardless of what it said.

### The habit that catches it

Before believing a green, ask what would have to be true for it to come out red, and confirm
that thing is reachable. Concretely, on this project that has meant:

- **Equality checks**: assert the compared quantity is non-zero on both sides. A sum of 3 across
  30 periods is technically non-zero and still discriminates nothing.
- **Mutation tests**: assert the mutation APPLIED before trusting the result. A mutation that
  does not mutate prints the same green as a guard that works.
- **Any tool reporting success**: verify the ACTION occurred, not just its consequences. A click
  counter on the element, not a screenshot afterwards — every downstream signal reads identically
  whether the click missed or the app is broken.
- **Structural guards**: check what file they actually read, and whether that file is still
  reachable. A guard that keeps passing after its subject stops mattering reads as assurance.
- **Fixtures**: state which question the fixture was built to answer, and refuse to reuse it for
  a different one. Valid for one question is not valid generally.

### Why this is worth its own section

The individual lessons above are each easy to file as "be careful". They are not the same
lesson, and "be careful" catches none of them. The operative question is narrow enough to
actually run: **could this check have produced a different answer?** If no, it is not a check —
it is a ceremony that terminates in the word "passed".

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
