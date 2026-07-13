-- 0007_user_admin.sql — G-T2-6: user/admin tables (TSD §6.1) + retention columns.
-- user_profile.id mirrors Supabase auth.users(id) (the authenticated user's uid).
-- No FK to auth.users is declared here: `auth` is a Supabase-managed schema not
-- present in a bare Postgres/CI database, and forward migrations must apply
-- cleanly in both. RLS (0013_rls_user.sql, G-T6-3) enforces the auth.uid() tie
-- at query time instead. user_profile.home_geo (geography) is added in
-- 0009_geo_columns.sql (G-T4-2), once PostGIS is enabled.

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TABLE user_profile (
  id               uuid PRIMARY KEY, -- = auth.uid() on Supabase
  google_identity  text,
  home_postal      text,
  saved_child_ages integer[] NOT NULL DEFAULT '{}', -- ages in months (canonical unit, matches occurrence_age)
  email_opt_in     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
  -- home_geo geography(Point,4326) added in 0009_geo_columns.sql (G-T4-2)
);

CREATE TRIGGER user_profile_set_updated_at
  BEFORE UPDATE ON user_profile
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE saved_search (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES user_profile(id),
  query_json  jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz
);

CREATE INDEX idx_saved_search_user ON saved_search(user_id);

CREATE TABLE admin_user (
  user_id    uuid PRIMARY KEY REFERENCES user_profile(id),
  role       text NOT NULL DEFAULT 'operator' CHECK (role IN ('operator','admin','superadmin')),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id  uuid NOT NULL REFERENCES admin_user(user_id),
  action         text NOT NULL,
  target_table   text NOT NULL,
  target_id      uuid,
  before_json    jsonb,
  after_json     jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_audit_log_admin ON admin_audit_log(admin_user_id, created_at DESC);
CREATE INDEX idx_admin_audit_log_target ON admin_audit_log(target_table, target_id);

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS admin_audit_log;
--   DROP TABLE IF EXISTS admin_user;
--   DROP TABLE IF EXISTS saved_search;
--   DROP TABLE IF EXISTS user_profile;
