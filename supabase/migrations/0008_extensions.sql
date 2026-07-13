-- 0008_extensions.sql — G-T4-1: enable PostGIS + pg_trgm (TSD §5A.1, §5B).

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP EXTENSION IF EXISTS pg_trgm;
--   DROP EXTENSION IF EXISTS postgis;
