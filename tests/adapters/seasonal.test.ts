// tests/adapters/seasonal.test.ts — G-T12-1/2/3 unit coverage for the seasonal
// status watcher, the signal->season_state map, and the manual seasonal intake.
// Pure + fetch-mocked; no real network, no DB. The live path is exercised with a
// stubbed global fetch so the gating + tag-stripping logic is covered without ever
// touching a real status page.
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  SeasonalWatcher,
  classifyStatusText,
  loadSeasonalWatchers,
  getSeasonalSource,
  type SeasonalSignal,
  type SeasonalStatusSignal,
} from '../../worker/adapters/seasonal';
import {
  mapSignalToSeasonState,
  resolveSeasonState,
} from '../../worker/adapters/seasonal/map';
import {
  validateManualSeasonalRecord,
  toSeasonOverride,
} from '../../worker/adapters/seasonal/manual';

function sig(signal: SeasonalSignal, extra: Partial<SeasonalStatusSignal> = {}): SeasonalStatusSignal {
  return {
    sourceKey: 'k',
    sourceName: 'Test Source',
    signal,
    matchedText: 'x',
    weatherRelated: false,
    live: false,
    observedAtIso: '2026-07-20T00:00:00.000Z',
    ...extra,
  };
}

describe('classifyStatusText', () => {
  const cases: Array<{ text: string; expected: SeasonalSignal; weather?: boolean }> = [
    { text: 'The report says: OPEN. Lifts now open.', expected: 'open' },
    { text: 'The pool is currently open for the season.', expected: 'open' },
    { text: 'Season opens Good Friday, April 3. Opening soon!', expected: 'opening_soon' },
    { text: 'We reopen in the spring — see you next season.', expected: 'opening_soon' },
    { text: 'Closed for the season. See you next year.', expected: 'closed_seasonal' },
    { text: 'This attraction is out of season until the spring.', expected: 'closed_seasonal' },
    { text: 'The train is temporarily closed and not currently running.', expected: 'suspended' },
    { text: 'Service is suspended until further notice.', expected: 'suspended' },
    { text: 'The lifts are closed today due to high winds and poor weather.', expected: 'suspended', weather: true },
    { text: 'Welcome to the mountain. Buy tickets online.', expected: 'unknown' },
  ];

  for (const c of cases) {
    it(`classifies "${c.text.slice(0, 40)}…" as ${c.expected}`, () => {
      const r = classifyStatusText(c.text);
      expect(r.signal).toBe(c.expected);
      expect(r.weather).toBe(c.weather === true);
      if (c.expected !== 'unknown') expect(r.matchedText.length).toBeGreaterThan(0);
    });
  }
});

describe('mapSignalToSeasonState', () => {
  it('maps each signal to the right season_state', () => {
    expect(mapSignalToSeasonState('open')).toBe('in_season');
    expect(mapSignalToSeasonState('opening_soon')).toBe('pre_season');
    expect(mapSignalToSeasonState('closed_seasonal')).toBe('post_season');
    expect(mapSignalToSeasonState('suspended')).toBe('suspended');
    expect(mapSignalToSeasonState('unknown')).toBe('unknown');
  });
});

describe('resolveSeasonState', () => {
  it('maps the signal when there is no override', () => {
    const m = resolveSeasonState(sig('open', { matchedText: 'now open' }));
    expect(m.origin).toBe('signal');
    expect(m.seasonState).toBe('in_season');
    expect(m.reason).toContain('now open');
  });

  it('lets a manual override win over the signal', () => {
    const m = resolveSeasonState(sig('suspended'), {
      seasonState: 'in_season',
      reason: 'operator says open',
      setBy: 'ops:1',
    });
    expect(m.origin).toBe('manual_override');
    expect(m.seasonState).toBe('in_season');
    expect(m.reason).toContain('ops:1');
  });

  it('flags a weather hold in the reason', () => {
    const m = resolveSeasonState(sig('suspended', { weatherRelated: true, matchedText: 'closed due to weather' }));
    expect(m.seasonState).toBe('suspended');
    expect(m.reason).toContain('weather hold');
  });
});

describe('SeasonalWatcher fetch/extract (fixture-first, live-gated)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KIDS_FUN_LIVE_SEASONAL;
  });

  it('returns fixture text (no network) when live is not enabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const watcher = new SeasonalWatcher(getSeasonalSource('cypress-mountain')!);

    const { text, live } = await watcher.fetch();

    expect(live).toBe(false);
    expect(text.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a fixture-only source never live-fetches, even when named in the env allow-list', () => {
    process.env.KIDS_FUN_LIVE_SEASONAL = 'stanley-park-train,burnaby-central-railway,grouse-mountain';
    for (const key of ['stanley-park-train', 'burnaby-central-railway', 'grouse-mountain']) {
      const config = getSeasonalSource(key)!;
      expect(config.compliance.livePosture).toBe('fixture-only');
      expect(new SeasonalWatcher(config).isLiveFetchEnabled()).toBe(false);
    }
  });

  it('a live-capable source only live-fetches when opted in via the env allow-list', async () => {
    const config = getSeasonalSource('cypress-mountain')!;
    expect(config.compliance.livePosture).toBe('live-capable-gated');

    // Not opted in -> fixture.
    expect(new SeasonalWatcher(config).isLiveFetchEnabled()).toBe(false);

    // Opted in -> live fetch, and HTML is stripped to plain text for classification.
    process.env.KIDS_FUN_LIVE_SEASONAL = 'cypress-mountain';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        '<html><body><h1>Daily Report: OPEN</h1><script>ignore()</script> Lifts now open.</body></html>',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const watcher = new SeasonalWatcher(config);
    expect(watcher.isLiveFetchEnabled()).toBe(true);
    const signal = await watcher.watch();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signal.live).toBe(true);
    expect(signal.signal).toBe('open');
  });
});

describe('loadSeasonalWatchers', () => {
  it('builds one watcher per configured source', () => {
    const watchers = loadSeasonalWatchers();
    expect(watchers.length).toBeGreaterThanOrEqual(4);
    expect(watchers.every((w) => w.family === 'seasonal')).toBe(true);
  });
});

describe('validateManualSeasonalRecord', () => {
  const base = {
    sourceKey: 'cypress-mountain',
    title: 'Winter ops',
    seasonState: 'in_season' as const,
    recordedBy: 'ops:1',
  };

  it('accepts a valid record and derives an override', () => {
    const parsed = validateManualSeasonalRecord({ ...base, ageMinMonths: 36, heightMinCm: 91 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const override = toSeasonOverride(parsed.value);
    expect(override.seasonState).toBe('in_season');
    expect(override.setBy).toBe('ops:1');
  });

  it('rejects a bad season_state', () => {
    const parsed = validateManualSeasonalRecord({ ...base, seasonState: 'nope' as never });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.seasonState).toBeDefined();
  });

  it('rejects an implausible age / height', () => {
    const parsed = validateManualSeasonalRecord({ ...base, ageMinMonths: 9999, heightMinCm: -5 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.ageMinMonths).toBeDefined();
    expect(parsed.errors.heightMinCm).toBeDefined();
  });

  it('requires the mandatory identity fields', () => {
    const parsed = validateManualSeasonalRecord({ seasonState: 'in_season' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.sourceKey).toBeDefined();
    expect(parsed.errors.title).toBeDefined();
    expect(parsed.errors.recordedBy).toBeDefined();
  });
});
