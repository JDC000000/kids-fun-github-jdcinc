-- 0032_occurrence_source_title.sql — P1-3: keep the source's own title wording after ingest
-- starts normalising the displayed one.
--
-- WHAT CHANGED ABOVE THIS COLUMN. worker/core/title.ts now strips source-system packaging out
-- of a listing title at ingest: vendor field delimiters (`|Public Swim|` arrives with the
-- pipes attached), a `$`-marked price, and a weekday/clock-time fragment. Every one of those
-- three facts is ALREADY a column on this table — cost_min_cad/cost_max_cad/cost_status and
-- start_datetime_utc/end_datetime_utc — and is already rendered beside the title on the card,
-- so `$3 Open Gym 8yrs+ Delbrook Thursday 3:30-5:00pm` was repeating structured data back at
-- the reader in the vendor's punctuation.
--
-- WHY THE RAW STRING NEEDS ITS OWN COLUMN. `activity_name` is the only place the source's
-- wording has ever been recorded. Normalising it in place, with nowhere for the original to
-- go, would mean the pipeline permanently destroyed source text on the way in — and the one
-- thing this project does not do is silently drop what a source actually said (0025's geo
-- provenance, 0026's health verdict and 0024's venue phone are all the same argument). The
-- detail page and the correction-report workflow both need to be able to answer "what did the
-- page actually say?", and after this change `activity_name` can no longer answer it.
--
-- NULL SEMANTICS, STATED ONCE SO NOBODY HAS TO GUESS. The writer sets this on EVERY upsert,
-- unconditionally — including for titles the normaliser did not change. That is deliberate
-- and it is the whole reason the column is unambiguous:
--
--     source_title IS NULL   ⇔   this row has not been re-ingested since 0032 shipped.
--
-- Populating it only when normalisation changed something would have saved a few bytes per
-- row and bought a null that means EITHER "the source said exactly this" OR "this row is
-- pre-0032", with no way to distinguish them. That is precisely the ambiguity 0031's own null
-- note argues against. A reader may therefore treat a non-null source_title as a complete
-- statement of the source's wording, and a null as "not recorded yet", never as "unchanged".
--
-- NOT BACKFILLED, AND THAT IS THE HONEST OUTCOME. For historical rows `activity_name` still
-- holds the un-normalised source string, so `UPDATE ... SET source_title = activity_name`
-- would be correct TODAY — and would become a lie the instant the normaliser first rewrites
-- one of those rows, because the backfilled value would then be indistinguishable from a
-- genuinely observed one while having been inferred rather than observed. History fills in
-- naturally: every source is re-ingested on its cadence, and each row's first run after this
-- migration records the real thing. Rows that never run again were never going to be
-- normalised either, so their activity_name remains the source wording regardless.
--
-- NOTHING READS IT YET, DELIBERATELY. No UI, no search field, no filter keys off this column
-- in this change set — the ticket that introduced it is an ingest-time change and wiring a
-- detail-page surface is a separate, separately reviewable one. The column exists so the
-- information is not lost in the meantime.
--
-- DEPLOY NOTE. Additive and nullable: no table rewrite, no lock beyond the catalogue update,
-- safe to apply while the worker is running unmigrated. ORDER STILL MATTERS, for the same
-- reason as 0031 — worker/core/upsert.ts's INSERT now names `source_title`, so a worker build
-- shipped BEFORE this migration fails that INSERT for EVERY record in EVERY family. APPLY
-- THIS MIGRATION FIRST, THEN SHIP THE WORKER. Apply to kids-fun-supabase-staging and
-- kids-fun-supabase-prod as two separate deliberate steps (see 0027).
ALTER TABLE activity_occurrence ADD COLUMN source_title text;

COMMENT ON COLUMN activity_occurrence.source_title IS
  'The source''s own title wording, as published, before worker/core/title.ts stripped its '
  'packaging (vendor pipe/bracket delimiters, a $-marked price, a weekday/clock-time '
  'fragment — all three already held in their own columns on this table). Contrast '
  'activity_name, which is the normalised name the catalogue displays and indexes. Written '
  'on EVERY upsert, including when normalisation changed nothing, so NULL has exactly one '
  'meaning: this row has not been re-ingested since migration 0032. NULL never means '
  '"unchanged". Not backfilled — an inferred value here would be indistinguishable from an '
  'observed one.';

-- No index. Nothing queries or joins on this column, and it is not in the FTS vector: the
-- 0010 trigger builds search_tsv from activity_name (weight A) and description_snippet, and
-- adding the pre-normalisation string to it would re-introduce the price and time tokens into
-- search that this whole unit exists to take out of the title.
--
-- Rollback (manual, forward-only runner never executes this):
--   ALTER TABLE activity_occurrence DROP COLUMN IF EXISTS source_title;
