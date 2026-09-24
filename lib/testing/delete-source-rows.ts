// lib/testing/delete-source-rows.ts — remove everything ONE test-created source owns from the
// shared db-lane database.
//
// Why this exists: the db lane runs every DB suite serially against ONE database, and several
// read models aggregate across ALL rows (the search read model, coverage-status's per-region
// "last crawl", weekly-send candidate pools). A suite that leaves a confirmed, future-dated
// occurrence or a fresh `success` check run behind silently changes another suite's answer —
// which one fails then depends on file order. tests/coverage-status-db.test.ts failed exactly
// this way on residue from the venue ingest tests.
//
// Scoped to a single source id, never to a family or a name pattern, so it cannot touch rows
// another suite (or a developer's local data) owns. No FK below cascades except
// sms_click_event, hence the inner-out order.
import { query } from '../db/client';

export async function deleteSourceRows(sourceId: string): Promise<void> {
  const occurrencesOfSource = `SELECT o.id FROM activity_occurrence o
    JOIN activity_series s ON s.id = o.series_id WHERE s.source_id = $1`;
  for (const table of ['provenance', 'occurrence_category_tag', 'occurrence_age', 'correction_report', 'analytics_event']) {
    await query(`DELETE FROM ${table} WHERE occurrence_id IN (${occurrencesOfSource})`, [sourceId]);
  }
  await query(`DELETE FROM activity_occurrence WHERE id IN (${occurrencesOfSource})`, [sourceId]);

  // Venues are resolved by name and can be shared, so only a venue that no OTHER source's
  // series still points at goes with this one.
  const venues = await query<{ venue_id: string }>(
    `SELECT DISTINCT venue_id FROM activity_series WHERE source_id = $1 AND venue_id IS NOT NULL`,
    [sourceId]
  );
  await query(`DELETE FROM activity_series WHERE source_id = $1`, [sourceId]);
  for (const { venue_id } of venues) {
    await query(
      `DELETE FROM venue WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM activity_series WHERE venue_id = $1)`,
      [venue_id]
    );
  }

  for (const table of ['source_check_run', 'job_queue', 'analytics_event']) {
    await query(`DELETE FROM ${table} WHERE source_id = $1`, [sourceId]);
  }
  await query(`DELETE FROM source WHERE id = $1`, [sourceId]);
}
