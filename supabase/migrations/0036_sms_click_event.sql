-- 0036_sms_click_event.sql — SMS-primary pivot: did anyone actually tap the picks?
--
-- STATUS: DRAFT. Not applied by the agent that wrote it; the Operator applies migrations.
--
-- WHY THIS TABLE EXISTS. The weekly text is the entire product surface, and a text message
-- gives back no opens, no impressions and no scroll depth. The single observable signal is a
-- tap on one of the short links, so this table is the whole feedback loop: which picks earn a
-- tap, which subscribers are still engaged, and whether the "hub" landing page is worth its
-- existence next to a direct link. Without it the Friday send is a broadcast into the dark.
--
-- WHY NOT analytics_event (0006). That table is the ANONYMOUS web-analytics stream: an
-- anon-id cookie, a page-shaped event, and a fixed ~13-month retention (ANALYTICS_RETENTION_DAYS).
-- A click here is none of those things — it is attributed to a named subscriber and a specific
-- outbound message, and it is only meaningful joined to the send that produced it. Writing it
-- into the anonymous stream would put subscriber-attributed identity into a table whose whole
-- design premise is that it holds none.
--
-- WHY link_origin. The PRD offers a pick two ways: a link straight to the activity ('direct')
-- and a link to a small hub page listing the week's picks ('hub'). Which one a tap came through
-- is not derivable after the fact from anything else on the row, and it is the only way to
-- answer whether the hub page earns its keep — so it is recorded at click time.
--
-- ═══ THREE FOREIGN KEYS, THREE DIFFERENT ON DELETE ANSWERS ═══
-- Not inconsistency — each reference is under a different obligation, and picking one rule for
-- all three would get at least two of them wrong.
--
--   subscriber_id → sms_consent      ON DELETE SET NULL
--     Same argument as 0035, weaker stakes. A purged subscriber must not take the aggregate
--     engagement record with them, but unlike the send log this row carries no CASL duty, so
--     losing the attribution while keeping the count is an acceptable outcome. Nullable.
--
--   send_log_id → sms_send_log       (default NO ACTION) — deliberately NOT cascading
--     sms_send_log is append-only and retained indefinitely, so this FK should never fire. That
--     is the point of leaving it at NO ACTION: if a delete ever IS attempted against the audit
--     trail, an FK error is the correct and loud outcome, not a silent cascade that quietly
--     helps destroy it.
--
--   occurrence_id → activity_occurrence   ON DELETE CASCADE
--     The opposite call, for the opposite reason. Catalogue rows are normally SOFT-deleted
--     (archived_at, TSD §6.2), so in production this too should rarely fire — but hard deletes
--     of activity_occurrence DO exist in the admin and test-teardown paths, and 0017's comment
--     already records what happens when an audit-ish table blocks one: a 23503 FK violation on
--     a delete path nobody expected to have a new dependency. A click event is engagement
--     telemetry about an activity, not evidence about a person; when the activity is genuinely
--     gone, so is the telemetry. Cascading here is the choice that does not newly break an
--     existing delete path.
--
-- RLS: default-deny, mirroring 0017/0018/0033/0034/0035 — RLS ENABLED, NO policies, plus
-- REVOKE ALL. Written ONLY by the service-level pool. The redirect route that records a click
-- is a server route holding the service pool; the tapping subscriber is not signed in and never
-- touches this table directly.

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TABLE sms_click_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id uuid REFERENCES sms_consent(id) ON DELETE SET NULL,
  send_log_id   uuid NOT NULL REFERENCES sms_send_log(id),
  occurrence_id uuid NOT NULL REFERENCES activity_occurrence(id) ON DELETE CASCADE,
  link_origin   text NOT NULL CHECK (link_origin IN ('direct','hub')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- "Which picks in this send got tapped" — the per-send read.
CREATE INDEX idx_sms_click_event_send_log ON sms_click_event (send_log_id);

-- "Which activities earn taps" — the per-activity read that feeds pick quality.
CREATE INDEX idx_sms_click_event_occurrence ON sms_click_event (occurrence_id, created_at DESC);

-- "Is this subscriber still engaged" — the per-subscriber read.
CREATE INDEX idx_sms_click_event_subscriber
  ON sms_click_event (subscriber_id, created_at DESC) WHERE subscriber_id IS NOT NULL;

-- DELIBERATELY NOT UNIQUE on (send_log_id, occurrence_id). A parent tapping the same pick twice
-- is two taps, and forcing it to one would quietly turn a click LOG into a click FLAG. Dedup,
-- if a report ever wants it, is a COUNT(DISTINCT ...) at read time where the choice is visible.

COMMENT ON COLUMN sms_click_event.link_origin IS
  '''direct'' = the short link pointed straight at the activity; ''hub'' = it pointed at the '
  'week''s hub page and the tap happened from there. Recorded at click time because it is not '
  'recoverable afterwards, and it is the only evidence for whether the hub page is worth having.';

ALTER TABLE sms_click_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_click_event FROM anon, authenticated;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS sms_click_event;
