-- 0020_correction_report_retention.sql — retention-enforcement column for
-- correction_report (PIPEDA data-minimisation; Round 23 checklist finding F-6).
--
-- WHY: correction_report is the one ops table that can store user-submitted content
-- (the free-text `note` column) yet has NO retention control — only a soft-delete
-- `archived_at` that nothing sets automatically (0006_provenance_ops.sql). Its
-- sibling analytics_event already carries a per-row `retained_until` stamp + index
-- (0006) that a scheduled job enforces by hard-DELETE. This migration gives
-- correction_report the SAME mechanism so a retention job can purge expired rows.
--
-- WINDOW — 6 months (interval '6 months'), deliberately SHORTER than
-- analytics_event's ~13-month window. Rationale (NOT a copy of analytics_event's):
--   • correction_report is an operational data-quality signal (a user flag that an
--     activity's info is wrong), not long-lived telemetry. Its useful life is the
--     time to WORK the item (open -> in_review -> resolved — typically days to a few
--     weeks) PLUS a bounded post-resolution audit/trend window.
--   • After resolution a correction stays useful to: (a) audit who reported / what
--     was fixed on a given occurrence, (b) detect REPEAT corrections against the
--     same occurrence or source (source-health, T15), and (c) feed near-term
--     data-quality trend review across ~one seasonal cycle of kids' programming.
--   • 6 months comfortably spans the full lifecycle plus a seasonal cycle, while
--     honouring PIPEDA Principle 4.5 (retain personal info only as long as needed):
--     `note` is free text the client MAY submit (latent PII — Round 23 F-6), so a
--     tighter-than-analytics window caps how long any such text can linger.
--   • Clock start: like analytics_event, retained_until is stamped at INSERT
--     (now() + window) via the column DEFAULT, NOT at resolution. Because
--     corrections resolve quickly relative to the window, created_at + 6 months
--     ~= resolved_at + ~6 months in practice; using the DEFAULT keeps the mechanism
--     identical to analytics_event (index-backed, no re-stamp on status change).
--     The write helper (lib/corrections/report.ts) does NOT set the column, so the
--     DEFAULT is the single source of truth for the window.
--
-- RLS: correction_report is already default-deny (ENABLE RLS + REVOKE ALL from
-- anon/authenticated in 0018_public_tables_default_deny_rls.sql). ADD COLUMN
-- inherits table-level RLS and grants unchanged, so no re-lockdown is needed here.
--
-- IDEMPOTENT: IF NOT EXISTS on both statements (0015/0019 convention) — a re-run is
-- a no-op. NOT NULL is safe on ALTER ... ADD with a DEFAULT: Postgres fills existing
-- rows with now()+interval at add time (each pre-existing row gets a full window
-- from the migration moment — acceptable for a backstop retention job).
--
-- Src: Round 23 PIPEDA checklist F-6; TSD §6.1 retention-policy note. Deps:
-- 0006_provenance_ops (correction_report). Forward-only; reversible steps below.

-- ── forward ──────────────────────────────────────────────────────────────────
ALTER TABLE correction_report
  ADD COLUMN IF NOT EXISTS retained_until timestamptz NOT NULL DEFAULT (now() + interval '6 months');

CREATE INDEX IF NOT EXISTS idx_correction_report_retained_until
  ON correction_report(retained_until);

-- ── rollback (reversible) ─────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS idx_correction_report_retained_until;
--   ALTER TABLE correction_report DROP COLUMN IF EXISTS retained_until;
