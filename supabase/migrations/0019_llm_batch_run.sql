-- 0019_llm_batch_run.sql — state + audit for the nightly LLM-assisted batch job
-- (T14-2 fuzzy dedup adjudication, T13-5 age-parse fallback; TSD §5.2).
--
-- Two tables, both service-role only (RLS default-deny via 0018's public-tables sweep
-- is NOT applied here because these are ops tables never exposed on the anon/auth REST
-- surface — they are read/written exclusively through the service pool by the nightly
-- run route, the same posture as analytics_event's maintenance path).
--
--   llm_batch_run       — one row per job_name; the INCREMENTAL WATERMARK. The job only
--                         reconsiders records changed since last_watermark, so a re-run
--                         with no new/changed data does no work (idempotent, no full
--                         re-scan). Mirrors the "stamp on write, act on the delta"
--                         discipline of analytics_event.retained_until (0006).
--   llm_batch_decision  — an append-only audit trail of EVERY adjudication the job made
--                         (auto-merge / routed-to-review / skipped-low-confidence /
--                         errored). admin_audit_log cannot be used: its admin_user_id is
--                         NOT NULL + FK to admin_user (0007), and a SYSTEM job has no
--                         admin identity. This table is the system-level equivalent so an
--                         auto-merge (which archives a duplicate occurrence) is never a
--                         silent, untraceable mutation — it is reviewable and reversible.
--
-- Src: TSD v1.2 §5.2 (deterministic-first, LLM fallback + dedup keys/adjudicate/merge),
-- scope-to-task v1.1 §C (T14) / §B (T13). Deps: 0004_activities (activity_occurrence).
-- Forward-only; reversible steps recorded below.

-- ── forward ──────────────────────────────────────────────────────────────────

-- Per-job incremental watermark. job_name is the stable key (e.g. 'llm_dedup_adjudication',
-- 'llm_age_fallback'). last_watermark is the high-watermark of the record "change time"
-- (greatest(created_at, last_checked_at)) processed by the last SUCCESSFUL run; the next run
-- only considers records whose change time is strictly greater.
CREATE TABLE IF NOT EXISTS llm_batch_run (
  job_name          text PRIMARY KEY,
  -- '-infinity' so a first run considers all currently-eligible records.
  last_watermark    timestamptz NOT NULL DEFAULT '-infinity',
  last_run_at       timestamptz,
  last_status       text,                       -- 'ok' | 'dry_run' | 'error' | 'disabled'
  records_considered integer NOT NULL DEFAULT 0,
  records_actioned   integer NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Append-only decision log (system audit for the LLM-assisted adjudications).
CREATE TABLE IF NOT EXISTS llm_batch_decision (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name       text NOT NULL,
  use_case       text NOT NULL,                 -- 'dedup' | 'age'
  -- The primary record this decision is about (a duplicate-candidate occurrence, or the
  -- occurrence whose age was being resolved). No FK: decisions must survive the record's
  -- later archival/deletion so the audit trail is durable.
  target_id      uuid NOT NULL,
  -- The other occurrence in a dedup pair (the surviving canonical), else NULL.
  related_id     uuid,
  custom_id      text NOT NULL,                 -- the batch request custom_id (traceability)
  action         text NOT NULL,                 -- 'auto_merge' | 'route_to_review' | 'skip_low_confidence' | 'apply' | 'no_op' | 'error'
  deterministic_score double precision,         -- e.g. trigram title similarity for dedup
  llm_confidence      double precision,         -- model-reported confidence [0,1]
  detail         jsonb,                          -- compact, PII-free rationale/inputs
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_batch_decision_job ON llm_batch_decision (job_name, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_batch_decision_target ON llm_batch_decision (target_id);

-- ── rollback (reversible) ─────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS idx_llm_batch_decision_target;
--   DROP INDEX IF EXISTS idx_llm_batch_decision_job;
--   DROP TABLE IF EXISTS llm_batch_decision;
--   DROP TABLE IF EXISTS llm_batch_run;
