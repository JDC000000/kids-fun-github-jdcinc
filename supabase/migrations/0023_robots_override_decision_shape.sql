-- 0023_robots_override_decision_shape.sql — QA finding F-QA-1 against 37cf56d: close a real
-- GATE/SCHEDULER DRIFT in the constraint 0022 added, by removing the thing the two
-- enforcement points were disagreeing about instead of trying to make them agree about it.
--
-- THE DEFECT, reproduced end-to-end by QA and again here before this was written.
-- 0022 asked "is the reference blank?" and each side answered with its own runtime's idea of
-- whitespace. PostgreSQL's bare `btrim()` strips SPACES ONLY; JavaScript's `String.trim()`
-- strips all whitespace. So a robots_override_decision consisting of a single TAB:
--     • passed 0022's CHECK              (Postgres: btrim(E'\t') is E'\t', which is <> '')
--     • satisfied the scheduler's SQL    → the row was ENQUEUED
--     • failed the TypeScript gate       ('\t'.trim() === '')  → the run was BLOCKED
-- Two enforcement points, opposite verdicts, on the same row. Fail-closed (no unauthorised
-- fetch), and reachable only by raw SQL rather than the application write path — but 0022's
-- own stated contract is that the invariant "holds for EVERY write path", and raw SQL is the
-- write path a CHECK constraint exists to cover. So it is fixed, not documented away.
--
-- WHY NOT SIMPLY WIDEN btrim(). QA suggested `btrim(x, E' \t\n\r\f\v')`. That closes tab and
-- newline and does NOT close the finding — measured on this exact image, not assumed:
--     btrim(U&'\00a0', E' \t\n\r\f\v') = ''  → false   (U+00A0 no-break space)
--     btrim(U&'\2003', E' \t\n\r\f\v') = ''  → false   (U+2003 em space)
-- while JavaScript's .trim() calls both blank. The identical drift survives, one character
-- further out. Full parity would mean tracking every character Unicode calls whitespace
-- across two engines that revise that set independently — a maintenance obligation with no
-- end, to support padding nobody wants stored anyway.
--
-- THE FIX — change the question, not the answer. A decision-record reference is an
-- identifier ('D-12', 'G-T10-2'), not free text; the note column holds prose. So both sides
-- now test SHAPE against one anchored ASCII allowlist:
--
--     ^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$
--
-- Locale-independent, encoding-independent, Unicode-version-independent, and verified to
-- return identical verdicts in PostgreSQL and JavaScript for every case tested — including
-- tab, newline, U+00A0, U+2003, empty, and padded. Whitespace is not in the allowlist, so
-- there is nothing left for the two engines to disagree about: parity by construction rather
-- than by two trim implementations happening to coincide. A padded '  D-12  ' is now
-- REJECTED rather than silently repaired, which is the correct direction for a field this
-- load-bearing: "looks almost right" must fail closed.
--
-- The pattern is mirrored by DECISION_REFERENCE_PATTERN in worker/core/terms-gate.ts, and
-- tests/scheduler/robots-override-db.test.ts reads THIS constraint back out of the catalog
-- and asserts the two still carry the same pattern — so the SQL and TS copies cannot drift
-- either, which is the same discipline the gate predicate itself is already held to.
--
-- Deps: 0022. Idempotent. Forward-only; reversible steps below.

-- ── forward ──────────────────────────────────────────────────────────────────

-- 1) Refuse to lock the door on a database that has a value the new shape rejects. Every
--    real database has at most NVDPL's 'D-12' here, so this is a no-op — but an override is
--    an authorisation a named human granted, and a migration must never silently rewrite or
--    revoke one to make itself pass. Fail loudly, name the rows, state the remedy.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%L (robots_override_decision=%L)', name, robots_override_decision), ', ')
    INTO offenders
    FROM source
   WHERE robots_override_decision IS NOT NULL
     AND robots_override_decision !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$';

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'source.robots_override_decision holds value(s) that are not well-formed decision references: %. Resolve each by hand before applying 0023 — set the intended reference (e.g. UPDATE source SET robots_override_decision = ''D-12'' WHERE name = ...), or clear BOTH robots_override_decision and robots_override_note if the override no longer applies. This migration will not guess which, because the value records a human authorisation.',
      offenders
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- 2) Replace the blank test with the shape test. Dropped and re-added under a NEW name: the
--    old name said "nonblank", which is no longer what it checks, and a constraint whose name
--    misdescribes it is how the next reader gets the wrong idea about what is guaranteed.
DO $$
BEGIN
  ALTER TABLE source DROP CONSTRAINT IF EXISTS source_robots_override_decision_nonblank;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_robots_override_decision_shape') THEN
    ALTER TABLE source ADD CONSTRAINT source_robots_override_decision_shape
      CHECK (robots_override_decision IS NULL
             OR robots_override_decision ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$');
  END IF;
END $$;

COMMENT ON COLUMN source.robots_override_decision IS
  'Decision-record reference (e.g. ''D-12'') authorising live fetch despite an UNREADABLE robots.txt. NULL for every ordinary source. Only grants the gate when robots_status = ''unknown''. Must match ^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$ — an identifier, not prose, and no surrounding whitespace: the shape test is what keeps the SQL and TypeScript enforcement points from disagreeing (F-QA-1). See docs/source-register.md §7 F-5.';

-- ── rollback ────────────────────────────────────────────────────────────────
--   ALTER TABLE source DROP CONSTRAINT IF EXISTS source_robots_override_decision_shape;
--   ALTER TABLE source ADD CONSTRAINT source_robots_override_decision_nonblank
--     CHECK (robots_override_decision IS NULL OR btrim(robots_override_decision) <> '');
--   -- NB: reverting reopens F-QA-1 (a tab-only reference passes here and fails the TS gate).
--   -- worker/core/terms-gate.ts would have to be reverted in the same breath, or the two
--   -- enforcement points go back to disagreeing.
