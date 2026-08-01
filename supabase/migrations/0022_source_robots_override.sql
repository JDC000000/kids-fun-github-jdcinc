-- 0022_source_robots_override.sql — F-5 (docs/source-register.md §7): an HONEST way to
-- record a source whose robots.txt genuinely CANNOT BE READ, where a named human decision
-- has accepted that risk for that source BY NAME.
--
-- THE PROBLEM. NVDPL (§6.8) is the first source on this project whose robots.txt is
-- unreadable: `nvdpl.events.mylibrary.digital/robots.txt` answers HTTP 403 behind a
-- Cloudflare managed challenge. The existing vocabulary
-- ('pending','allowed','disallowed','unknown', 0003_core_places.sql) has no value meaning
-- "unreadable, risk accepted by a named human decision":
--   • 'allowed'  would assert something nobody verified and nobody CAN verify. Every other
--                'allowed' row on this project is backed by a robots.txt a human actually
--                read; flattening this case into the same value erases exactly the
--                distinction decision record D-12 was scoped to preserve, and lets the next
--                source with this fact pattern inherit the clearance by copy-paste — which
--                D-12's own scope paragraph forbids.
--   • 'unknown'  is the honest FACT ("we looked; we could not determine"), but on its own it
--                is indistinguishable from "nobody has ever checked", which must keep
--                failing closed.
--
-- THE SHAPE CHOSEN (Option A, approved by Jon 2026-08-01). robots_status keeps its existing
-- vocabulary — 'unknown' already says the true thing — and the AUTHORISATION is recorded
-- beside it, in its own column, as a reference to the decision record that granted it.
-- "Unreadable" and "a human accepted that" are two different facts and are now stored as
-- two different facts. The gate passes on the CONJUNCTION, never on either half:
--
--     robots_status = 'allowed'
--  OR (robots_status = 'unknown' AND robots_override_decision is present and non-blank)
--
-- A source that is merely 'unknown' with no decision reference — i.e. genuinely never
-- checked — still fails closed, which is the whole point. The canonical statement of that
-- predicate lives ONCE, in worker/core/terms-gate.ts (isRobotsClearedForLiveFetch and its
-- SQL twin robotsClearedForLiveFetchSql), because the same rule previously had to be
-- authored twice in two languages and drifting one copy is precisely the trap QA found.
--
-- WHY NOT A NEW robots_status VALUE (F-5's option (b))? A new enum value would have to be
-- taught to every consumer of the column at once — the admin console vocab + its DB drift
-- guard, the two badge renderers, the scheduler SQL, the terms gate — and a consumer that
-- had not learned it yet would fall into whatever its `else` branch does, which is not
-- reliably fail-closed. Two NULLABLE columns are additive: every existing reader keeps
-- reading robots_status and keeps seeing the same values it always has, and a reader that
-- has not learned about the override simply does not grant it. Additive beats widening when
-- the widened case is the dangerous one.
--
-- BLAST RADIUS. Both columns are NULL for every row that exists today and for every row any
-- existing code path can create (nothing writes them: not the admin console's INSERT/UPDATE
-- column lists, not any seed but NVDPL's own targeted UPDATE). The override branch of the
-- gate is therefore unreachable for every source except the one row a human deliberately
-- marks — which is the definition of an exception mechanism rather than a new normal state.
--
-- Deps: 0003_core_places.sql (source). Idempotent (IF NOT EXISTS everywhere). Forward-only;
-- reversible steps below.

-- ── forward ──────────────────────────────────────────────────────────────────

ALTER TABLE source
  -- The decision record that authorised running this source with an UNREADABLE robots.txt
  -- (literally 'D-12' for NVDPL). A reference, deliberately not a boolean: "someone said
  -- yes" is not auditable; "D-12 said yes, for this source, on this date" is. This is the
  -- load-bearing field — the gate keys on THIS being present, not on the note.
  ADD COLUMN IF NOT EXISTS robots_override_decision text,
  -- One line of human context + a pointer to where the reasoning actually lives. Never the
  -- reasoning itself: the essay belongs in docs/source-register.md, and duplicating it into
  -- a DB column guarantees the two drift.
  ADD COLUMN IF NOT EXISTS robots_override_note text;

COMMENT ON COLUMN source.robots_override_decision IS
  'Decision-record reference (e.g. ''D-12'') authorising live fetch despite an UNREADABLE robots.txt. NULL for every ordinary source. Only grants the gate when robots_status = ''unknown''. See docs/source-register.md §7 F-5.';
COMMENT ON COLUMN source.robots_override_note IS
  'One-line human context for robots_override_decision plus a pointer to the written reasoning. Never a substitute for the decision reference.';

-- Three write-time invariants. Same philosophy as 0021: a fetch-time gate in application
-- code only covers callers that route through it, whereas a constraint holds for EVERY
-- write path — raw SQL, a future admin action, a DB-backed test, a bug.
DO $$
BEGIN
  -- 1) A BLANK decision reference is not a decision. Without this, robots_override_decision
  --    = '' is non-NULL and would satisfy any naive `IS NOT NULL` gate — a fail-OPEN hole
  --    in the exact field the whole mechanism keys on. (The TS/SQL predicates independently
  --    test for non-blank rather than relying on this; belt and braces, on purpose.)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_robots_override_decision_nonblank') THEN
    ALTER TABLE source ADD CONSTRAINT source_robots_override_decision_nonblank
      CHECK (robots_override_decision IS NULL OR btrim(robots_override_decision) <> '');
  END IF;

  -- 2) A note cannot exist without the decision it is supposedly explaining. A free-floating
  --    "risk accepted, see the docs" note READS like an authorisation to the next person
  --    while granting nothing — the ambiguity this whole flag exists to remove.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_robots_override_note_needs_decision') THEN
    ALTER TABLE source ADD CONSTRAINT source_robots_override_note_needs_decision
      CHECK (robots_override_note IS NULL OR robots_override_decision IS NOT NULL);
  END IF;

  -- 3) An override may NEVER sit on a row whose robots.txt was read and said no. Today's
  --    predicate already refuses that case (it only honours 'unknown'), so this constraint
  --    blocks no reachable bypass — it exists so that LOOSENING the predicate later (say to
  --    "anything that isn't 'allowed'") cannot silently turn an explicit Disallow into a
  --    cleared source. The one combination that must never be representable is not left
  --    resting on a predicate somebody might edit.
  --
  --    NOTE for whoever hits this: if a source's robots.txt becomes readable and says no,
  --    CLEAR the override first, then set robots_status = 'disallowed'. The constraint
  --    failing loudly in that order is correct behaviour, not an obstacle.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_robots_override_not_on_disallowed') THEN
    ALTER TABLE source ADD CONSTRAINT source_robots_override_not_on_disallowed
      CHECK (robots_override_decision IS NULL OR robots_status <> 'disallowed');
  END IF;
END $$;

-- No index: `source` is a registry of ~20 rows and the override is read as part of a row
-- already being fetched by primary key or by the scheduler's full scan. An index here would
-- be cost with no measurable benefit.

-- ── rollback ────────────────────────────────────────────────────────────────
--   ALTER TABLE source DROP CONSTRAINT IF EXISTS source_robots_override_not_on_disallowed;
--   ALTER TABLE source DROP CONSTRAINT IF EXISTS source_robots_override_note_needs_decision;
--   ALTER TABLE source DROP CONSTRAINT IF EXISTS source_robots_override_decision_nonblank;
--   ALTER TABLE source DROP COLUMN IF EXISTS robots_override_note;
--   ALTER TABLE source DROP COLUMN IF EXISTS robots_override_decision;
--   -- Dropping these columns re-blocks any source that was running under an override.
--   -- That is fail-closed, i.e. the safe direction, but it is a real behaviour change:
--   -- check `SELECT name FROM source WHERE robots_override_decision IS NOT NULL` first.
