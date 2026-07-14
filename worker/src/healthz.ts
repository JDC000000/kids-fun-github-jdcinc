import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SchedulerMetrics } from './scheduler';

// Liveness/readiness payload for the ingestion worker (G-T1-2 verify: curl /healthz → 200).
// Always returns 200 so a missing/slow database never makes the machine un-healthy;
// the scheduler's real state is reported in the `scheduler` sub-object instead.
export interface HealthState {
  chromiumReady: boolean;
  bootedAt: string;
  scheduler?: SchedulerMetrics | null;
}

export function healthz(
  _req: IncomingMessage,
  res: ServerResponse,
  state: HealthState,
): void {
  const body = JSON.stringify({
    status: 'ok',
    service: 'kids-fun-worker',
    chromiumReady: state.chromiumReady,
    bootedAt: state.bootedAt,
    uptimeSeconds: Math.round(process.uptime()),
    scheduler: state.scheduler ?? { enabled: false },
  });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}
