-- 0030_dedup_pair_adjudication.sql — make a human's "not a duplicate" verdict DURABLE.
--
-- THE DEFECT. lib/llm/dedup.ts routes cross-source duplicate candidates to the QA queue and
-- never auto-merges. A human answers, and the answer is forgotten. Measured end to end on a
-- pristine local Postgres at 8fe626802032116261557376b1cfb50639fcc882, driving the real code
-- (runDedupDetectOnlyUseCase + app/admin/qa-queue/_lib/data.ts rejectDedupPair):
--
--   run 1        routed the pair; decision row route_to_review(target=B, related=A);
--                B → 'manual_candidate'
--   human reject returned ok; B → 'confirmed'
--   run 2        SAME pair detected again, routed again; B → 'manual_candidate' again
--
-- The reject is not merely un-recorded, it is self-defeating. rejectDedupPair sets
-- status_state='confirmed', which the detector's `fresh` CTE ACCEPTS (it excludes only
-- 'manual_candidate'), and its last_checked_at bump clears the incremental watermark
-- (lib/llm/watermark.ts watermarkPredicate reads greatest(created_at, coalesce(last_checked_at,
-- created_at))). So the act of dismissing a pair is precisely what re-qualifies it.
--
-- ── WHY A PAIR TABLE AND NOT A COLUMN ───────────────────────────────────────────────────────
-- The verdict is PAIR-SCOPED: "B is not a duplicate of A" says nothing about B versus C. Any
-- marker on the ROW ("this occurrence is done with dedup") discards a genuine duplicate of C
-- silently — an invisible false split, the same failure class lib/llm/dedup.ts's venue
-- reasoning declines to create. status_state cannot carry it either, and is already carrying
-- more than it can hold: it is simultaneously a visibility ratchet (lib/search/filters/status.ts)
-- and a safety invariant (0021's trigger REFUSES 'confirmed' for a non-terms-approved source).
--
-- Not llm_batch_decision (0019), though it is pair-shaped and would technically work — the
-- admin path writes through the same owner pool the nightly job already INSERTs with. It is
-- declined on the READ side: it is APPEND-ONLY by design, and a suppression predicate needs
-- CURRENT truth. A bare NOT EXISTS against an append-only log is correct only while no row
-- ever reverses another; the first time "un-reject" is wanted it must become a windowed
-- latest-row query inside the detector's hot join. Here, un-reject is a DELETE against the
-- unique key below. Two further reasons: it would make a purely descriptive audit table
-- load-bearing (nothing reads it to decide whether to act today), and its `action` vocabulary
-- is enforced by nothing and has already drifted — see the CHECK note below.
--
-- ── WHY THE KEY IS ORDER-CANONICAL (least/greatest), AND WHY NOT FOR THE OBVIOUS REASON ─────
-- NOT because the detector presents the pair in both orders. It does not: lib/llm/dedup.ts
-- chooseCanonical ranks on [authority_tier, confidence_label, created_at, id] and terminates
-- in `id`, while the detection SQL guarantees r.id <> f.id — so the tie always resolves before
-- the argument-order fallback, and (target_id, related_id) is stable for a given pair. Swept
-- 2592 rank-space combinations forward and reversed at 8fe6268: 0 asymmetric.
--
-- It is order-canonical because that stability is CONTINGENT, not structural. rank() reads
-- confidence_label, and app/admin/corrections/_lib/data.ts resolveCorrectionReport UPDATEs
-- confidence_label from a live admin surface. One unrelated correction to either side's
-- confidence flips the roles, and an ordered key would then stop matching — silently, in the
-- permissive direction, re-opening a pair a human already closed. least/greatest costs nothing
-- and removes the contingency entirely. The CHECK below is what makes the canonical form an
-- invariant of the data rather than a convention every writer must remember.
--
-- ── forward ──────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dedup_pair_adjudication (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The unordered pair, stored canonically: low < high. Enforced, not conventional.
  occurrence_low   uuid NOT NULL,
  occurrence_high  uuid NOT NULL,
  -- The verdict is DATA, not an implication of the table's name. A table called
  -- "adjudication" that records only an implicit verdict carries its meaning in the reader
  -- instead of the record: every consumer must know out of band that the only thing ever
  -- stored is a rejection, and the day a second verdict exists every existing consumer is
  -- silently wrong with nothing to tell them.
  --
  -- THE CHECK IS THE POINT, not decoration. 0019's `action` column documents its vocabulary
  -- in a COMMENT with no constraint, and that vocabulary has already rotted: it names
  -- 'skip_low_confidence', which appears in no .ts file in this repo, while the code actually
  -- writes 'skip' (lib/llm/dedup.ts). A vocabulary that lives only in a comment is a
  -- vocabulary that drifts. Adding a second verdict here must be a migration, deliberately.
  verdict          text NOT NULL,
  -- admin_user.user_id of the human who decided. NULLABLE and deliberately NOT an FK: the
  -- verdict must outlive the admin account, exactly as 0019's decisions must outlive the
  -- record's archival. An FK here would make deactivating a reviewer either fail or cascade
  -- away the reason a pair is suppressed.
  decided_by       uuid,
  note             text,
  decided_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dedup_pair_adjudication_canonical_order CHECK (occurrence_low < occurrence_high),
  CONSTRAINT dedup_pair_adjudication_verdict_known CHECK (verdict IN ('not_duplicate'))
);

-- No FK to activity_occurrence on either side — same durability rationale 0019 states for
-- itself. A verdict that vanishes when one member is later archived (or merged away by an
-- UNRELATED pair's adjudication) would re-open a decision a human already made.

-- Serves the detector's suppression lookup directly AND makes a second adjudication of the
-- same pair an error rather than a silent second row. See lib/llm/dedup.ts for why the
-- write is allowed to raise instead of ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dedup_pair_adjudication_pair
  ON dedup_pair_adjudication (occurrence_low, occurrence_high);

-- ── lockdown: default-deny RLS + REVOKE (service/owner only) ────────────────────────────────
-- Same two-barrier posture as 0019_llm_batch_run.sql / 0018_public_tables_default_deny_rls.sql.
-- This table is written by the admin QA surface and read by the nightly detector, both through
-- the DATABASE_URL owner pool (lib/db/client.ts getPool — which lib/admin/audit.ts
-- withAdminTransaction and lib/llm/db.ts withServiceTransaction BOTH borrow from). The owner
-- bypasses RLS by design; anon/authenticated get nothing at either layer.
--
-- The stakes are not merely "an ops table leaked". A row here SUPPRESSES duplicate detection.
-- Write access for an untrusted role would let anyone silently switch off dedup for any pair
-- of occurrences, and read access would expose which listings a human judged related.
ALTER TABLE dedup_pair_adjudication ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON dedup_pair_adjudication FROM anon, authenticated;

-- ── rollback (reversible) ────────────────────────────────────────────────────────────────────
-- Dropping the table removes its RLS state, grants and index with it.
--   DROP TABLE IF EXISTS dedup_pair_adjudication;
