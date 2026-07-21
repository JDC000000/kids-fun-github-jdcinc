import http from 'node:http';
import type { Pool } from 'pg';
import { healthz, type HealthState } from './healthz';
import { chromiumSmoke } from './chromium-smoke';
import { createPool } from './db';
import { startScheduler } from './scheduler';
import { captureWorkerException, closeWorkerSentry, initWorkerSentry } from './sentry';

// KIDS FUN ingestion-worker entrypoint (G-T1-2 + G-T5-3). Long-running Node process:
//  - exposes /healthz for the runtime health check (always 200 for liveness),
//  - runs a Chromium smoke on boot to confirm headless-render capability,
//  - /smoke re-runs the render check on demand,
//  - starts the cadence-driven scheduler (tiered enqueue tick + durable queue
//    poll loop) when DATABASE_URL is configured — this is the real continuous
//    ingestion runtime that replaces the one-shot `ingest:once` entrypoint.

const PORT = Number(process.env.WORKER_HEALTHZ_PORT ?? 8080);

initWorkerSentry();

const state: HealthState = {
  chromiumReady: false,
  bootedAt: new Date().toISOString(),
  scheduler: null,
};

const abort = new AbortController();
let pool: Pool | null = null;

// Start the cadence-driven scheduler if a database is configured. The health
// server always starts regardless, so a missing or unreachable DB never makes
// the machine un-healthy — the scheduler's status is surfaced via /healthz.
function startWorkloadIfConfigured(): void {
  if (!process.env.DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.warn('[worker] DATABASE_URL not set — scheduler disabled (health-only mode)');
    return;
  }
  try {
    pool = createPool();
    const handle = startScheduler(pool, { signal: abort.signal });
    state.scheduler = handle.metrics;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[worker] failed to start scheduler:', err instanceof Error ? err.message : String(err));
    void captureWorkerException(err, {
      tags: { component: 'worker', operation: 'start_scheduler' },
    });
  }
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  if (url === '/healthz') {
    healthz(req, res, state);
    return;
  }
  if (url === '/smoke') {
    chromiumSmoke()
      .then((r) => {
        state.chromiumReady = r.ok;
        res.writeHead(r.ok ? 200 : 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r));
      })
      .catch((err: unknown) => {
        void captureWorkerException(err, {
          tags: { component: 'worker', operation: 'smoke_endpoint' },
        });
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
      void captureWorkerException(err, {
        tags: { component: 'worker', operation: 'boot_chromium_smoke' },
      });
    });
  // Bring up the continuous ingestion scheduler.
  startWorkloadIfConfigured();
});

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  abort.abort();
  server.close(() => {
    Promise.resolve(pool ? pool.end() : undefined)
      .then(() => closeWorkerSentry())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
  // Hard safety net so the machine always exits within the runtime's grace window.
  setTimeout(() => process.exit(0), 8000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[worker] unhandled rejection:', reason);
  void captureWorkerException(reason, {
    tags: { component: 'worker', operation: 'unhandled_rejection' },
  });
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[worker] uncaught exception:', err);
  captureWorkerException(err, {
    tags: { component: 'worker', operation: 'uncaught_exception' },
  }).finally(() => process.exit(1));
});
