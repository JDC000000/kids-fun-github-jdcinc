import http from 'node:http';
import { healthz, type HealthState } from './healthz';
import { chromiumSmoke } from './chromium-smoke';

// KIDS FUN ingestion-worker entrypoint (G-T1-2). Long-running Node process:
//  - exposes /healthz for the runtime health check,
//  - runs a Chromium smoke on boot to confirm headless-render capability,
//  - /smoke re-runs the render check on demand.
// The job-queue poll loop (G-T5-*) is layered on top of this runtime later.

const PORT = Number(process.env.WORKER_HEALTHZ_PORT ?? 8080);

const state: HealthState = {
  chromiumReady: false,
  bootedAt: new Date().toISOString(),
};

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    healthz(req, res, state);
    return;
  }
  if (req.url === '/smoke') {
    chromiumSmoke()
      .then((r) => {
        state.chromiumReady = r.ok;
        res.writeHead(r.ok ? 200 : 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r));
      })
      .catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[worker] healthz listening on :${PORT}`);
  // Warm the browser once at boot so /healthz reports readiness.
  chromiumSmoke()
    .then((r) => {
      state.chromiumReady = r.ok;
      // eslint-disable-next-line no-console
      console.log(`[worker] chromium smoke on boot: ${r.ok ? 'PASS' : 'FAIL'}`);
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[worker] chromium smoke on boot failed:', err);
    });
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
