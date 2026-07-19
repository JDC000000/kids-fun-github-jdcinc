# KIDS FUN — Probabilistic → Deterministic (P→D) Token-Optimization Audit

**Scope-to-task:** G-T38-3 (Probabilistic→Deterministic audit — log P→D savings) · **Round 19 / Task DD** · **AUDIT + REGRESSION-LOCK**
**Date:** 2026-07-19 · **Branch:** `overnight/t38-token-opt-brand-verify` (off `main@7be828c`)
**Milestone:** M6 · **Deps:** G-T13-5, G-T14-2 (per scope-to-task v1.1 §T38)

> **Bottom line.** As of `main@7be828c` the KIDS FUN application makes **zero
> runtime LLM / probabilistic API calls.** Every ingestion, search, dedup,
> age-normalisation and email-selection path that the canonical scope flagged as
> potentially probabilistic (`(P)`) is **already deterministic** — either built
> deterministically from the start or deferred behind a deterministic-first layer
> that resolves the common cases with rules and only *reserves* an LLM fallback
> for genuinely ambiguous input that does not yet flow through any model. The
> "P→D migration" this task audits has, in effect, **already happened by design**.
> Nothing in this round *needs* migrating; the token savings are structural and
> banked. This document is the audit + rationale + a small verification note.

---

## 0. Method

1. **Dependency scan.** `package.json` (root) and `worker/package.json` — grep for
   any LLM SDK (`openai`, `anthropic`, `@ai-sdk`, `langchain`, `cohere`,
   `replicate`, `huggingface`, `transformers`). **Result: none present.**
2. **Runtime-call scan.** Repo-wide grep for `api.openai` / `api.anthropic` /
   `chat.completions` / `messages.create` / `new OpenAI(` / `new Anthropic(` /
   `generateText` / `createEmbedding` / `temperature` / `max_tokens`.
   **Result: no runtime LLM call sites anywhere in `app/`, `lib/`, or `worker/`.**
3. **Scope cross-reference.** The three atomic tasks the canonical
   `scope-to-task-v1.1` marks `(P)` and lists as this task's deps — **G-T13-5**
   (LLM free-text/OCR normalise fallback), **G-T14-2** (fuzzy dedup conflict
   adjudication), **G-T30-2** (probabilistic email content selection) — plus the
   two adjacent `(P)` items **G-T14-2**'s sibling and **G-T17-1** (seed alias
   authoring) were each traced to their current implementation state in code.
4. **Deterministic-win inventory.** Located the places where a deterministic
   design *replaced or pre-empted* a probabilistic one, and recorded the rationale
   the code itself documents.

All findings below are grounded in the code as it stands, with file references.

---

## 1. The four canonical `(P)` steps — current status in code

`scope-to-task-v1.1` §Legend explicitly isolates **four genuine LLM steps** (its
own summary, line 1373): *"T13-5 free-text normalise, T14-2 dedup adjudication,
T17-1 alias authoring, T30-2 email selection — each carries a prompt template +
model/params + eval rubric. Everything else is D/H with deterministic
verification."* Here is where each one actually stands:

| Scope ID | `(P)` intent | **Status in `main@7be828c`** | Token cost today |
|---|---|---|---|
| **G-T13-5** | LLM normalise/classify fallback for OCR/PDF/free-text age & category | **Not invoked.** A deterministic-first normaliser (`worker/core/age.ts`, Round 13 / Task J) resolves the common wordings by rule; ambiguous text is left **unresolved** (null bounds, raw kept in `age_notes`) as a clean future worklist — *not* sent to a model. The provenance enum reserves `'llm_normalised'` (`worker/core/provenance.ts:11`) but **nothing ever sets it** (`factOrigin ?? 'source'`). | **0** |
| **G-T14-2** | Fuzzy conflict adjudication when pg_trgm similarity is high but merge keys disagree | **Not built.** Only the deterministic **schema hook** exists — `activity_occurrence.dedup_key` + unique index (`supabase/migrations/0015_occurrence_dedup_key.sql`), explicitly annotated *"the deterministic dedup ENGINE remains out of scope here … dedup_key is intentionally unused until the T14 cross-source dedup workflow is implemented."* Same-source idempotency uses a deterministic `(series_id, source_record_id)` key (`worker/core/upsert.ts`). | **0** |
| **G-T30-2** | "Light probabilistic ranking" of weekly-digest email content | **Implemented deterministically.** `lib/email/digest.ts` is a **pure** function that reuses the real deterministic search pipeline (`SearchEngine`) with a deterministic pre-filter (radius + age + the saved search's own stored params), broadening disabled (`minResults: 0`) so it never pads with non-matches. No model ranks the content. | **0** |
| **G-T17-1** | Author the seed alias/synonym dictionary (one-time LLM authoring aid) | **Deterministic at runtime.** Alias expansion reads a DB table (`synonym_alias`) through `lib/search/postgres-alias-resolver.ts`; any LLM help in *authoring* the seed list was a one-time offline design aid, not a runtime dependency. Live expansion is a table lookup with a 60 s in-process TTL cache. | **0** |

**Net:** all four `(P)` steps cost **zero tokens at runtime today.** Three are
genuinely deterministic; one (T13-5) keeps an LLM *option* in reserve for a narrow
residual (ambiguous free-text) but does not exercise it.

---

## 2. Deterministic wins already banked (the P→D migrations that happened by design)

These are the cheap-and-safe wins the scope's *Token-Optimization principle*
("deterministic-first mapping", scope AC on G-T13-1) asked for. They are already
in `main`:

### 2.1 Deterministic age-band normaliser — **Round 13 / Task J** (verified)
`worker/core/age.ts`. Resolves free-text age wording ("ages 0-2", "toddler time",
"grades K-3", "5+", "under 5", "all ages") into a structured
`[age_min_months, age_max_months)` range and the overlapping seeded bands, using
**regex/keyword rules only — no external calls, no credential, no migration**. Its
own header states it is *"the DETERMINISTIC-first half of §5.2's 'deterministic-first,
LLM-fallback' boundary"* and *"leaves genuinely ambiguous text UNRESOLVED … as a
clean worklist for the future, credential-gated LLM-fallback."* Covered by
`tests/ingestion/age.test.ts` (pure-rule cases run everywhere; DB wiring/idempotency
case gated on `DATABASE_URL`). **This is the canonical, verified P→D win.**
*Savings:* every ingested occurrence's age facet is derived by rule instead of an
LLM call — at listing volumes this is the single largest avoided-token line item,
and it removed the need for an LLM credential in the ingest worker entirely.

### 2.2 Deterministic fuzzy matching via pg_trgm (not an ML similarity model)
`lib/search/text/trigram.ts` reproduces Postgres `pg_trgm`'s Jaccard trigram
similarity (`|A∩B| / |A∪B|`) exactly, and `lib/search/match.ts` builds a
`ts_rank`-like relevance over weighted fields with a trigram **fuzzy fallback**
for typos/partials ("opengym" → "open gym"). This is the kind of "fuzzy" behaviour
that is often reached-for with embeddings; here it is a **deterministic set
computation** that mirrors what the SQL `similarity()`/`%` operator will do in
production. *Savings:* typo tolerance and partial-match ranking with **no embedding
model and no vector store.**

### 2.3 Deterministic text normalisation
`lib/search/text/normalize.ts` — lowercase, NFKD + diacritic strip, punctuation
collapse, compact English stop-list — mirrors Postgres FTS so fixture results track
live results. Pure, deterministic, shared by parser and matcher.

### 2.4 Deterministic alias / "parent-language" expansion
`lib/search/expand.ts` + `lib/search/postgres-alias-resolver.ts` — greedy-phrase
synonym expansion from an operator-maintained DB table, cached in-process. Query
understanding without a per-query model call.

### 2.5 Deterministic dedup key hook
`supabase/migrations/0015_occurrence_dedup_key.sql` — reserves the deterministic
cross-source merge key so that when T14 is built, the **keys/merge** path is
deterministic and only genuine key-collisions-with-conflicting-values would ever
need adjudication (and even then, pg_trgm similarity gates it before any model).

---

## 3. Remaining P→D opportunities (documented, **not** actioned this round)

Per this task's guidance ("if in doubt, just document the opportunity rather than
touching the code"), the following are logged as *future* opportunities. **None was
migrated in this round** — there is no live probabilistic call to migrate, so any
change here would be net-new code, out of this audit's scope.

| # | Opportunity | Assessment | Recommendation |
|---|---|---|---|
| O-1 | **T13-5 residual free-text normaliser.** The `age.ts` "unresolved" bucket is the only place an LLM is even contemplated. | Most residual strings are long-tail oddities. Each new deterministic rule added to `KEYWORD_BANDS` / the range regexes shrinks the bucket further and is trivially unit-testable. | **Prefer growing the deterministic rules** over standing up an LLM fallback. Only reach for a model if the unresolved bucket proves both large *and* irregular in production telemetry. Keep it credential-gated and deterministic-pre-filtered if ever built. |
| O-2 | **T14-2 fuzzy dedup adjudication.** Not yet built. | When implemented, the deterministic `dedup_key` + pg_trgm gate should adjudicate the overwhelming majority. | **Build keys/merge deterministically first**; scope any LLM adjudication to the strict residual (high similarity + conflicting keys) and measure the residual rate before adding a model. |
| O-3 | **T30-2 email ranking.** Currently deterministic (search-pipeline reuse). | The scope allowed "light probabilistic ranking (Claude fast tier, temp 0.2, ~500 tok) after a deterministic pre-filter." The deterministic version already produces relevant, non-padded results. | **Keep deterministic.** Revisit only if engagement data shows deterministic ordering underperforms; the pre-filter must always precede any P step. |
| O-4 | **Provenance `'llm_normalised'` enum value.** Reserved but unused. | Harmless; documents intent. | **Leave as-is** (a reserved value, not a live path). Its presence should not be read as an active LLM dependency. |

---

## 4. Savings summary

- **Runtime LLM token spend today: 0.** No model is called on any request or ingest
  path.
- **Credentials avoided:** the ingest worker needs **no** LLM credential because age
  normalisation is rule-based (§2.1). This also removes an entire class of
  secret-management, rate-limit, latency and PII-egress concerns from the hot path —
  material for a kids' product handling child ages.
- **Determinism dividend:** because matching/normalisation/dedup are deterministic,
  they are **exhaustively unit-testable against fixtures** (see `tests/ingestion/age.test.ts`,
  `tests/search/*`), CI-verifiable, and reproducible — the "deterministic verification"
  the scope's Token-Optimization principle is really after.
- **What a naive design would have spent:** an embeddings-per-listing + LLM-normalise-
  per-record + LLM-rank-per-email design would incur model tokens on **every** ingest
  and **every** digest. All of that is avoided structurally.

---

## 5. Verification note (this round)

- **Audit** is read-only over `main@7be828c`; **no product code was migrated** — there
  was no live probabilistic call to migrate, and inventing one would exceed this
  audit's low-risk scope.
- The **companion regression test** `tests/ui/brand-tokens.test.ts` (this same round,
  G-T38-5) is unrelated to P→D but ships alongside; it locks in Round 18 / Task Y's
  AA-contrast fixes. See that file's header for its own verification.
- **PIPEDA / retention (G-T38-2) is explicitly NOT in this dispatch.** It involves real
  child-data privacy/legal-compliance judgement (child ages + home postal codes) and is
  being raised to Jon as a separate item, per the project's standing rule that
  legal/privacy-compliance calls are flagged rather than silently built. If future P→D
  work touches personal-data flows, route the privacy question to a human first.

---

*Audit performed by Developer Ops (delegated stream, Round 19 / Task DD). Self-verified,
not merged — independent QA follows.*
