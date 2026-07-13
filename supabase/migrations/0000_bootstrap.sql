-- 0000_bootstrap.sql — KIDS FUN initial migration.
-- Single schema tool, forward-only with reversible steps (TSD §3A.3, scope-to-task §B).
-- Establishes a minimal, reversible baseline so CI (G-T1-4) can prove the migration
-- harness against an empty schema. The canonical schema begins at G-T2-1 (enums).

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_meta (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_meta (key, value)
VALUES ('schema_baseline', '0000_bootstrap')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- ── rollback (reversible; run by future down-migration tooling) ───────────────
--   DROP TABLE IF EXISTS app_meta;
