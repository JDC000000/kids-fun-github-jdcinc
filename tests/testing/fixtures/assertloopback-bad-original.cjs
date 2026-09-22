// FIXTURE — the ORIGINAL assertLoopback bug, kept deliberately so the differential test can prove
// it is still capable of failing. A corpus that no longer catches a known-bad implementation has
// stopped being a test and become a decoration, and nothing about a green run would say so.
//
// The bug: reads the host the string SPELLS (new URL().hostname) and ignores the ?host= override
// pg honours. A reviewer proved it live by catching real pg startup packets on a non-loopback
// listener. DO NOT "fix" this file.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
module.exports.assertLoopback = function assertLoopback(cs) {
  if (!cs) throw new Error('unset');
  let host;
  try { host = new URL(cs).hostname; } catch { throw new Error('unparseable'); }
  const n = String(host).trim().toLowerCase().replace(/\.+$/, '');
  if (!LOOPBACK.has(n) && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(n)) throw new Error('refuse ' + host);
};
