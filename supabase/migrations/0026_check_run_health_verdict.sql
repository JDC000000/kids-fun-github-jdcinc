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
-- A THIRD PRODUCER WRITES THIS COLUMN AND MUST NOT BE SWEPT IN (found in QA — an earlier
-- version of this backfill mislabelled it). `source_check_run.errors` has THREE shapes, not
-- two: reconcileAbandonedRuns (worker/core/reconcile.ts) and abandonInFlightRuns
-- (worker/src/shutdown.ts) close out runs orphaned by a dead process, writing
-- `{code:'abandoned_run'|'shutdown_abandoned_run', detail}`. Those are INFRASTRUCTURE
-- CLOSEOUT MARKERS, not adapter health verdicts — no adapter produced them and none of the
-- five documented codes describes them.
--
-- The discriminator is the PRODUCER, not the code value, so it keys off object SHAPE:
-- `errors ? 'warnings'`. The adapter recorders always include that key (it is `extraWarnings`,
-- defaulting to []); the two infra writers never do. This is deliberately not a code
-- allow/deny list: a deny-list goes stale the moment someone adds a fourth infra code (and
-- mislabels it), and an allow-list goes stale the moment an adapter adds a sixth verdict code
-- (and silently drops a real alert). Shape tracks the writer, which is the thing actually
-- being asked about, and it cannot drift as either vocabulary grows.
--
-- The obvious objection — "an older recorder build might have written {code, detail} with no
-- warnings key, and you would miss it" — was checked in QA rather than reasoned about, and is
-- provably zero: every historical revision of both recorders writes `warnings: extraWarnings`
-- (4 commits for activenet since b5c98c3, 6 for perfectmind since 5394619; the no-warnings
-- shape has never existed), AND neither recorder has ever had a production caller in any
-- commit — only its own module and tests. So no row of recorder-object shape exists in any
-- real database. Nothing is traded away for the precision.
--
-- `code <> 'ok'` is still load-bearing alongside the shape test, and both must stay: a
-- recorder writes the object for a NON-alerting verdict too when it carries warnings, and
-- that row has `warnings` but must not be flagged.
--
-- BOUNDED RESIDUAL, written down rather than guarded: if reconcile/shutdown ever gain a
-- `warnings` key, their markers would match again. This is one-time and forward-only — once
-- applied everywhere it can never re-run — so only such a change landing BEFORE prod takes
-- this migration could bite. Not worth a guard; worth knowing.
--
-- MEASURED EFFECT ON REAL DATA: NONE. Staging and prod contain no adapter health verdict of
-- any kind (QA measured twice, from independent fresh restores: array branch 0 rows, object
-- branch 0 genuine rows, 0 of 49 prod runs with non-null errors; tile adherencePct and worker
-- p0AdherencePct both 100 → 100, serialised payload byte-for-byte identical). So this backfill
-- changes no SLA figure today — the mechanism is verified and correct, it simply has nothing
-- historical to act on yet. An EARLIER version of this comment warned the deployer to brace
-- for the headline number to drop; that was written before the measurement and is wrong.
-- Going forward an alerting run will lower the figure rather than raise it, and if that ever
-- happens the reading is "the measurement stopped overstating reality", not "the SLA got
-- worse" — but nothing moves at deploy.
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
    -- object shape (recordActiveNetCheckRun / recordPerfectMindCheckRun ONLY — the
    -- `? 'warnings'` test is what keeps reconcile/shutdown closeout markers out)
    SELECT cr3.id,
           cr3.errors ->> 'code'   AS code,
           cr3.errors ->> 'detail' AS detail
      FROM source_check_run cr3
     WHERE jsonb_typeof(cr3.errors) = 'object'
       AND cr3.errors ? 'warnings'
       AND cr3.errors ->> 'code' IS NOT NULL
       AND cr3.errors ->> 'code' <> 'ok'
  ) v
 WHERE cr.id = v.id
   AND v.code IS NOT NULL;

-- Rollback (manual, forward-only runner never executes this):
--   DROP INDEX IF EXISTS idx_source_check_run_health_alert;
--   ALTER TABLE source_check_run DROP COLUMN IF EXISTS health_alert_detail;
--   ALTER TABLE source_check_run DROP COLUMN IF EXISTS health_alert_code;
