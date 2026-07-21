-- 0021_confirmed_requires_terms_approval.sql — SAFETY INVARIANT (Round 27 incident,
-- documents/execution/kids-fun-round27-incident-approval-bypass-2026-07-21.md):
-- a write-time, STRUCTURAL guarantee that a user-visible activity_occurrence can never
-- persist as status_state='confirmed' unless its owning source is terms-approved for
-- production (source.terms_status IN ('allowed','summarise_only')).
--
-- WHY A TRIGGER (not a CHECK, not app-only code):
--   • A CHECK constraint can only reference columns of the SAME row. terms_status lives
--     two joins away (activity_occurrence.series_id → activity_series.source_id →
--     source.terms_status), so a CHECK cannot express this cross-table rule at all.
--   • The pre-existing enforcement (worker/core/terms-gate.ts, Round 23 G-T15-5) is a
--     FETCH-TIME gate: it stops the ingest pipeline fetching from a non-approved source,
--     but it is NOT a write-time invariant on the table. Any write path that doesn't
--     route through the fetch pipeline — a DB-backed test pointed at a real database
--     (the actual incident), a future bug, a manual SQL edit, a new admin action — could
--     silently set 'confirmed' on a pending source. A BEFORE INSERT/UPDATE trigger is
--     the only place the rule holds for EVERY write path, including raw SQL, now and in
--     the future. That is the "structural, not procedural" lesson of the Round 20 F-1
--     RLS incident, applied here.
--   • An application-level guard in the shared upsert (worker/core/upsert.ts) was
--     considered and rejected as the PRIMARY defence: it only covers callers that go
--     through that one function, would need an extra query (upsertOccurrence receives
--     series_id, not the source), and — being procedural — is exactly the kind of gate
--     this incident proved can be bypassed. The trigger subsumes it. (A thin app guard
--     could still be layered on later purely for a fail-fast error; it is not required
--     for the invariant to hold, and is intentionally not added to avoid a duplicated,
--     drift-prone second copy of the rule.)
--
-- APPROVED SET — {'allowed','summarise_only'}, IDENTICAL to terms-gate.ts's
-- APPROVED_TERMS_STATUSES (production-enablement). Deliberately NOT 'allowed' alone: a
-- legitimately terms-approved 'summarise_only' source is production-enabled by the fetch
-- gate and may therefore produce confirmed occurrences; restricting to 'allowed' only
-- would make the DB reject those legitimate rows (a false-positive breakage). Both the
-- incident case ('pending') and every 'disallowed'/'blocked' state remain correctly
-- rejected either way. The single source of truth for "what counts as approved" stays
-- terms-gate.ts; this migration mirrors that set and cites it so the two can't silently
-- diverge unnoticed.
--
-- SCOPE — 'confirmed' only, matching the incident and the auto-ingest gate
-- (confidence.ts statusForConfidence emits exactly 'confirmed'|'needs_review'). Other
-- user-visible ('primary') statuses (bookable_open, seasonal_active, manual_candidate…)
-- are reached only by LATER transitions (seasonal watcher, T14 dedup, T34 manual leads),
-- some of which legitimately run on non-scraped sources; broadening the guard to them
-- needs per-status analysis and is flagged as a deliberate follow-up, not fabricated
-- here. 'confirmed' is the canonical "verified, surfaced prominently" state and the only
-- user-visible status the auto-ingest write path can emit, so it is the right lever.
--
-- SECURITY DEFINER + locked search_path: the guard's internal lookup must always read
-- the TRUE source.terms_status regardless of RLS (source/activity_series are default-deny
-- RLS since 0018). Every legitimate writer today is the table owner (bypasses RLS), so
-- this is belt-and-suspenders; it guarantees the check is based on ground truth even if a
-- non-owner writer is ever granted INSERT. The function fails CLOSED (rejects) if the
-- owning source cannot be resolved — it can never fail open.
--
-- BACKFILL — self-healing + idempotent: BEFORE installing the trigger, any PRE-EXISTING
-- confirmed occurrence whose source is not approved is downgraded to 'needs_review'
-- (hidden from search until reviewed — STATUS_CLASS='hidden', lib/search/filters/
-- status.ts). This generalises the hand-cleanup the orchestrator applied to the
-- incident's 5 synthetic rows so that applying this migration to ANY database leaves it
-- consistent with the new invariant, not only future writes. Legitimate confirmed rows
-- (approved source) are untouched. A NOTICE reports the count for the migration log.
-- Re-runs find 0 rows (idempotent).
--
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS before CREATE, and the
-- heal UPDATE is naturally a no-op on a clean/consistent DB. Deps: 0004
-- (activity_occurrence, activity_series), 0003 (source), 0018 (RLS context). Forward-only;
-- reversible steps below.

-- ── forward ──────────────────────────────────────────────────────────────────

-- 1) Heal any PRE-EXISTING violations BEFORE locking the door, so the invariant holds
--    for existing data too, not only future writes. (Runs before the trigger exists;
--    the resulting rows are 'needs_review', not 'confirmed', so no re-entrancy concern.)
DO $$
DECLARE
  healed integer;
BEGIN
  WITH bad AS (
    UPDATE activity_occurrence o
       SET status_state = 'needs_review'
     WHERE o.status_state = 'confirmed'
       AND o.series_id IN (
         SELECT ser.id
           FROM activity_series ser
           JOIN source s ON s.id = ser.source_id
          WHERE s.terms_status NOT IN ('allowed', 'summarise_only')
       )
    RETURNING 1
  )
  SELECT count(*) INTO healed FROM bad;
  IF healed > 0 THEN
    RAISE NOTICE '0021 backfill: downgraded % confirmed occurrence(s) with non-approved source(s) to needs_review', healed;
  END IF;
END $$;

-- 2) The guard function.
CREATE OR REPLACE FUNCTION enforce_confirmed_requires_terms_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_terms_status text;
BEGIN
  -- Only 'confirmed' (user-visible/trusted) is gated; every other status is unaffected,
  -- and this early-return keeps non-confirmed writes essentially free.
  IF NEW.status_state <> 'confirmed' THEN
    RETURN NEW;
  END IF;

  SELECT s.terms_status
    INTO v_terms_status
    FROM activity_series ser
    JOIN source s ON s.id = ser.source_id
   WHERE ser.id = NEW.series_id;

  -- Fail CLOSED: an unresolvable owning source, or a source not terms-approved for
  -- production, both reject. Never fails open.
  IF v_terms_status IS NULL OR v_terms_status NOT IN ('allowed', 'summarise_only') THEN
    RAISE EXCEPTION
      'activity_occurrence % may not be status_state=confirmed: owning source terms_status=% is not terms-approved (allowed/summarise_only) — Round 27 approval-bypass invariant',
      COALESCE(NEW.id::text, '(new)'),
      COALESCE(v_terms_status, '(source unresolved)')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- 3) Fire on every INSERT and UPDATE. Firing on ALL columns (not `UPDATE OF status_state`)
--    is deliberate: it also catches re-pointing an already-confirmed row to a different,
--    pending series_id without touching status_state.
DROP TRIGGER IF EXISTS activity_occurrence_confirmed_terms_guard ON activity_occurrence;
CREATE TRIGGER activity_occurrence_confirmed_terms_guard
  BEFORE INSERT OR UPDATE ON activity_occurrence
  FOR EACH ROW EXECUTE FUNCTION enforce_confirmed_requires_terms_approval();

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TRIGGER IF EXISTS activity_occurrence_confirmed_terms_guard ON activity_occurrence;
--   DROP FUNCTION IF EXISTS enforce_confirmed_requires_terms_approval();
--   -- The needs_review backfill is a safe, deliberate data correction and is NOT
--   -- auto-reverted (re-confirming those rows is a future decision, per 0018's ethos).
