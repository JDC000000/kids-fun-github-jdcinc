-- 0006_provenance_ops.sql — G-T2-5: provenance + ops tables (TSD §6.1 IR-04, §9).
-- provenance / source_check_run / correction_report / analytics_event.
-- analytics_event and provenance are append-only; analytics_event carries a
-- retention column (retained_until) per the retention-policy note in §6.1.

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TABLE provenance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id uuid NOT NULL REFERENCES activity_occurrence(id),
  field         text NOT NULL,
  source_url    text NOT NULL,
  source_family text,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  fact_origin   text NOT NULL DEFAULT 'source'
                  CHECK (fact_origin IN ('source','llm_normalised','manual_override'))
);

CREATE INDEX idx_provenance_occurrence ON provenance(occurrence_id);

CREATE TABLE source_check_run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     uuid NOT NULL REFERENCES source(id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','success','partial','failed')),
  records_found integer,
  errors        jsonb,
  duration_ms   integer
);

CREATE INDEX idx_source_check_run_source ON source_check_run(source_id, started_at DESC);

CREATE TABLE correction_report (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id uuid NOT NULL REFERENCES activity_occurrence(id),
  reporter      text, -- user id or anon session id
  issue_type    text NOT NULL,
  note          text,
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','in_review','resolved')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  archived_at   timestamptz -- soft-delete (TSD §6.2 cross-cutting canon)
);

CREATE INDEX idx_correction_report_occurrence ON correction_report(occurrence_id);
CREATE INDEX idx_correction_report_status ON correction_report(status) WHERE status <> 'resolved';

CREATE TABLE analytics_event (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type          text NOT NULL,
  search_context_json jsonb,
  result_summary_json jsonb,
  user_or_session     text,
  source_id           uuid REFERENCES source(id),
  occurrence_id       uuid REFERENCES activity_occurrence(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  retained_until       timestamptz NOT NULL DEFAULT (now() + interval '13 months')
);

CREATE INDEX idx_analytics_event_type_created ON analytics_event(event_type, created_at DESC);
CREATE INDEX idx_analytics_event_retained_until ON analytics_event(retained_until);

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS analytics_event;
--   DROP TABLE IF EXISTS correction_report;
--   DROP TABLE IF EXISTS source_check_run;
--   DROP TABLE IF EXISTS provenance;
