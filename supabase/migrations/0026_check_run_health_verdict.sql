-- 0026_check_run_health_verdict.sql — F-11: make a run's health verdict a QUERYABLE fact.
--
-- THE BUG THIS CLOSES. An adapter's self-assessment (Adapter.assessRun → AdapterRunDiagnostics)
-- can raise a real alert — phone_rejection_spike, shape_drift, coverage_truncated,
-- coverage_shortfall, asset_build_drift — and that alert reached NO operator anywhere:
--   • lib/admin/dashboard.ts's failures panel queried WHERE status = 'failed', but a run that
--     upserted occurrences AND raised an alert is 'partial', so it never appeared;
--   • worker/health/sla.ts (and lib/admin/data-health.ts) counted 'partial' as SUCCEEDED for
--     both the success ratio and the last-success timestamp, so an alerted run made the
--     headline SLA number look HEALTHIER than the truth.
-- The verdict was durably recorded — but only as prose inside the generic `errors` jsonb
-- array ("run health [code]: detail"), where the only way to find it in SQL is a LIKE match
-- on a human-readable string. That is the root cause: not "adapters cannot express degraded"
-- (widening `status` would not help — ingest.ts already derives 'partial' from unrelated
-- per-record errors, so 'partial' can never discriminate), but "the alert is not stored in a
-- form anything can query". These two columns are that form.
--
-- SHAPE. `health_alert_code IS NOT NULL` is the single, authoritative "this run raised an
-- alert" predicate. Deliberately NOT a separate boolean + code: two columns that can disagree
-- is a bug waiting to be written, and the code is never absent when the alert fires.
ALTER TABLE source_check_run
  ADD COLUMN health_alert_code   text,
  ADD COLUMN health_alert_detail text;

COMMENT ON COLUMN source_check_run.health_alert_code IS
  'AdapterRunDiagnostics.code for a run whose adapter self-assessment raised alert=true '
  '(phone_rejection_spike, shape_drift, yield_collapse, coverage_shortfall, …). NULL = no '
  'alert. This is THE alert predicate — the dashboard attention panel and both SLA '
  'success-ratio paths key off IS NOT NULL, never off status.';
COMMENT ON COLUMN source_check_run.health_alert_detail IS
  'AdapterRunDiagnostics.detail — the one-line human explanation shown beside the code.';

-- The attention panel reads "alerted runs in the last N days, newest first". A partial index
-- keeps that scan proportional to the alerts, not to the whole run history.
CREATE INDEX idx_source_check_run_health_alert
  ON source_check_run (started_at DESC)
  WHERE health_alert_code IS NOT NULL;

-- ── BACKFILL ────────────────────────────────────────────────────────────────────────────
-- Alerts that ALREADY fired are exactly the ones nobody ever saw, so leaving history NULL
-- would ship a fix that only works for the future and quietly abandons the incidents that
-- motivated it.
--
-- TWO WRITERS, TWO SHAPES — both must be recovered, or the backfill silently covers half the
-- alerts:
--   • ARRAY shape, from worker/core/ingest.ts: a jsonb string[] containing the line
--     `run health [<code>]: <detail>`, emitted verbatim by that one call site, so the
--     anchored regexp matches that exact shape or nothing. Per-record errors ("record abc: …")
--     and fetch errors ("fetch/extract: …") cannot match it.
--   • OBJECT shape, from recordActiveNetCheckRun / recordPerfectMindCheckRun: a jsonb object
--     `{code, detail, warnings}`, written for verdicts raised OUTSIDE the ingest loop (a fetch
--     that never reached it, or a post-hoc yield assessment). That object is also written for a
--     non-alerting verdict that merely carried warnings, so `code <> 'ok'` is the alert
--     discriminator — sound because every non-'ok' verdict in both adapters' assessRunHealth
--     sets alert: true, and 'ok' is the only one that does not.
--
-- CONSEQUENCE, STATED PLAINLY: on deploy this moves the headline SLA number DOWNWARD for any
-- source with a historical alert, because those runs stop counting as clean successes. That
-- is the honest number the board should have been showing all along, not a regression.
UPDATE source_check_run cr
   SET health_alert_code   = v.code,
       health_alert_detail = v.detail
  FROM (
    -- array shape (ingestSource). DISTINCT ON keeps one verdict per run; ordinality makes
    -- "which one" deterministic rather than whatever the scan happened to yield first.
    SELECT * FROM (
      SELECT DISTINCT ON (cr2.id)
             cr2.id,
             (regexp_match(e.value, '^run health \[([^\]]+)\]: (.*)$'))[1] AS code,
             (regexp_match(e.value, '^run health \[([^\]]+)\]: (.*)$'))[2] AS detail
        FROM source_check_run cr2
        CROSS JOIN LATERAL jsonb_array_elements_text(cr2.errors) WITH ORDINALITY AS e(value, ord)
       WHERE jsonb_typeof(cr2.errors) = 'array'
         AND e.value ~ '^run health \[[^\]]+\]: '
       ORDER BY cr2.id, e.ord
    ) from_errors_array
    UNION ALL
    -- object shape (recordActiveNetCheckRun / recordPerfectMindCheckRun)
    SELECT cr3.id,
           cr3.errors ->> 'code'   AS code,
           cr3.errors ->> 'detail' AS detail
      FROM source_check_run cr3
     WHERE jsonb_typeof(cr3.errors) = 'object'
       AND cr3.errors ->> 'code' IS NOT NULL
       AND cr3.errors ->> 'code' <> 'ok'
  ) v
 WHERE cr.id = v.id
   AND v.code IS NOT NULL;

-- Rollback (manual, forward-only runner never executes this):
--   DROP INDEX IF EXISTS idx_source_check_run_health_alert;
--   ALTER TABLE source_check_run DROP COLUMN IF EXISTS health_alert_detail;
--   ALTER TABLE source_check_run DROP COLUMN IF EXISTS health_alert_code;
