// tests/ingestion/seasonal-watcher-db.test.ts — G-T12-1/2/3 end-to-end, DB-backed.
// Proves a watched status CHANGE on a fixture flows to a `source.season_state`
// TRANSITION that is queryable/visible through an EXISTING admin surface
// (app/admin/sources getSourceById / listSources) — with no other wiring. Also
// covers the manual override and the terms-gate short-circuit. Skips when
// DATABASE_URL is unset (mirrors the other DB-gated suites).
import { afterAll, describe, it, expect } from 'vitest';
import { getPool, query, closePool } from '@/lib/db/client';
import { getSourceById, listSources } from '@/app/admin/sources/_lib/data';
import { runSeasonalWatch } from '../../worker/adapters/seasonal';
import { applySeasonState } from '../../worker/adapters/seasonal/map';
import { toSeasonOverride } from '../../worker/adapters/seasonal/manual';
import type { SeasonalSourceConfig } from '../../worker/adapters/seasonal/config';

const hasDb = Boolean(process.env.DATABASE_URL);

const SUSPENDED_TEXT =
  'The train remains offline and is temporarily closed; it is not currently running. No rides are available.';
const OPEN_TEXT = 'Daily report: OPEN. The attraction is now open for the season; running daily.';
const CLOSED_SEASONAL_TEXT = 'Closed for the season. See you next year.';

/** A fixture-only test config (never live-fetches) bound to a given DB source name. */
function testConfig(sourceName: string, fixtureStatusText: string): SeasonalSourceConfig {
  return {
    key: 'cypress-mountain',
    sourceFamily: 'seasonal',
    sourceName,
    operator: 'Test Operator',
    statusPageUrl: 'https://example.org/status',
    liveStatusUrl: undefined, // fixture-only -> no network in tests
    compliance: {
      checkedIso: '2026-07-20',
      robotsSummary: 'test',
      termsNote: 'test',
      livePosture: 'fixture-only',
    },
    fixtureStatusText,
  };
}

describe.skipIf(!hasDb)('seasonal watcher -> season_state transition (G-T12, DB)', () => {
  const createdIds: string[] = [];

  afterAll(async () => {
    for (const id of createdIds) await query(`DELETE FROM source WHERE id = $1`, [id]);
    await closePool();
  });

  async function insertSeasonalSource(
    name: string,
    opts: { terms?: string; robots?: string } = {}
  ): Promise<string> {
    const [row] = await query<{ id: string }>(
      `INSERT INTO source (family, name, terms_status, robots_status)
       VALUES ('seasonal', $1, $2, $3)
       RETURNING id`,
      [name, opts.terms ?? 'allowed', opts.robots ?? 'allowed']
    );
    createdIds.push(row.id);
    return row.id;
  }

  it('applySeasonState writes the transition and it is visible via the admin surface', async () => {
    const pool = getPool();
    const id = await insertSeasonalSource(`Seasonal DB A ${crypto.randomUUID()}`);

    const t = await applySeasonState(pool, { id }, 'suspended', { reason: 'unit' });
    expect(t.from).toBe('unknown');
    expect(t.to).toBe('suspended');
    expect(t.changed).toBe(true);

    // The existing no-code admin sources read path reflects the new state.
    const admin = await getSourceById(id);
    expect(admin?.seasonState).toBe('suspended');
  });

  it('a fixture status CHANGE flows suspended -> in_season and shows in admin', async () => {
    const pool = getPool();
    const name = `Seasonal DB B ${crypto.randomUUID()}`;
    const id = await insertSeasonalSource(name);

    // First watch: the suspended fixture.
    const r1 = await runSeasonalWatch(pool, testConfig(name, SUSPENDED_TEXT), 'staging');
    expect(r1.ok).toBe(true);
    expect(r1.signal?.signal).toBe('suspended');
    expect(r1.transition?.from).toBe('unknown');
    expect(r1.transition?.to).toBe('suspended');
    expect(r1.transition?.changed).toBe(true);
    expect((await getSourceById(id))?.seasonState).toBe('suspended');

    // The status page changes (attraction opens): the watcher drives the transition.
    const r2 = await runSeasonalWatch(pool, testConfig(name, OPEN_TEXT), 'staging');
    expect(r2.ok).toBe(true);
    expect(r2.signal?.signal).toBe('open');
    expect(r2.transition?.from).toBe('suspended');
    expect(r2.transition?.to).toBe('in_season');
    expect(r2.transition?.changed).toBe(true);

    // Visible in BOTH the single-source and the list admin read paths.
    expect((await getSourceById(id))?.seasonState).toBe('in_season');
    const listed = (await listSources()).find((s) => s.id === id);
    expect(listed?.seasonState).toBe('in_season');
  });

  it('a manual override wins over the watched signal, end-to-end through the DB', async () => {
    const pool = getPool();
    const name = `Seasonal DB C ${crypto.randomUUID()}`;
    const id = await insertSeasonalSource(name);

    const override = toSeasonOverride({
      sourceKey: 'cypress-mountain',
      title: 'Cypress winter ops',
      seasonState: 'in_season',
      weatherNotes: 'snow dependent',
      ageHeightNotes: 'min age ~3; tube-park height rule',
      recordedBy: 'ops:test',
    });

    // The fixture says "closed for the season" but the operator override pins in_season.
    const r = await runSeasonalWatch(pool, testConfig(name, CLOSED_SEASONAL_TEXT), 'staging', override);
    expect(r.ok).toBe(true);
    expect(r.signal?.signal).toBe('closed_seasonal');
    expect(r.transition?.to).toBe('in_season');
    expect((await getSourceById(id))?.seasonState).toBe('in_season');
  });

  it('the terms gate blocks a blocked source and leaves season_state unchanged', async () => {
    const pool = getPool();
    const name = `Seasonal DB D ${crypto.randomUUID()}`;
    const id = await insertSeasonalSource(name, { terms: 'blocked' });

    const r = await runSeasonalWatch(pool, testConfig(name, OPEN_TEXT), 'staging');
    expect(r.ok).toBe(false);
    expect(r.gate.allowed).toBe(false);
    expect(r.error).toContain('blocked');

    // No transition applied — still the insert default.
    expect((await getSourceById(id))?.seasonState).toBe('unknown');
  });
});
