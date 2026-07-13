import type { IncomingMessage, ServerResponse } from 'node:http';

// Liveness/readiness payload for the ingestion worker (G-T1-2 verify: curl /healthz → 200).
export interface HealthState {
  chromiumReady: boolean;
  bootedAt: string;
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
  });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}
