import http from 'node:http';
import type { Pool } from 'pg';
import { healthz, type HealthState } from './healthz';
import { chromiumSmoke } from './chromium-smoke';
import { createPool } from './db';
import { startScheduler, type SchedulerHandle } from './scheduler';
import { runShutdown, SHUTDOWN_BUDGET_MS } from './shutdown';
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
let schedulerHandle: SchedulerHandle | null = null;

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
    schedulerHandle = startScheduler(pool, { signal: abort.signal });
    state.scheduler = schedulerHandle.metrics;
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

/**
 * Last-resort exit if runShutdown() itself wedges.
 *
 * Sized to fire INSIDE the runtime's stop grace window, which the previous 8000 did not:
 * neither worker/fly.toml nor worker/fly.production.toml sets `kill_timeout`, and Fly's
 * documented default is 5 seconds before SIGKILL. An 8s net on a 5s leash never nets
 * anything — the machine was already gone. This is a NARROWING, not a widening: the real
 * fix is that the sequence below is budgeted (SHUTDOWN_BUDGET_MS) rather than open-ended.
 */
const HARD_EXIT_MS = SHUTDOWN_BUDGET_MS + 1_000;

let shuttingDown = false;
const shutdown = (signalName: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[worker] ${signalName} received — graceful shutdown starting`);

  const hardExit = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.warn('[worker] shutdown exceeded its budget — exiting now');
    process.exit(0);
  }, HARD_EXIT_MS);
  hardExit.unref();

  void runShutdown({
    pool,
    abort: () => abort.abort(),
    // closeAllConnections() is load-bearing: server.close() alone only calls back once
    // every keep-alive connection has gone away, and the runtime's own /healthz probe
    // holds one. That is exactly why the old ordering could stall — and, worse, why what
    // it stalled on had nothing to do with the work that actually needed protecting.
    closeServer: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    closeSentry: () => closeWorkerSentry(),
    inFlightJobs: () => schedulerHandle?.inFlightJobs() ?? [],
    quiesce: (ms) => schedulerHandle?.quiesce(ms) ?? Promise.resolve(true),
  })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[worker] shutdown failed:', err instanceof Error ? err.message : String(err));
    })
    .finally(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[worker] unhandled rejection:', reason);
  // Fatal, same as uncaughtException: by the time this fires, some code path
  // assumed a promise would resolve/reject and didn't, so process state is no
  // longer trustworthy (e.g. a DB transaction left open, a queue job never
  // marked done). Crash and let Fly's supervisor restart clean rather than
  // keep the scheduler/poll loop running on top of unknown state.
  captureWorkerException(reason, {
    tags: { component: 'worker', operation: 'unhandled_rejection' },
  }).finally(() => process.exit(1));
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[worker] uncaught exception:', err);
  captureWorkerException(err, {
    tags: { component: 'worker', operation: 'uncaught_exception' },
  }).finally(() => process.exit(1));
});
