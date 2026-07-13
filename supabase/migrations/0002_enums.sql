-- 0002_enums.sql — G-T2-1: canonical enums (TSD §6.2 / Appendix C).
-- status_state must carry exactly 16 members; season/cost/tag/ingestion enums support
-- §7.1 seasonality, §6.2 cost modelling, and §6.1 taxonomy/source rows.

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TYPE status_state AS ENUM (
  'confirmed',
  'bookable_open',
  'not_yet_bookable',
  'schedule_not_published',
  'inferred_recurring',
  'manual_candidate',
  'seasonal_out_of_season',
  'seasonal_preseason',
  'seasonal_active',
  'suspended',
  'stale',
  'cancelled',
  'postponed',
  'full',
  'waitlist',
  'needs_review'
);

CREATE TYPE season_state AS ENUM (
  'active',
  'pre_season',
  'in_season',
  'post_season',
  'suspended',
  'unknown'
);

CREATE TYPE cost_status AS ENUM (
  'known',
  'free',
  'unknown',
  'check_source'
);

CREATE TYPE tag_type AS ENUM (
  'category',
  'suitability',
  'status',
  'context'
);

CREATE TYPE ingestion_method AS ENUM (
  'auto',
  'semi',
  'manual',
  'partner'
);

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TYPE IF EXISTS ingestion_method;
--   DROP TYPE IF EXISTS tag_type;
--   DROP TYPE IF EXISTS cost_status;
--   DROP TYPE IF EXISTS season_state;
--   DROP TYPE IF EXISTS status_state;
