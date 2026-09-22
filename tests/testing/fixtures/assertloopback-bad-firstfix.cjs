// FIXTURE — the FIRST ATTEMPTED FIX, which was also bypassable. Kept for the same reason as its
// sibling: it is the more interesting of the two, because it looks right.
//
// The bug: searchParams.get('host') returns the FIRST occurrence of a repeated query parameter,
// while pg takes the LAST. So ?host=127.0.0.1&host=db.<ref>.supabase.co reads as loopback here and
// dials Supabase in reality. This is why the real implementation delegates to pg's own parser
// instead of re-deriving its precedence rules. DO NOT "fix" this file.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
module.exports.assertLoopback = function assertLoopback(cs) {
  if (!cs) throw new Error('unset');
  let u;
  try { u = new URL(cs); } catch { throw new Error('unparseable'); }
  const host = u.searchParams.get('host') || u.hostname;
  const n = String(host).trim().toLowerCase().replace(/\.+$/, '');
  if (!LOOPBACK.has(n) && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(n)) throw new Error('refuse ' + host);
};
