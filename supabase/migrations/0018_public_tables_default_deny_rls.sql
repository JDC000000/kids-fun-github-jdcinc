-- 0018_public_tables_default_deny_rls.sql — SECURITY fix (Round 20 / Task HH,
-- F-1 remediation): default-deny RLS + REVOKE ALL on the 18 remaining
-- public-schema tables that still expose full CRUD to the `anon`/`authenticated`
-- API roles. Models directly on 0014_admin_rls.sql / 0017_weekly_email_send.sql.
--
-- FINDING (docs/security-review.md, F-1; independently QA-verified against the
-- live staging Supabase using only the public anon key): every table below has
-- RLS DISABLED and holds Supabase's default anon/authenticated table grants, so
-- any client with the anon key could read (and in most cases write) real rows
-- straight through the Supabase REST/GraphQL surface — search catalog data,
-- analytics_event rows, correction_report submissions, the job_queue, etc. —
-- bypassing the app entirely. Only admin_user/admin_audit_log (0014),
-- user_profile/saved_search (0013), and weekly_email_send (0017) were locked.
--
-- DECISION (Jon, product owner, via operator): go beyond the review's suggested
-- public-read-catalog vs locked-ops split — REVOKE ALL / default-deny on ALL 18,
-- no permissive policies, service-role only. Rationale: the app NEVER uses the
-- public REST/GraphQL surface for its own function — every read and write goes
-- through a server-side `pg` pool on the SERVICE-LEVEL DATABASE_URL connection
-- (lib/db/client.ts getPool()/query() for the app; worker/src/db.ts createPool()
-- for the ingestion worker), which is the table owner and BYPASSES RLS by design.
-- The `authenticated`-role path (lib/db/user-scoped-client.ts withUserContext over
-- USER_DATABASE_URL) is used ONLY for user_profile/saved_search — none of the
-- tables below. So there is no known functional need for ANY anon/authenticated
-- access to these tables today. If a real future need for public reads surfaces,
-- that becomes a deliberate future migration, not today's default.
--
-- Default-deny is intentional: NO policies are created. RLS with zero permissive
-- policies denies every RLS-subject role; the REVOKE additionally strips the
-- default table GRANTs so the deny holds at the privilege layer too (two
-- independent barriers, matching 0014). A service-role/owner client bypasses RLS
-- by design, so every legitimate app + worker path is unaffected — verified by a
-- full pre-flight audit of worker/adapters/**, worker/core/**, and the app data
-- layer (Round 20 / Task HH findings doc).

-- ── forward ──────────────────────────────────────────────────────────────────
-- Catalog / core places + activities
ALTER TABLE source                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_series           ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_occurrence       ENABLE ROW LEVEL SECURITY;
ALTER TABLE venue                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE region                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation              ENABLE ROW LEVEL SECURITY;
-- Taxonomy
ALTER TABLE category                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE age_band                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE occurrence_age            ENABLE ROW LEVEL SECURITY;
ALTER TABLE occurrence_category_tag   ENABLE ROW LEVEL SECURITY;
ALTER TABLE synonym_alias             ENABLE ROW LEVEL SECURITY;
-- Provenance / ops
ALTER TABLE provenance                ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_check_run          ENABLE ROW LEVEL SECURITY;
ALTER TABLE correction_report         ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_event           ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_queue                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_meta                  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON source                  FROM anon, authenticated;
REVOKE ALL ON activity_series         FROM anon, authenticated;
REVOKE ALL ON activity_occurrence     FROM anon, authenticated;
REVOKE ALL ON venue                   FROM anon, authenticated;
REVOKE ALL ON region                  FROM anon, authenticated;
REVOKE ALL ON organisation            FROM anon, authenticated;
REVOKE ALL ON category                FROM anon, authenticated;
REVOKE ALL ON tag                     FROM anon, authenticated;
REVOKE ALL ON age_band                FROM anon, authenticated;
REVOKE ALL ON occurrence_age          FROM anon, authenticated;
REVOKE ALL ON occurrence_category_tag FROM anon, authenticated;
REVOKE ALL ON synonym_alias           FROM anon, authenticated;
REVOKE ALL ON provenance              FROM anon, authenticated;
REVOKE ALL ON source_check_run        FROM anon, authenticated;
REVOKE ALL ON correction_report       FROM anon, authenticated;
REVOKE ALL ON analytics_event         FROM anon, authenticated;
REVOKE ALL ON job_queue               FROM anon, authenticated;
REVOKE ALL ON app_meta                FROM anon, authenticated;

-- ── rollback ────────────────────────────────────────────────────────────────
-- Restoring public access is a DELIBERATE future decision, not an automatic
-- revert. To undo (per table): re-grant the intended privileges and disable RLS,
-- e.g.
--   GRANT SELECT ON region TO anon, authenticated;
--   ALTER TABLE region DISABLE ROW LEVEL SECURITY;
-- (repeat only for the specific tables a future requirement actually needs).
