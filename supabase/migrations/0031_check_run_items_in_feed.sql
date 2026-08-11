-- 0031_check_run_items_in_feed.sql — U1 Stage 0: record what the FEED sent, not just what
-- our cap let through.
--
-- THE GAP THIS CLOSES. `source_check_run.records_found` is incremented once per extracted
-- record by worker/core/ingest.ts, so it is identically the adapter's EMIT count — the
-- quantity our own `liveEventsLimit` censors. Every trailing baseline in this project is
-- computed from it (worker/core/checkrun.ts `loadRecordsFoundBaseline`, the mean of the last
-- 5 runs), which means our own configuration is an input to every yield-collapse threshold we
-- have. Two consequences, both live today:
--
--   1. A cap sitting BELOW vendor supply pins the baseline to the cap. The run that emits
--      exactly the cap looks identical whether the vendor sent that many or ten times that
--      many, so a genuine supply drop that lands above the cap is invisible.
--   2. The inverse is worse. A cap below supply means records are discarded on every HEALTHY
--      run, so any alert keyed on "we discarded something" fires forever on a working source
--      and stays silent on a genuinely short one.
--
-- `items_in_feed` is the same run measured BEFORE our cap touches it. On the BiblioCommons
-- path it is read from the raw response item count prior to any cap logic, and the live
-- request carries no limit parameter, so it is censored only by the VENDOR — which is exactly
-- the quantity every question here actually turns on.
--
-- THIS COLUMN HAS NEVER BEEN RECORDED, BY ANY ADAPTER, IN ANY RUN. That is not an oversight
-- being corrected in passing; it is the reason a whole class of claims about this project's
-- library sources ("the vendor page-caps at 25", "RPL drops exactly 5 records per run") are
-- arithmetic over an ASSUMED vendor page size rather than an observation. The single probe
-- those claims descend from covered one tenant at one moment and has never been replicated;
-- the other tenant has never been probed at all. Weeks of this column is what replaces that
-- assumption with a measurement — at zero extra network cost, since it falls out of a feed we
-- already fetch daily.
--
-- NOTHING READS IT YET, DELIBERATELY. No alert, no threshold, no panel keys off it in this
-- migration's change set. Declaring a vendor page-size constant now would mean inheriting the
-- unmeasured number — precisely the move that produced the defect this unit removes. The
-- constant gets declared from `max(items_in_feed)` per tenant once there is data to read it
-- off, which is a later, separately reviewable change.
--
-- DEPLOY NOTE FOR WHOEVER SHIPS THIS: apply to kids-fun-supabase-staging AND
-- kids-fun-supabase-prod as two separate deliberate steps, per this project's own
-- hard-learned rule (see 0027). ORDER MATTERS HERE SPECIFICALLY, MORE THAN USUAL:
-- `finishCheckRun`'s UPDATE now names `items_in_feed`. If the worker build ships BEFORE
-- this migration is applied, that UPDATE fails with "column does not exist" for EVERY
-- source in EVERY family, not just library — no check run finalises anywhere. APPLY THIS
-- MIGRATION FIRST, THEN SHIP THE WORKER. The reverse order is not safe; this direction is
-- (additive/nullable, no lock beyond the catalogue update, safe to apply while the worker
-- is running unmigrated — it simply won't populate the new column yet).
ALTER TABLE source_check_run ADD COLUMN items_in_feed integer;

COMMENT ON COLUMN source_check_run.items_in_feed IS
  'Items the source feed delivered this run, BEFORE any of our own filtering or capping — '
  'i.e. censored by the vendor only, never by liveEventsLimit. Contrast records_found, which '
  'is the adapter EMIT count and is cap-censored. NULL = this adapter/run reports no feed '
  'item count: a fixture run (recorded live-runs-only on purpose, so max(items_in_feed) reads '
  'as the vendor page size and a supply baseline stays live-only), or an adapter with no feed '
  'to count. Populated via Adapter.reportItemsInFeed → finishCheckRun.';

-- ── NO BACKFILL, AND THAT IS THE HONEST OUTCOME ─────────────────────────────────────────
-- Unlike 0026, whose alerts had already fired and were recoverable from the `errors` jsonb,
-- there is nothing to recover here: the number was never captured in any form, by any writer,
-- in any historical row. It is not derivable from `records_found` either — records_found is
-- the post-cap count, and inverting the cap would require knowing the vendor page size, which
-- is the very thing this column exists to measure. Any backfill would therefore be a
-- fabricated number wearing a measurement's clothes, which is the failure mode this whole
-- unit is a correction of.
--
-- History stays NULL. Consumers MUST treat NULL as "not measured", never as zero — a NULL row
-- says nothing about that run's feed, whereas 0 would assert the feed was empty. Queries that
-- aggregate this column must filter `items_in_feed IS NOT NULL` rather than coalesce to 0.
--
-- Additive and nullable: no rewrite of the table, no lock beyond the catalogue update, safe
-- to apply while the worker is running. Forward-only, like every migration here.
--
-- Rollback (manual, forward-only runner never executes this):
--   ALTER TABLE source_check_run DROP COLUMN IF EXISTS items_in_feed;
