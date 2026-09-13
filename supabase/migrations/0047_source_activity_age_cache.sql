-- 0047_source_activity_age_cache.sql — remember what a SOURCE said an activity's age is, across runs.
--
-- WHY THIS TABLE EXISTS, AND WHY IT IS NOT OPTIONAL. ActiveNet publishes an exact age on its
-- activity record, and the adapter verifies against it before making an all-ages claim. That
-- lookup is capped by the tenant's per-run request budget (60 for Vancouver, 48 Burnaby, 4 West
-- Van) and, until now, cached only IN MEMORY for the life of one run. Because records are walked
-- in a stable order, every run spent its budget on substantially the same head of the list and
-- never reached the rest: coverage did not converge, however long the worker ran.
--
-- With this table a run starts from what earlier runs already learned, so the frontier advances
-- instead of resetting. Steady state is near-zero requests; the catalogue is covered in days.
--
-- NOT `provenance`, WHICH WAS THE OBVIOUS CANDIDATE AND DOES NOT FIT: that table is keyed by
-- occurrence_id and carries `fetched_at` but NO value column. It can say WHEN a fact was fetched,
-- not WHAT was fetched — half a cache, and the half that does not save the request. It would also
-- store one row per OCCURRENCE for an ACTIVITY-level fact, which is precisely the ~3x duplication
-- the cache exists to collapse.
--
-- Keyed by (source_family, source_activity_id) rather than by our own ids on purpose: the fact
-- belongs to the UPSTREAM entity, not to any occurrence we derived from it.
CREATE TABLE IF NOT EXISTS source_activity_age (
  source_family     text        NOT NULL,
  -- The source's own activity identifier, as text so no source's id format is assumed.
  source_activity_id text       NOT NULL,

  -- `has_age` DISTINGUISHES THE TWO NEGATIVE OUTCOMES, and that distinction is load-bearing
  -- everywhere else in this system: false means THE SOURCE ANSWERED AND HAS NO AGE (a real
  -- answer, worth caching so we stop re-asking). "We never got an answer" is NOT represented
  -- here at all — those rows are simply absent, so a failed lookup is retried next run rather
  -- than cached as a negative.
  has_age           boolean     NOT NULL,
  age_min_months    integer,
  age_max_months    integer,
  age_notes         text,

  fetched_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (source_family, source_activity_id),

  -- An answer must be internally consistent: bounds only when has_age.
  CONSTRAINT source_activity_age_bounds_match_flag CHECK (
    (has_age AND age_min_months IS NOT NULL) OR
    (NOT has_age AND age_min_months IS NULL AND age_max_months IS NULL AND age_notes IS NULL)
  ),
  CONSTRAINT source_activity_age_bounds_valid CHECK (
    age_max_months IS NULL OR age_min_months IS NULL OR age_max_months > age_min_months
  )
);

-- The TTL read is `fetched_at > now() - interval`, so that is the access path.
CREATE INDEX IF NOT EXISTS idx_source_activity_age_fetched_at
  ON source_activity_age (source_family, fetched_at);

COMMENT ON TABLE source_activity_age IS
  'Cross-run cache of what a SOURCE said one of its activities'' ages is. Keyed by the upstream '
  'activity id because the fact belongs to the upstream entity, not to any occurrence derived '
  'from it. Absence of a row means we never got an answer and should retry; a row with '
  'has_age = false means the source answered and has no age.';

-- Same default-deny posture as every table since 0018: this holds nothing sensitive, but the
-- app never uses the public REST surface and a cache is not a reason to start.
ALTER TABLE source_activity_age ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON source_activity_age FROM anon, authenticated;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS source_activity_age;
