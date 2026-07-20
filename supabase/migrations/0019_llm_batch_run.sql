-- 0019_llm_batch_run.sql — state + audit for the nightly LLM-assisted batch job
-- (T14-2 fuzzy dedup adjudication, T13-5 age-parse fallback; TSD §5.2).
--
-- Two tables, both service-role only. They are locked down IN THIS MIGRATION with the
-- same default-deny posture as 0017_weekly_email_send.sql / 0018_public_tables_default_deny_rls.sql
-- (ENABLE RLS with no policies + REVOKE ALL from anon/authenticated — see the lockdown
-- block after the indexes below). They are read/written exclusively through the service
-- pool by the nightly run route (DATABASE_URL owner, which BYPASSES RLS by design), and
-- must NEVER be reachable on the anon/authenticated Supabase REST surface.
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

-- ── lockdown: default-deny RLS + REVOKE (service-role only) ────────────────────
-- Same two-barrier posture as 0017_weekly_email_send.sql / 0014_admin_rls.sql /
-- 0018_public_tables_default_deny_rls.sql. These are ops/audit tables touched ONLY by
-- the nightly job's service-role pool (DATABASE_URL owner — bypasses RLS by design), so
-- every legitimate app path is unaffected; anon/authenticated get NO access at all:
--   • ENABLE RLS with NO policies  → default-deny for every RLS-subject role; and
--   • REVOKE ALL default table grants → the deny also holds at the privilege layer.
-- Without this, Supabase's default public grants (emulated in local/CI by the auth stub's
-- ALTER DEFAULT PRIVILEGES) would leave both tables wide open — anon could read the audit
-- trail + watermark, and any authenticated user could tamper the watermark (skip-all /
-- force-replay = DoS) or forge/delete audit rows — the exact "unlocked public table"
-- class Round 20 F-1 found and 0018 remediated, and it would defeat the whole point of
-- llm_batch_decision being the reviewable trail behind an irreversible auto-merge.
ALTER TABLE llm_batch_run      ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_batch_decision ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON llm_batch_run      FROM anon, authenticated;
REVOKE ALL ON llm_batch_decision FROM anon, authenticated;

-- ── rollback (reversible) ─────────────────────────────────────────────────────
-- Dropping the tables removes their RLS state + grants with them; no separate revert
-- of the lockdown is needed.
--   DROP INDEX IF EXISTS idx_llm_batch_decision_target;
--   DROP INDEX IF EXISTS idx_llm_batch_decision_job;
--   DROP TABLE IF EXISTS llm_batch_decision;
--   DROP TABLE IF EXISTS llm_batch_run;
