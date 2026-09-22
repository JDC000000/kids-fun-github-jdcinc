-- 0052_analytics_event_high_frequency_flag.sql — the DAU/MAU bot-traffic exclusion signal.
--
-- ═══ WHY THIS EXISTS ═══
-- Companion to 0051 (search_rate_limit). That migration adds the ENFORCEMENT — GET /api/search
-- now refuses a caller past the rate limit, and app/search/page.tsx already only records a
-- `search_performed` row when the underlying fetch succeeded (`result.ok`), so a refused request
-- never reaches analytics_event at all. That alone stops MOST of the 2026-09-22 incident's future
-- contamination (see 0051's header).
--
-- But "under the hard limit" is not the same claim as "a real parent". lib/security/
-- search-rate-limit.ts already computes, as a side effect of the SAME atomic upsert that decides
-- allow/refuse, how many requests this ip/session made in the current minute bucket. This column
-- is where that number becomes a first-class, queryable signal instead of being thrown away the
-- moment the request is allowed through — so:
--   • a caller who paces itself just under the per-minute ceiling still gets EXCLUDED from
--     DAU/MAU (lib/analytics/kpi.ts), even though the request itself was never refused;
--   • a future, smarter version of this bot (or an unrelated one) that self-throttles to evade the
--     hard limit does not silently become invisible again — it still shows up in this column.
--
-- ═══ AN INTEGER COUNT, NOT A BOOLEAN — REVISED 2026-09-22, SAME DAY, BEFORE ANYTHING SHIPPED ═══
-- The first version of this migration added a boolean (`is_high_frequency_client`, thresholded at
-- write time, >=5/min). Two independent reviews caught the same problem from different angles
-- before this ever reached production: 5/min is not "double digits" the way a real, fast-clicking
-- parent using FilterRail/MobileFilterSheet/QuerySummary can casually reach (every filter chip is
-- its own navigation), and a write-time boolean is a DEAD END — a mis-tuned threshold silently
-- erases real sessions from KPIs with no stored reason and nothing to recompute from.
--
-- Storing the RAW count instead (NULL = "not measured": the request was degraded — no salt, no
-- subject, or a DB error — never a real zero) moves the exclusion CUTOFF to READ time
-- (lib/analytics/kpi.ts, via lib/security/search-rate-limit.ts's
-- ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD — see that constant's header for the current number and
-- rationale). A wrong cutoff is now a query change, not a backfill or a re-migration, and any
-- specific exclusion is reviewable: `SELECT search_minute_request_count FROM analytics_event
-- WHERE ...` shows exactly why a session was (or wasn't) caught, rather than a bare `true`.
--
-- ═══ WHY A COLUMN ON THE ROW, NOT A SEPARATE "FLAGGED SESSIONS" TABLE ═══
-- The signal is a property of ONE REQUEST (how fast was the subject going right now), not of a
-- session as a durable entity — a session that was quiet for an hour and then bursts should light
-- up starting from the burst, not retroactively for its earlier, ordinary rows. Stamping it at
-- write time on the row that earned it keeps that distinction free; a side table keyed by session
-- would have to decide when to set and clear a flag that this design never has to track.
--
-- ═══ THE EXCLUSION IS "ANY QUALIFYING ROW POISONS THE WHOLE SESSION FOR DAU/MAU", DELIBERATELY ═══
-- lib/analytics/kpi.ts's getActiveUsers groups by user_or_session; a session that fired even ONE
-- row at/above the read-time cutoff is, by construction, not a parent doing ordinary browsing (see
-- lib/security/search-rate-limit.ts's threshold rationale), so it is excluded entirely rather than
-- merely having that one row discounted. idx_analytics_event_high_frequency below is what makes
-- that exclusion a cheap partial-index lookup instead of a scan over the whole table.
--
-- ═══ NOT RETROACTIVE ═══
-- This migration does not touch any existing row — every historical row defaults to NULL
-- ("not measured", not "measured and zero"). The ~3.2M rows already contaminated by the pre-fix
-- traffic are a separate, explicitly deferred cleanup (see the 2026-09-22 incident report); this
-- column only prevents the pattern from continuing to accumulate.
ALTER TABLE analytics_event
  ADD COLUMN IF NOT EXISTS search_minute_request_count integer;

COMMENT ON COLUMN analytics_event.search_minute_request_count IS
  'The RAW count of requests this row''s ip/session had already made in the current minute '
  '(lib/security/search-rate-limit.ts), stamped at write time. NULL means "not measured" (a '
  'degraded rate-limit check — no salt, no subject, or a DB error), which is a different fact '
  'from "measured, and low" (a real small number) — never conflate the two in a query. The '
  'DAU/WAU/MAU exclusion cutoff is applied at READ time against this value '
  '(lib/analytics/kpi.ts::getActiveUsers, via search-rate-limit.ts''s '
  'ACTIVE_USER_EXCLUSION_MINUTE_THRESHOLD), deliberately NOT baked in here, so the cutoff can be '
  'corrected after the fact with a query change rather than a backfill. Always NULL on rows '
  'written before 2026-09-22 (this column has no DEFAULT) — it protects against the pattern '
  'CONTINUING, and is not a retroactive judgement on historical rows.';

-- Backs the kpi.ts correlated-subquery lookup ("does this actor have any qualifying row in the
-- window") without touching the much larger set of ordinary (NULL) rows — a partial index on
-- "was measured at all" is a small fraction of the table's size because search_minute_request_count
-- is NULL on every row the rate limiter never actually reached a subject for, i.e. almost all of
-- them. Not indexed on a specific threshold value: kpi.ts's cutoff is a read-time constant that
-- can change, and an index on "IS NOT NULL" remains useful for any cutoff without being rebuilt.
CREATE INDEX IF NOT EXISTS idx_analytics_event_high_frequency
  ON analytics_event (user_or_session, created_at)
  WHERE search_minute_request_count IS NOT NULL;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS idx_analytics_event_high_frequency;
--   ALTER TABLE analytics_event DROP COLUMN IF EXISTS search_minute_request_count;
