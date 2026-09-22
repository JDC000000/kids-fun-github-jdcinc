// scripts/incident/_ssl.ts — how the incident tools decide TLS. Shared by every script here so
// there is exactly one answer to "do we verify the server's certificate?".
//
// ═══ WHY THIS EXISTS ═══
// Supabase serves its own private chain — leaf → "Supabase Intermediate 2021 CA" → "Supabase Root
// 2021 CA", self-signed and NOT in the system trust store. So `rejectUnauthorized: true` fails
// outright with "self-signed certificate in certificate chain", and the whole repo's existing
// habit is `rejectUnauthorized: false`, which is the anti-pattern this incident's fixes exist to
// remove: it turns off authentication of the server on a PRODUCTION SUPERUSER connection.
//
// This slipped past every rehearsal because rehearsals run against 127.0.0.1, where the local
// branch sets no ssl options at all — the remote branch had never once been exercised. A reviewer
// found it by actually dialing out.
//
// ═══ THE RULE ═══
//   loopback/local  → no TLS options (as before; nothing to authenticate on a unix/loopback hop)
//   remote + CA set → verify properly against that CA
//   remote + no CA  → REFUSE, loudly, with instructions
//
// The last line is the point. The tempting third option — fall back to rejectUnauthorized:false so
// the tool "just works" — is how you end up with an unauthenticated connection to production and
// no one aware of it. A tool that stops and tells you what to fetch is better than one that
// quietly accepts any certificate. There is deliberately NO env var to skip verification.
import { readFileSync } from 'node:fs';
import { isLocalDatabaseHost, resolveEffectiveHost } from '../../lib/db/connection-host';

export const CA_ENV = 'KF_DB_CA_CERT';

/**
 * Connection-string parameters that decide TLS. Any of these in a REMOTE connection string is
 * refused outright.
 *
 * ═══ WHY REFUSE RATHER THAN IGNORE ═══
 * pg builds its config as `Object.assign({}, config, parse(connectionString))` — the PARSED STRING
 * WINS. So a single `?sslmode=…` silently discards the `ssl` object this module carefully builds,
 * and the whole "there is deliberately no way to skip verification" guarantee evaporates. Measured
 * against pg's own ConnectionParameters:
 *
 *     (no params)        -> ca=PRESENT rejectUnauthorized=true      <- what we intend
 *     ?sslmode=no-verify -> ca=ABSENT  rejectUnauthorized=false     <- the exact anti-pattern
 *     ?sslmode=require   -> ca=ABSENT  rejectUnauthorized=undefined
 *     ?sslmode=disable   -> ssl=false  (NO TLS AT ALL — a production superuser password in cleartext)
 *
 * And it arrives through KF_CLEANUP_TARGET_URL: the same environment channel as the boolean flag
 * that caused the original incident, which this toolkit refused to reintroduce as an escape hatch.
 * A guarantee that a URL parameter can switch off is not a guarantee.
 *
 * Stripping them silently was the alternative. Refusing is better: if an operator wrote sslmode
 * they had a reason, and quietly doing something else to their connection string is how people end
 * up mistrusting the tool. The message tells them exactly what to remove.
 */
const TLS_PARAMS = ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation', 'uselibpqcompat'];

/** TLS-deciding params present in a connection string, lowercased. */
export function tlsParamsIn(connectionString: string): string[] {
  let search: URLSearchParams;
  try {
    search = new URL(connectionString).searchParams;
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const [k] of search) {
    if (TLS_PARAMS.includes(k.toLowerCase())) found.push(k.toLowerCase());
  }
  return [...new Set(found)];
}

export interface SslDecision {
  /** Pass straight to `new Pool({ ssl })`. `undefined` means "no TLS options" (local). */
  ssl: undefined | { ca: string; rejectUnauthorized: true };
  reason: string;
}

export function resolveSslFor(connectionString: string): SslDecision {
  // ═══ REFUSED FOR *EVERY* TARGET, NOT JUST REMOTE ONES ═══
  // Refusing only on the remote branch left a LOCAL string carrying `?ssl=false` to reach pg, where
  // it does not mean "no TLS": pg-connection-string yields the STRING "false" (truthy), and pg then
  // dies on `'key' in ssl` with an unhandled TypeError. Refusing everywhere removes that crash and
  // costs nothing — the local branch sets no ssl options at all.
  const tlsParams = tlsParamsIn(connectionString);
  if (tlsParams.length > 0) {
    throw new Error(
      `refusing a connection string carrying TLS parameter(s) ` +
        `${tlsParams.map((x) => x).join(', ')}.\n\n` +
        `node-postgres merges the PARSED connection string OVER any ssl object supplied in code, so ` +
        `for a REMOTE target these silently discard the CA this tool enforces — measured: ` +
        `?sslmode=no-verify drops the CA and sets rejectUnauthorized=false; ?sslmode=disable turns ` +
        `TLS off entirely and sends the password in cleartext. For a LOCAL target they are ` +
        `redundant, and ?ssl=false crashes pg outright.\n\n` +
        `Remove the parameter(s). Verification is controlled solely by ${CA_ENV}, deliberately.`
    );
  }

  // Effective host: a hostless URL is dialed via PGHOST, so deciding TLS on the parsed host would
  // silently skip verification for a remote target that the URL never mentions.
  const { host, source } = resolveEffectiveHost(connectionString);

  // FAIL CLOSED on an unverifiable target. Discarding `source` here is precisely what let a
  // malformed connection string reach isLocalDatabaseHost(null) -> true -> "no TLS options".
  if (source === 'unparseable' || host === null) {
    throw new Error(
      `refusing to connect: the connection string could not be parsed, so the target cannot be ` +
        `verified. An unreadable URL is not a local one — it is an unknown one, and this tool will ` +
        `not decide TLS for a host it cannot name.`
    );
  }
  if (isLocalDatabaseHost(host)) {
    return { ssl: undefined, reason: `local host (${host || 'socket'}) — no TLS options` };
  }

  const caPath = process.env[CA_ENV];
  if (!caPath) {
    throw new Error(
      `refusing to connect to the remote host "${host}" without a CA certificate.\n\n` +
        `Supabase serves a PRIVATE chain (leaf -> "Supabase Intermediate 2021 CA" -> "Supabase Root\n` +
        `2021 CA"), which is self-signed and not in the system trust store, so certificate\n` +
        `verification cannot succeed against the default roots.\n\n` +
        `This tool will NOT fall back to disabling verification: that would leave a production\n` +
        `superuser connection unauthenticated, which is the class of problem this toolkit exists to\n` +
        `clean up. Supply the CA instead:\n\n` +
        `  1. Supabase dashboard -> Project -> Settings -> Database -> SSL Configuration ->\n` +
        `     "Download certificate". There is no stable public download URL for this; an\n` +
        `     earlier version of this message pointed at\n` +
        `     https://supabase.com/downloads/prod-ca-2021.crt, which returns 404.\n` +
        `  2. export ${CA_ENV}=/path/to/prod-ca.crt\n\n` +
        `Verify it before trusting it — the root's CN must read "Supabase Root 2021 CA":\n` +
        `    openssl x509 -in "$${CA_ENV}" -noout -subject -issuer -fingerprint -sha256`
    );
  }

  let ca: string;
  try {
    ca = readFileSync(caPath, 'utf8');
  } catch (err) {
    throw new Error(`${CA_ENV} is set to "${caPath}" but could not be read: ${(err as Error).message}`);
  }
  if (!ca.includes('BEGIN CERTIFICATE')) {
    throw new Error(`${CA_ENV} ("${caPath}") does not contain a PEM certificate.`);
  }
  return { ssl: { ca, rejectUnauthorized: true }, reason: `remote host (${host}) — verifying against ${caPath}` };
}
