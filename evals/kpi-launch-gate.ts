// evals/kpi-launch-gate.ts — the launch-gate KPI catalogue + report assembler (G-T36-4).
//
// TSD §12.5 defines 22 success metrics. #1–#12 are the LAUNCH-GATE KPIs that T-36
// must validate before launch; #13–#22 are post-launch OPERATING KPIs (DAU/MAU trend
// baselines, Sentry/bug ops, latency-under-load, data-ops recovery) and are explicitly
// OUT of scope for this launch-gate validation. This module is the single source of
// truth for WHAT the 12 launch-gate KPIs are and HOW each is measured, plus a pure
// assembler that turns measured findings into an honest target-vs-actual report.
//
// It computes NOTHING itself and imports no DB — the measured values are supplied by
// evals/scenarios/kpi-launch-gate.test.ts, which reuses the real instrumentation
// (lib/analytics/kpi.ts, lib/analytics/benchmark.ts, lib/admin/dashboard.ts) and the
// eval harness (golden + UAT) rather than forking any metric.

/**
 * A KPI's current standing against its launch target:
 *   • 'met'     — measured and at/above target.
 *   • 'below'   — measured and short of target (an honest miss, not hidden).
 *   • 'no-data' — the instrumentation exists but there is not yet enough live data to
 *                 state a value (e.g. no analytics events / no ingested listings). NOT a
 *                 miss — the denominator is simply zero today.
 *   • 'manual'  — the true measure needs a human UAT session (e.g. <30s time-to-result);
 *                 the harness records the automatable precondition instead.
 */
export type KpiStatus = 'met' | 'below' | 'no-data' | 'manual';

/** One launch-gate KPI definition (TSD §12.5 #1–#12). */
export interface LaunchGateKpi {
  number: number;
  key: string;
  name: string;
  /** The §12.5 launch target text, verbatim. */
  target: string;
  /** Which TSD tasks instrument it (§12.5 "Instrumented by" column). */
  instrumentedBy: string;
  /** How THIS validation measures it — the concrete subsystem/harness reused. */
  measurementSource: string;
}

/** The 12 launch-gate KPIs, in §12.5 order. #13–#22 are operating KPIs, deliberately absent. */
export const LAUNCH_GATE_KPIS: readonly LaunchGateKpi[] = [
  {
    number: 1,
    key: 'search_success',
    name: 'Search success (relevant top-10)',
    target: '≥80%; "open gym near East Van" required benchmark',
    instrumentedBy: 'T-31/32/36',
    measurementSource: 'evals UAT + golden harness — benchmark search-success rate over the real search path',
  },
  {
    number: 2,
    key: 'result_density',
    name: 'Useful result density',
    target: '≥70% of valid searches surface ≥3 realistic options',
    instrumentedBy: 'T-32',
    measurementSource: 'evals UAT harness — densityPct over the real search path',
  },
  {
    number: 3,
    key: 'time_to_first_result',
    name: 'Time to first useful result (UAT)',
    target: '≥3 realistic activities in <30s',
    instrumentedBy: 'T-36',
    measurementSource: 'evals UAT harness — automatable content precondition (≥3 realistic in the first response); the <30s wall-clock is a human UAT session',
  },
  {
    number: 4,
    key: 'source_freshness_sla',
    name: 'Source freshness SLA',
    target: '≥95% of P0 sources checked within cadence',
    instrumentedBy: 'T-15/33',
    measurementSource: 'lib/admin/dashboard getHealthAlerts (staleSources) vs enabled sources / source_check_run',
  },
  {
    number: 5,
    key: 'card_completeness',
    name: 'Card completeness',
    target: '100% of confirmed cards carry the required fields',
    instrumentedBy: 'T-22/36',
    measurementSource: 'app/preview mapping over search results — required-field completeness (also tests/ui/card-completeness)',
  },
  {
    number: 6,
    key: 'zero_result_recovery',
    name: 'Zero-result recovery',
    target: '≥50% of zero-result sessions recover (broaden/click/save)',
    instrumentedBy: 'T-20/32',
    measurementSource: 'evals UAT harness (recovery rate) + lib/analytics/kpi.ts broadenedSearches',
  },
  {
    number: 7,
    key: 'source_ctr',
    name: 'Source click-through',
    target: '≥25% of sessions click a source/detail CTA',
    instrumentedBy: 'T-31/32',
    measurementSource: 'lib/analytics/benchmark buildKpiBenchmarks (source_ctr) over live analytics_event',
  },
  {
    number: 8,
    key: 'correction_rate',
    name: 'Correction rate / trust',
    target: '<2 reports per 100 source clicks (post-tuning)',
    instrumentedBy: 'T-27/33',
    measurementSource: 'live analytics_event — correction_report_submitted vs outbound_source_click',
  },
  {
    number: 9,
    key: 'coverage_region_family',
    name: 'Coverage by region/family',
    target: 'Every launch region + P0 family: coverage or an explicit gap',
    instrumentedBy: 'T-33/39',
    measurementSource: 'lib/admin/dashboard getIngestionHealth (per-family series/occurrence coverage) + region breadth',
  },
  {
    number: 10,
    key: 'repeat_use_retention',
    name: 'Repeat use / retention',
    target: 'DAU/WAU/MAU, saved searches, returning signed-in, email opt-in tracked',
    instrumentedBy: 'T-31/32/41',
    measurementSource: 'lib/analytics/kpi.ts activeUsers + accountValue over live analytics_event',
  },
  {
    number: 11,
    key: 'data_health_board',
    name: 'Data-health board',
    target: 'Stale sources, failed checks, top failed queries, thin regions, queues surfaced',
    instrumentedBy: 'T-33',
    measurementSource: 'lib/admin/dashboard getAdminDashboardData / getHealthAlerts (the operating board exists and populates from live data)',
  },
  {
    number: 12,
    key: 'account_value',
    name: 'Account value',
    target: 'Signed-in save + faster repeat + saved-search reruns + weekly opt-in',
    instrumentedBy: 'T-32/41',
    measurementSource: 'lib/analytics/kpi.ts accountValue + benchmark signed-in share over live analytics_event',
  },
] as const;

/** One KPI's measured standing. */
export interface LaunchGateFinding {
  number: number;
  key: string;
  name: string;
  target: string;
  status: KpiStatus;
  /** Human-readable actual-vs-target line (e.g. "100% (5/5 benchmark journeys)"). */
  actual: string;
  /** Extra honest context — WHY it stands where it does today. */
  note: string;
}

/** The assembled launch-gate report for one data regime (fixture demo catalogue, or live DB). */
export interface LaunchGateReport {
  /** Which regime the actuals came from — 'fixture' (demo catalogue) or 'live-db'. */
  regime: string;
  findings: LaunchGateFinding[];
  counts: Record<KpiStatus, number>;
}

/** Look up a launch-gate KPI definition by its §12.5 number (throws if it is not #1–#12). */
export function kpiByNumber(n: number): LaunchGateKpi {
  const kpi = LAUNCH_GATE_KPIS.find((k) => k.number === n);
  if (!kpi) throw new Error(`No launch-gate KPI #${n} (valid range #1–#12; #13–#22 are operating KPIs)`);
  return kpi;
}

/**
 * Assemble a launch-gate report from per-KPI measured findings. Pure. Validates that the
 * findings cover EXACTLY launch-gate KPIs #1–#12 — no gap, no duplicate, and none of the
 * operating KPIs #13–#22 — so a silently-missing KPI can never look like a pass.
 */
export function assembleLaunchGateReport(regime: string, findings: LaunchGateFinding[]): LaunchGateReport {
  const numbers = findings.map((f) => f.number).sort((a, b) => a - b);
  const expected = LAUNCH_GATE_KPIS.map((k) => k.number);
  const same = numbers.length === expected.length && numbers.every((n, i) => n === expected[i]);
  if (!same) {
    throw new Error(`Launch-gate report must cover exactly KPIs #1–#12; got [${numbers.join(', ')}]`);
  }
  const counts: Record<KpiStatus, number> = { met: 0, below: 0, 'no-data': 0, manual: 0 };
  for (const f of findings) counts[f.status] += 1;
  return { regime, findings: findings.slice().sort((a, b) => a.number - b.number), counts };
}

/** A one-line-per-KPI text rendering of a report (for the findings doc / CI log). */
export function renderLaunchGateReport(report: LaunchGateReport): string {
  const head =
    `Launch-gate KPI validation (TSD §12.5 #1–#12) — regime=${report.regime} | ` +
    `met=${report.counts.met} below=${report.counts.below} no-data=${report.counts['no-data']} manual=${report.counts.manual}`;
  const rows = report.findings.map(
    (f) => `  #${String(f.number).padStart(2)} ${f.name.padEnd(34)} [${f.status.toUpperCase().padEnd(7)}] ${f.actual} — ${f.note}`
  );
  return [head, ...rows].join('\n');
}
