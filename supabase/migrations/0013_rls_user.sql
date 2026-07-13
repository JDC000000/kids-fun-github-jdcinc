-- 0013_rls_user.sql — G-T6-3: RLS on user_profile + saved_search, owner-only
-- (TSD §6.1, §9; <L3>). Relies on `auth.uid()` — provided natively by
-- Supabase, or by supabase/local-dev/000_auth_stub.sql for local/CI testing
-- (applied by scripts/local-db-bootstrap.sh before this migration runs there).

-- ── forward ──────────────────────────────────────────────────────────────────
ALTER TABLE user_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_profile_owner_select ON user_profile
  FOR SELECT USING (auth.uid() = id);
CREATE POLICY user_profile_owner_insert ON user_profile
  FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY user_profile_owner_update ON user_profile
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY user_profile_owner_delete ON user_profile
  FOR DELETE USING (auth.uid() = id);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_profile TO authenticated;

ALTER TABLE saved_search ENABLE ROW LEVEL SECURITY;

CREATE POLICY saved_search_owner_select ON saved_search
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY saved_search_owner_insert ON saved_search
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY saved_search_owner_update ON saved_search
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY saved_search_owner_delete ON saved_search
  FOR DELETE USING (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON saved_search TO authenticated;

-- ── rollback ────────────────────────────────────────────────────────────────
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON saved_search FROM authenticated;
--   DROP POLICY IF EXISTS saved_search_owner_delete ON saved_search;
--   DROP POLICY IF EXISTS saved_search_owner_update ON saved_search;
--   DROP POLICY IF EXISTS saved_search_owner_insert ON saved_search;
--   DROP POLICY IF EXISTS saved_search_owner_select ON saved_search;
--   ALTER TABLE saved_search DISABLE ROW LEVEL SECURITY;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON user_profile FROM authenticated;
--   DROP POLICY IF EXISTS user_profile_owner_delete ON user_profile;
--   DROP POLICY IF EXISTS user_profile_owner_update ON user_profile;
--   DROP POLICY IF EXISTS user_profile_owner_insert ON user_profile;
--   DROP POLICY IF EXISTS user_profile_owner_select ON user_profile;
--   ALTER TABLE user_profile DISABLE ROW LEVEL SECURITY;
