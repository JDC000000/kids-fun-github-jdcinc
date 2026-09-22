// scripts/incident/negative/_local-only.cjs — refuse a non-loopback target.
//
// These helpers WRITE to whatever database `U` names (UPDATE activity_occurrence,
// INSERT INTO auth.users). Until now their only protection was the suite's convention of being
// pointed at a replica — a convention, not a control. Pointed at production by mistake, they would
// mutate it. That is precisely the shape of the incident this whole toolkit exists to clean up, so
// the test tooling should not be the one part exempt from it.
//
// ═══ WHY THE LOGIC IS DUPLICATED RATHER THAN IMPORTED ═══
// The real classifier lives in lib/db/connection-host.ts. These are plain .cjs run by `node`
// directly, with no TypeScript pipeline, so importing it would mean a build step for three
// eight-line helpers. Duplication normally earns a complaint from me — two places to fix is how a
// guard drifts — so this copy is deliberately STRICTER and dumber than the original: an explicit
// loopback allowlist, no ?host= handling, no override, no env fallback. It can only ever be more
// restrictive than lib/db/connection-host.ts, never less, so drift cannot open a hole here.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

module.exports.assertLoopback = function assertLoopback(connectionString, label = 'U') {
  if (!connectionString) {
    throw new Error(`${label} is not set — refusing to run a database-mutating test helper.`);
  }
  let host;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    throw new Error(`${label} is not a parseable URL — refusing (unverifiable target).`);
  }
  const normalised = String(host).trim().toLowerCase().replace(/\.+$/, '');
  if (!LOOPBACK.has(normalised) && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalised)) {
    throw new Error(
      `refusing to run a database-mutating test helper against "${host}". These helpers UPDATE ` +
        `activity_occurrence and INSERT INTO auth.users; they are for a disposable local replica ` +
        `only. Loopback addresses only.`
    );
  }
};
