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
| 3 | Test fixture — the admin-hang investigation | Synthetic `analytics_event` with sessions recurring across 24.2 days | Real sessions average **1.0 day**. The distortion biased the comparison *toward the wrong conclusion* — "the restructure doesn't help" — which would have blocked the correct fix. |
| 4 | A mutant — `lib/db/client.ts` | Described as "a mutant using bare `SET`" | It also deleted `BEGIN`/`COMMIT`, so it tested "transaction removed" — a **different** regression that the old test did catch. The real one (`SET LOCAL` → `SET`, transaction kept) passed cleanly. See `tests/analytics/trend-query-db.test.ts`. |
| 5 | A safety check — `tests/sms/inbound_route.test.ts` | Grepping for **import paths** before a whole-file string replace | A comment referencing a test file is neither an import nor a URL. The replace corrupted `signup_persistence-db.test.ts` into a path that does not exist. |

Note that #5 is the guard itself. **A paraphrased check reports success**, which is the worst
placement available for this failure.

## Why measurement is not immune

Instances 3 and 5 are the ones worth re-reading. Both *looked* like verification. A reproduction has
to match production in **size and in shape** — #3 got size right on the second attempt and shape
wrong — and a guard has to test the property you need rather than the category you happened to think
of.

## Related

`docs/migration-drift.md` — the same theme in a different register: a migration file existing in the
repo and the object existing in the database are two different facts.
