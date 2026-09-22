-- 0051_search_rate_limit.sql — the rate-limit counters behind GET /api/search.
--
-- ═══ THE ABUSE THIS EXISTS TO STOP ═══
-- 2026-09-22, live in production: a single caller has been hitting /search then /api/search with
-- the identical query "soft play" (one of the home page's own quick-link searches) every 1-3
-- seconds, 24/7, since at least 2026-08-28 — 500-600 hits per 5-minute window, recurring
-- constantly. Against a real user base of 4 signups, this is the overwhelming majority of
-- analytics_event's 3.2M rows, and it has made DAU/MAU meaningless. GET /search and GET
-- /api/search had NO rate limit of any kind before this migration — nothing has ever slowed this
-- down. See docs/incidents (or the 2026-09-22 delegation report) for the full investigation: it is
-- external traffic (a script that respects Set-Cookie, so it reads as "one session"), not
-- anything this repo schedules or runs.
--
-- ═══ WHY A NEW TABLE, FOLLOWING THE EXACT PRECEDENT OF sms_signup_throttle (0045) ═══
-- Same reasoning, copied deliberately rather than re-derived: an in-memory counter is not durable
-- across serverless invocations (not a throttle at all), and a check-then-insert statement is not
-- atomic under concurrency (two simultaneous requests both see "0 attempts so far" and both are
-- let through). The ON CONFLICT ... DO UPDATE ... WHERE upsert below is the same one-round-trip,
-- row-locking pattern lib/sms/throttle.ts::countAttempt uses, generalised to TWO window sizes
-- instead of one.
--
-- ═══ WHY TWO WINDOW SIZES, NOT ONE ═══
-- sms_signup_throttle buckets by UTC calendar day because "3 a day" is the shape of that abuse.
-- This abuse is a tight loop (1-3s intervals), so a per-day bucket would let the whole day's quota
-- burn in the first minute. A per-minute bucket alone would let a caller who paces themselves to
-- exactly the per-minute ceiling run indefinitely at that rate. Two buckets close both gaps with
-- one extra row per subject: 'ip_minute'/'session_minute' catch the burst, 'ip_hour'/
-- 'session_hour' catch the caller who throttles themselves just under the per-minute cap.
--
-- ═══ IP AND SESSION, BOTH, FOR THE SAME REASON sms_signup_throttle CHECKS PHONE AND IP ═══
-- 'session' (the kf_anon_id cookie, HMAC'd) is the precise identity when the caller keeps a
-- cookie jar — which the live incident shows this caller does. 'ip' is defence in depth for a
-- caller that DOESN'T carry cookies (a fresh anon id, and therefore a fresh session-scope subject,
-- on every single request) — without it, an attacker could evade the whole limiter by simply
-- dropping the Set-Cookie response.
--
-- ═══ WHAT IS AND IS NOT STORED — HASHES ONLY, SAME AS EVERY OTHER THROTTLE TABLE ═══
-- 'ip' subjects are HMAC-SHA256 under SMS_PHONE_HASH_SALT (see lib/security/search-rate-limit.ts),
-- domain-separated with a 'search-rate-ip:' prefix so this family cannot collide with the
-- 'sms-signup-ip:' family sharing the same salt. 'session' subjects use a 'search-rate-session:'
-- prefix over the anon session id, which is already non-PII (lib/db/session.ts) but is hashed
-- anyway for the same reason every other throttle subject is: this table should not become a
-- second, easier-to-query directory of session ids. Neither a raw IP address nor a raw session id
-- is ever written here.
--
-- ═══ RETENTION ═══
-- A short-lived counter, not an audit trail. idx_search_rate_limit_window exists to make a future
-- sweep of past-window rows a cheap ranged delete, exactly like idx_sms_signup_throttle_window —
-- the sweep itself is not scheduled here, matching that precedent's own deferral.
--
-- ═══ RLS: default-deny, like every other public table (0017/0018/0033/0034/0045) ═══

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS search_rate_limit (
  -- Four buckets in one table: WHICH identity (ip/session) crossed with WHICH window
  -- (minute/hour). One row shape, one decision statement — see lib/security/search-rate-limit.ts.
  scope           text NOT NULL CHECK (scope IN ('ip_minute', 'ip_hour', 'session_minute', 'session_hour')),

  -- HMAC-SHA256(SMS_PHONE_HASH_SALT, 'search-rate-ip:' || ip)         for scope IN ('ip_minute','ip_hour')
  -- HMAC-SHA256(SMS_PHONE_HASH_SALT, 'search-rate-session:' || sid)   for scope IN ('session_minute','session_hour')
  subject_hash    text NOT NULL,

  -- The bucket this row counts, truncated to the scope's window size (60s or 3600s) so concurrent
  -- requests in the same window collide on the same primary key and serialise through the row
  -- lock. Computed by the caller (date_trunc-equivalent), not by a DEFAULT, so the bucket boundary
  -- is one definition (lib/security/search-rate-limit.ts) rather than split between app and SQL.
  window_start    timestamptz NOT NULL,

  -- Attempts ALLOWED in this bucket. A refused attempt does not increment it, for the same reason
  -- sms_signup_throttle's `attempts` doesn't: hammering a closed limit must not extend the
  -- caller's own lockout or corrupt the count a real, slower caller would see.
  attempts        integer NOT NULL DEFAULT 1,

  last_attempt_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (scope, subject_hash, window_start)
);

CREATE INDEX IF NOT EXISTS idx_search_rate_limit_window
  ON search_rate_limit (window_start);

COMMENT ON TABLE search_rate_limit IS
  'Rate-limit counters for GET /search and GET /api/search — one row per (scope, subject, '
  'window). Hashes only: no raw IP and no raw session id. A short-lived counter, not an audit '
  'trail; any row whose window_start has fully elapsed is safe to delete. Added 2026-09-22 in '
  'direct response to a live abuse incident — see this migration''s header.';

COMMENT ON COLUMN search_rate_limit.scope IS
  'ip_minute/ip_hour = defence against a caller that does not keep a cookie jar (a fresh anon '
  'session on every request would otherwise dodge a session-only limit). session_minute/'
  'session_hour = the precise limit for a caller that DOES keep cookies, which is what the '
  '2026-09-22 incident traffic does.';

COMMENT ON COLUMN search_rate_limit.attempts IS
  'Counts ALLOWED attempts only, exactly like sms_signup_throttle.attempts — see that column''s '
  'comment for why a refusal must not touch this value.';

ALTER TABLE search_rate_limit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON search_rate_limit FROM anon, authenticated;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS search_rate_limit;
