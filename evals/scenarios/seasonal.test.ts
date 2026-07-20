// evals/scenarios/seasonal.test.ts — G-T12-4: seasonal-state correctness fixtures
// (TSD §7.1, scenarios T-07/08/09). Proves the Adapter E watcher + map + manual
// intake produce the right season_state for the three canonical seasonal cases:
//   T-07  Stanley Park miniature train — suspended (never bookable this season)
//   T-08  Burnaby Central Railway     — pre_season -> in_season transition
//   T-09  Cypress Mountain            — manual winter record carries age/height notes
// Pure (no DB / no network): drives the watcher off captured fixture text.
import { describe, it, expect } from 'vitest';
import { SeasonalWatcher, getSeasonalSource } from '../../worker/adapters/seasonal';
import { mapSignalToSeasonState, resolveSeasonState } from '../../worker/adapters/seasonal/map';
import {
  validateManualSeasonalRecord,
  toSeasonOverride,
  type ManualSeasonalRecord,
} from '../../worker/adapters/seasonal/manual';

describe('T-07 — Stanley Park miniature train is suspended (never bookable)', () => {
  it('classifies the official offline status as suspended', () => {
    const config = getSeasonalSource('stanley-park-train');
    expect(config).toBeDefined();
    const watcher = new SeasonalWatcher(config!);

    const signal = watcher.extract(config!.fixtureStatusText);

    expect(signal.signal).toBe('suspended');
    expect(mapSignalToSeasonState(signal.signal)).toBe('suspended');
  });

  it('is fixture-only — never live-fetches even if the env allow-list names it', () => {
    const config = getSeasonalSource('stanley-park-train')!;
    const prev = process.env.KIDS_FUN_LIVE_SEASONAL;
    process.env.KIDS_FUN_LIVE_SEASONAL = 'stanley-park-train';
    try {
      expect(config.liveStatusUrl).toBeUndefined();
      expect(new SeasonalWatcher(config).isLiveFetchEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.KIDS_FUN_LIVE_SEASONAL;
      else process.env.KIDS_FUN_LIVE_SEASONAL = prev;
    }
  });
});

describe('T-08 — Burnaby Central Railway transitions pre_season -> in_season', () => {
  const config = getSeasonalSource('burnaby-central-railway')!;
  const watcher = new SeasonalWatcher(config);

  it('reads a pre-season announcement as pre_season', () => {
    // The captured fixture is the pre-opening snapshot ("season opens Good Friday…").
    const signal = watcher.extract(config.fixtureStatusText);
    expect(signal.signal).toBe('opening_soon');
    expect(mapSignalToSeasonState(signal.signal)).toBe('pre_season');
  });

  it('reads the in-season "now open" status as in_season', () => {
    const inSeasonText =
      'The Burnaby Central Railway is now open. Trains are running weekends, 11am to 5pm, ' +
      'from Easter to Canadian Thanksgiving.';
    const signal = watcher.extract(inSeasonText);
    expect(signal.signal).toBe('open');
    expect(mapSignalToSeasonState(signal.signal)).toBe('in_season');
  });

  it('yields a full pre_season -> in_season transition across the two reads', () => {
    const pre = mapSignalToSeasonState(watcher.extract(config.fixtureStatusText).signal);
    const now = mapSignalToSeasonState(
      watcher.extract('The railway is now open for the season; trains running daily.').signal
    );
    expect([pre, now]).toEqual(['pre_season', 'in_season']);
  });
});

describe('T-09 — Cypress manual seasonal record carries winter + age/height notes', () => {
  const record: ManualSeasonalRecord = {
    sourceKey: 'cypress-mountain',
    title: 'Cypress Mountain — winter downhill & tube park (kids)',
    seasonState: 'in_season',
    operatingWindow: { note: 'Winter season (typically Dec–Mar), snow/weather dependent' },
    weatherNotes: 'Downhill and tube-park operations are snow- and weather-dependent — check the daily report.',
    ageMinMonths: 36, // ski/snowboard school programs start around age 3
    heightMinCm: 91, // representative tube-park minimum height rule
    ageHeightNotes: 'Ski/snowboard school kids programs from ~age 3; tube park has a minimum height rule.',
    recordedBy: 'ops:test',
    overrideReason: 'Operator-declared winter operations for the kids programs.',
  };

  it('validates and preserves the winter + age/height notes', () => {
    const parsed = validateManualSeasonalRecord(record);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.weatherNotes).toMatch(/weather|snow/i);
    expect(parsed.value.ageHeightNotes).toMatch(/age|height/i);
    expect(parsed.value.ageMinMonths).toBe(36);
    expect(parsed.value.heightMinCm).toBe(91);
  });

  it('drives the manual override — operator state wins over any watched signal', () => {
    const override = toSeasonOverride(record);
    // Even a "closed_seasonal" signal is overridden by the operator's declared state.
    const closedSignal = new SeasonalWatcher(getSeasonalSource('cypress-mountain')!).extract(
      'Cypress Mountain is closed for the season.'
    );
    expect(closedSignal.signal).toBe('closed_seasonal');
    const mapping = resolveSeasonState(closedSignal, override);
    expect(mapping.origin).toBe('manual_override');
    expect(mapping.seasonState).toBe('in_season');
    expect(mapping.reason).toContain('winter');
  });
});
