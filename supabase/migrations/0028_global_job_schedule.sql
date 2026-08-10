-- 0028_global_job_schedule.sql — a durable schedule + run ledger for GLOBAL
-- (source-less) worker jobs, and the DB-level lock that keeps one from running twice.
--
-- WHY THIS EXISTS. Migration 0011 gave job_queue a `job_type` column and Unit 1 gave the
-- worker a job_type → handler dispatch (worker/core/job-handlers.ts), so a global job
-- (source_id IS NULL) can finally be EXECUTED. Nothing enqueued one: the only producer in
-- the repo is worker/scheduler/tiered.ts, which enqueues exactly one row per due SOURCE
-- (tiered.ts:88-91) and cannot express "run this every day, attached to no source". These
-- two tables are the missing producer state.
--
-- WHY NOT pg_cron. It is installed on production (v1.6.4, cron.job empty) and migration
-- 0012 already probes for it, but the standing decision on this project is
-- single-scheduler-primary and using pg_cron needs a written exception that does not
-- exist. Two schedulers that both believe they own a cadence is precisely the drift this
-- table is meant to remove.
--
-- WHY NOT A COLUMN ON job_queue. job_queue is the WORK LOG — one row per attempt, pruned
-- and dead-lettered by the queue's own policy. A schedule outlives every attempt it
-- produces and has to survive the queue being emptied (tests/ingestion/framework.test.ts
-- and tests/scheduler/job-dispatch-db.test.ts both run an unscoped `DELETE FROM
-- job_queue`). Keeping cadence state in the queue would make "when is this next due" a
-- property of a row anyone is entitled to delete.
--
-- ── THE LOCK, AND WHY IT HAS TO BE A UNIQUE INDEX ────────────────────────────────────
-- Global jobs currently get ZERO deduplication. tiered.ts's idempotence comes from
-- `NOT EXISTS (SELECT 1 FROM job_queue WHERE source_id = s.id AND status IN
-- ('pending','running'))` (tiered.ts:70-73), served by idx_job_queue_source_active — a
-- PARTIAL index ON (source_id). A global job has source_id IS NULL, so that predicate is
-- NULL-compared, that index is useless for it, and nothing anywhere stops two ticks (or
-- two worker machines) from enqueuing the same purge twice.
--
-- An application-level "check, then insert" cannot fix that: between the SELECT and the
-- INSERT another transaction does the same thing and both win. So the guarantee is two
-- UNIQUE INDEXES the database itself enforces:
--
--   idx_global_job_run_in_flight   at most ONE unfinished run per schedule, ever
--   idx_global_job_run_slot        at most ONE run per due slot, ever
--
-- The producer INSERTs the ledger row FIRST, with ON CONFLICT DO NOTHING, and only
-- enqueues the job_queue row if that insert returned one. Losing the race is then a
-- normal, silent, correct outcome rather than a duplicate purge.
--
-- ── MISSED RUNS ARE DERIVED AT READ TIME, NEVER WRITTEN ──────────────────────────────
-- There is deliberately no `missed` flag here for the worker to set. A worker that dies
-- writes nothing, and that is the exact case that matters. A reader derives the miss from
-- cadence + the ABSENCE of ledger rows in the expected window (see
-- worker/core/global-job-schedule.ts readGlobalJobScheduleHealth), which works with the
-- whole fleet dead because it only reads stored state.
--
-- ── RLS ──────────────────────────────────────────────────────────────────────────────
-- Default-deny + REVOKE, matching 0014/0017/0018: system-owned tables, written only by
-- the worker's service-level DATABASE_URL pool (which is the owner and bypasses RLS by
-- design). No policies are created; tests/rls_public_tables.test.ts enumerates every
-- public table live and would fail if this were forgotten.

-- ── forward ──────────────────────────────────────────────────────────────────

CREATE TABLE global_job_schedule (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Matches job_queue.job_type, which is free text with no CHECK (0011:13). The handler
  -- registry in worker/core/job-handlers.ts is what makes a value real; an unregistered
  -- job_type enqueued from here dead-letters loudly with UnknownJobTypeError.
  job_type                 text NOT NULL UNIQUE,
  cadence                  interval NOT NULL CHECK (cadence > interval '0 seconds'),
  -- DEFAULT FALSE is a safety default, not a formality: enabling a schedule ARMS an
  -- irreversible action, and must be a separate, deliberate, reversible operator act.
  enabled                  boolean NOT NULL DEFAULT false,
  next_run_at              timestamptz NOT NULL DEFAULT now(),
  last_run_at              timestamptz,
  last_success_at          timestamptz,
  consecutive_failures     integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  -- The circuit-breaker limit (P2). This exists because the platform scheduler does NOT
  -- break: a job on a sibling project failed 3 times against an org spend limit and kept
  -- being run on its cadence forever. After this many consecutive failed runs the
  -- schedule stops being enqueued.
  max_consecutive_failures integer NOT NULL DEFAULT 3 CHECK (max_consecutive_failures > 0),
  -- Set when the breaker trips. Clearing it is an EXPLICIT operator act
  -- (worker/core/global-job-schedule.ts resetGlobalJobBreaker, or the SQL in the
  -- operator note at the bottom of this file). Nothing in the runtime clears it — a
  -- breaker that heals itself is just a retry loop with extra steps.
  breaker_tripped_at       timestamptz,
  breaker_reason           text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER global_job_schedule_set_updated_at
  BEFORE UPDATE ON global_job_schedule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The producer's due scan. Partial on `enabled` because a disabled schedule must never
-- be a candidate and there is no reason to index one.
CREATE INDEX idx_global_job_schedule_due
  ON global_job_schedule (next_run_at) WHERE enabled;

CREATE TABLE global_job_run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id   uuid NOT NULL REFERENCES global_job_schedule(id) ON DELETE CASCADE,
  -- The job_queue row that carries this run. Nullable and ON DELETE SET NULL on purpose:
  -- job_queue is routinely truncated wholesale (see the header), and the ledger is the
  -- durable record of what was attempted — it must survive that.
  job_id        uuid REFERENCES job_queue(id) ON DELETE SET NULL,
  -- The DUE INSTANT this run satisfies: the schedule's next_run_at at the moment the tick
  -- claimed it. Deterministic, which is what makes idx_global_job_run_slot a real dedup
  -- key and what gives the missed-run reader a stable anchor.
  scheduled_for timestamptz NOT NULL,
  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  -- The worker process that produced this run (the tick) and the one that CLAIMED it off
  -- the queue. They are frequently different machines, so both are recorded.
  enqueued_by   text NOT NULL,
  started_at    timestamptz,
  claimed_by    text,
  finished_at   timestamptz,
  outcome       text CHECK (outcome IN ('success', 'failure', 'abandoned')),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- "Finished" and "has an outcome" are the same fact. Allowing them to disagree would
  -- let a row hold the in-flight lock below while looking complete, or look complete
  -- while holding nothing.
  CONSTRAINT global_job_run_outcome_matches_finished
    CHECK ((finished_at IS NULL) = (outcome IS NULL))
);

CREATE TRIGGER global_job_run_set_updated_at
  BEFORE UPDATE ON global_job_run
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── THE LOCK ─────────────────────────────────────────────────────────────────
-- (1) At most one UNFINISHED run per schedule. This is the concurrency lock: two ticks
--     racing, or two worker machines, cannot both open a run. It is released by
--     finishing the run — including by worker/core/reconcile.ts's sweep, which is what
--     stops the lock from outliving the process that held it (Fly's kill_timeout is 5
--     SECONDS; a machine dies mid-run as a matter of routine, not as an edge case).
CREATE UNIQUE INDEX idx_global_job_run_in_flight
  ON global_job_run (schedule_id) WHERE finished_at IS NULL;

-- (2) At most one run per due slot, forever. This is the duplicate lock: even after a run
--     has finished, the same slot can never be enqueued a second time, so a clock skew, a
--     replayed tick or an operator rewinding next_run_at cannot re-run a purge.
CREATE UNIQUE INDEX idx_global_job_run_slot
  ON global_job_run (schedule_id, scheduled_for);

-- Finalisation looks the run up by the job_queue row that carried it.
CREATE INDEX idx_global_job_run_job ON global_job_run (job_id);

-- The missed-run reader's anchor: newest slot per schedule.
CREATE INDEX idx_global_job_run_recent ON global_job_run (schedule_id, scheduled_for DESC);

-- The reconcile sweep's scan: unfinished runs only, which is a tiny set.
CREATE INDEX idx_global_job_run_unfinished
  ON global_job_run (started_at, enqueued_at) WHERE finished_at IS NULL;

ALTER TABLE global_job_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE global_job_run      ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON global_job_schedule FROM anon, authenticated;
REVOKE ALL ON global_job_run      FROM anon, authenticated;

-- ── the corrections_retention schedule, SHIPPED DISABLED ─────────────────────
-- enabled = FALSE, and that is the whole point. This row arms permanent deletion of
-- user-submitted correction reports; turning it on is a separate, deliberate, reversible
-- act that this migration deliberately does not take. Daily cadence matches the
-- documented operational shape of the equivalent Vercel route
-- (app/api/corrections/retention/run/route.ts); the purge is level-triggered — it removes
-- everything already past retained_until — so the exact hour it runs does not matter and
-- a skipped day costs nothing but a delay.
INSERT INTO global_job_schedule (job_type, cadence, enabled, next_run_at)
VALUES ('corrections_retention', interval '1 day', false, now())
ON CONFLICT (job_type) DO NOTHING;

-- ── operator notes ───────────────────────────────────────────────────────────
-- ENABLE the retention schedule (a deliberate act, reversible by flipping it back):
--   UPDATE global_job_schedule SET enabled = true WHERE job_type = 'corrections_retention';
--
-- RESET a tripped breaker (explicit recovery; there is no automatic path):
--   UPDATE global_job_schedule
--      SET breaker_tripped_at = NULL, breaker_reason = NULL, consecutive_failures = 0
--    WHERE job_type = $1;
--   -- equivalently: worker/core/global-job-schedule.ts resetGlobalJobBreaker()

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS global_job_run;
--   DROP TABLE IF EXISTS global_job_schedule;
