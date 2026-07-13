import { describe, it, expect } from 'vitest';
import { loadPerfectMindAdapters, PERFECTMIND_TENANTS } from '../../worker/adapters/perfectmind';

// G-T8-1 — PerfectMind adapter scaffold (TSD §5.1 Adapter F).
describe('PerfectMind adapter scaffold (G-T8-1)', () => {
  it('loads Richmond + NVRC launch tenants and is a distinct family from ActiveNet', () => {
    const launch = PERFECTMIND_TENANTS.filter((t) => t.launchStatus === 'launch');
    expect(launch.map((t) => t.municipality)).toContain('Richmond');
    expect(launch.some((t) => t.municipality.includes('NVRC'))).toBe(true);
    const adapters = loadPerfectMindAdapters();
    expect(adapters.length).toBe(PERFECTMIND_TENANTS.length);
    expect(adapters[0].family).toBe('perfectmind'); // not 'activenet'
    expect(PERFECTMIND_TENANTS.every((t) => t.requiresRender)).toBe(true); // needs headless render
  });

  it('extracts structured drop-in records with category + age hints', async () => {
    const richmond = loadPerfectMindAdapters()[0]; // Richmond (first launch tenant)
    const records = richmond.extract(await richmond.fetch());
    expect(records.length).toBeGreaterThanOrEqual(2);
    const openGym = records.find((r) => r.title.includes('Open Gym'))!;
    expect(openGym.categoryHint).toBe('open_gym');
    expect(openGym.costStatus).toBe('free');
    expect(openGym.ageText).toBe('0-5 years');
    const swim = records.find((r) => r.title.includes('Swim'))!;
    expect(swim.categoryHint).toBe('public_swim');
    expect(swim.costStatus).toBe('known');
    // Dedup key is tenant-scoped + source-record-native.
    expect(richmond.dedupKeys(openGym).key).toContain('perfectmind::');
  });
});
