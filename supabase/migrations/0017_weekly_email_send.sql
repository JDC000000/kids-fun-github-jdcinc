-- 0017_weekly_email_send.sql — M4/G5 weekly-digest email: per-user send log.
--
-- Purpose (two jobs, one small append-only table):
--   1. WATERMARK — "new/upcoming matching activities since their last email
--      (or since signup if first email)". The digest builder needs to know when
--      this user was last emailed; MAX(sent_at) for the user is that watermark,
--      and user_profile.created_at is the fallback for a first-ever send.
--   2. CASL AUDIT TRAIL — Canadian anti-spam law (CASL) expects a record of what
--      commercial electronic messages were sent, to whom, and when. This log is
--      that record (recipient identity kept as the pseudonymous user_id, never the
--      email address itself — the address lives only in Supabase auth.users).
--
-- WHY A NEW TABLE (not a column on user_profile): keeps this feature's state fully
-- owned by the email lane (parallel-round scope hygiene), gives an append-only
-- history rather than a single overwritten timestamp, and doubles as the audit
-- trail above. Written ONLY by the system digest job via the service role
-- (DATABASE_URL) — this is a cross-user system job, never user-facing CRUD.
--
-- RLS: default-deny, mirroring 0014_admin_rls.sql. No policies are created and the
-- API roles are REVOKEd, so anon/authenticated can never read another user's send
-- history via the REST surface; only a service-role client (which bypasses RLS by
-- design) touches it.
--
-- FK + ON DELETE CASCADE: references user_profile(id). Account deletion
-- (lib/db/account-data.ts, Task C) hard-deletes the user_profile row; the CASCADE
-- makes this log erase with it, so (a) deletion never fails on an FK violation
-- (the admin_user 23503 case), and (b) "delete my account" also removes the send
-- history — a stronger privacy posture. FK cascade actions run with the table
-- owner's rights and bypass RLS, so the authenticated-role deletion transaction in
-- account-data.ts still cascades cleanly. (Proven by tests/email/account_deletion_cascade.test.ts.)

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TABLE weekly_email_send (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES user_profile(id) ON DELETE CASCADE,
  sent_at        timestamptz NOT NULL DEFAULT now(),
  activity_count integer NOT NULL DEFAULT 0,
  resend_id      text,           -- Resend message id (null for a dry-run record)
  dry_run        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Watermark lookup: latest send per user.
CREATE INDEX idx_weekly_email_send_user ON weekly_email_send(user_id, sent_at DESC);

ALTER TABLE weekly_email_send ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON weekly_email_send FROM authenticated, anon;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS weekly_email_send;
