// scripts/incident/negative/_local-only.cjs — refuse a non-loopback target.
//
// These helpers WRITE to whatever database `U` names (UPDATE activity_occurrence,
// INSERT INTO auth.users). Until now their only protection was the suite's convention of being
// pointed at a replica — a convention, not a control. Pointed at production by mistake, they would
// mutate it. That is precisely the shape of the incident this whole toolkit exists to clean up, so
// the test tooling should not be the one part exempt from it.
//
// ═══ THE CLAIM THAT USED TO BE HERE WAS EXACTLY INVERTED ═══
// This comment previously said the duplicated logic was "deliberately STRICTER and dumber" with
// "no ?host= handling", and concluded it "can only ever be more restrictive, never less."
//
// That reasoning was backwards, and a reviewer PROVED it by standing up a real network listener on
// a non-loopback address and catching actual inbound Postgres startup packets from these helpers.
// Omitting ?host= does not make the check stricter — it makes it BLIND. `new URL(cs).hostname`
// reports what the string SPELLS, while pg dials what `?host=` says, so
// `postgres://127.0.0.1/db?host=db.<ref>.supabase.co` read as loopback and was allowed straight
// through. That is the toolkit's own signature bypass, reproduced inside the only control
// protecting its three mutating helpers.
//
// The first repair attempt used `searchParams.get('host')`, and was ALSO bypassable: that returns
// the FIRST occurrence of a repeated parameter, while pg takes the LAST. So
// `?host=127.0.0.1&host=db.<ref>.supabase.co` still dialled Supabase while the check saw loopback.
//
// So this no longer hand-rolls pg's precedence rules at all. It asks pg's OWN parser, which is the
// same argument lib/db/connection-host.ts makes for the same decision: delegating host resolution
// to the parser pg itself uses is the only way to guarantee parity with what really connects.
// pg-connection-string is pg's own dependency, so there is no build step.
//
// BEHAVIOUR CHANGE, in the safe direction: `?host=/var/run/postgresql` is now REFUSED, because a
// socket path is not in the loopback allowlist. Correct for these helpers specifically — they only
// ever target a TCP loopback replica — but it is a real change, not an accident.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

module.exports.assertLoopback = function assertLoopback(connectionString, label = 'U') {
  if (!connectionString) {
    throw new Error(`${label} is not set — refusing to run a database-mutating test helper.`);
  }
  // new URL() stays as the garbage gate: pg-connection-string's parse() NEVER throws and invents a
  // placeholder host for arbitrary text, so without this an unparseable value would be "resolved".
  try {
    new URL(connectionString);
  } catch {
    throw new Error(`${label} is not a parseable URL — refusing (unverifiable target).`);
  }
  const host = require('pg-connection-string').parse(connectionString).host ?? '';
  const normalised = String(host).trim().toLowerCase().replace(/\.+$/, '');
  if (!LOOPBACK.has(normalised) && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalised)) {
    throw new Error(
      `refusing to run a database-mutating test helper against "${host}". These helpers UPDATE ` +
        `activity_occurrence and INSERT INTO auth.users; they are for a disposable local replica ` +
        `only. Loopback addresses only.`
    );
  }
};
