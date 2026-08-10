// tests/scheduler/__fixtures__/restarted-worker.cjs — A REAL, SEPARATE OS PROCESS.
//
// WHY A CHILD PROCESS AND NOT ANOTHER startScheduler() CALL IN THE TEST RUNNER.
// The defect this proves fixed is that /healthz reported a clean bill of health after a
// RESTART: the tripped-breaker list lived in the scheduler closure and was populated only
// by the statement that tripped the breaker, so a process that booted afterwards started
// empty and stayed empty. Any proof that reuses the test runner's process is arguing from
// the same address space the bug lives in. This forks a genuinely new node process, which
// loads a fresh module graph, builds a fresh metrics object and has no memory whatsoever of
// anything that happened before it started. Nothing about the tripped state reaches it
// except through the database.
//
// It boots the COMPILED worker modules (worker/dist/**, built by the test's beforeAll from
// worker/tsconfig.json — the same build worker/Dockerfile runs) and serves the REAL
// healthz() payload over a REAL socket, so the assertion is made against the JSON an
// operator would actually curl.
//
// It deliberately does NOT run worker/src/index.js itself, for one reason: index.js starts
// the scheduler with `immediate: true`, which runs an ENQUEUE tick against the shared test
// database. This process must not write to a database other suites are using. The wiring it
// skips is one line (index.ts: `state.scheduler = schedulerHandle.metrics`) and it is
// reproduced verbatim below.
//
// `immediate: false` is also the sharper test: the durable health read is deliberately NOT
// gated on `immediate` (see worker/src/scheduler.ts tickLoop), because `immediate` decides
// whether this process WRITES on boot, while reporting what the database already says is a
// pure SELECT an operator needs before the first tick interval elapses. If that gating ever
// comes back, this process reports nothing and the test fails.
//
// Protocol: prints `LISTENING <port>` on stdout once ready; exits on SIGTERM.
'use strict';

const http = require('node:http');
const path = require('node:path');

const DIST = path.join(__dirname, '..', '..', '..', 'worker', 'dist', 'worker', 'src');

// Resolve `pg` the way the compiled worker does (worker/node_modules first, repo root as
// the fallback), so the pool handed to startScheduler is from the same copy of the driver
// the scheduler itself loaded.
const { Pool } = require(require.resolve('pg', { paths: [DIST] }));
const { startScheduler } = require(path.join(DIST, 'scheduler.js'));
const { healthz } = require(path.join(DIST, 'healthz.js'));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const abort = new AbortController();

const state = { chromiumReady: false, bootedAt: new Date().toISOString(), scheduler: null };

const handle = startScheduler(pool, {
  signal: abort.signal,
  environment: 'staging',
  immediate: false,
  schedulerTickMs: 600_000,
  pollIntervalMs: 600_000,
});
state.scheduler = handle.metrics; // worker/src/index.ts:44, verbatim.

const server = http.createServer((req, res) => {
  if ((req.url || '') === '/healthz') {
    healthz(req, res, state);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not_found"}');
});

// Port 0 = let the OS pick, so a busy port on the runner cannot make this flaky.
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});

process.on('SIGTERM', () => {
  abort.abort();
  server.close();
  pool.end().finally(() => process.exit(0));
});
