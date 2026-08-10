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
// the scheduler with no `immediate` argument (index.ts:43) and the default is TRUE
// (scheduler.ts:215), so booting it would run an ENQUEUE tick against the shared test
// database with no way for a test to say otherwise. The wiring it skips is one line
// (index.ts: `state.scheduler = schedulerHandle.metrics`) and is reproduced verbatim below.
// `immediate` is instead a PARAMETER of this fixture (FIXTURE_IMMEDIATE), so a test can pick
// the boot path AND arrange the database to make that tick harmless first.
//
// ── WHY BOTH VALUES, AND WHY THE OLD "immediate:false IS THE SHARPER TEST" CLAIM WAS WRONG ─
// The durable health read is not gated on `immediate` — but the two settings reach it down
// TWO DIFFERENT CODE PATHS, and only one of them is production's:
//
//   immediate:FALSE — tickLoop calls refreshGlobalScheduleHealth() DIRECTLY
//                     (worker/src/scheduler.ts, the `else` arm of the boot branch).
//   immediate:TRUE  — tickLoop calls tickOnce(), and health arrives only from the TRAILING
//                     refresh at the END of tickOnce. This is what worker/src/index.ts
//                     boots, i.e. the path every production worker actually takes.
//
// A previous version of this comment claimed immediate:false was "also the sharper test".
// It is not, and the counter-example is mechanical: DELETE the trailing refresh at the end
// of tickOnce and an immediate:false fixture still reports health down the direct arm, so
// this file — the flagship restart proof — stays GREEN while the production path reports
// NOTHING. That is the defect it exists to catch, so pinning one value was the hole.
//
// Protocol: prints `LISTENING <port>` on stdout once ready; exits on SIGTERM.
// Parameters (env): DATABASE_URL, and FIXTURE_IMMEDIATE=true|false (default false).
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

// Explicit rather than defaulted: the caller decides which of the two boot paths above this
// process exercises, and an unset variable must mean the quiet one (no boot tick, no writes).
const immediate = process.env.FIXTURE_IMMEDIATE === 'true';

const handle = startScheduler(pool, {
  signal: abort.signal,
  environment: 'staging',
  immediate,
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
