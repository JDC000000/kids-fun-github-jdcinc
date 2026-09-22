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
import { isLocalDatabaseHost, resolveConnectionHost } from '../../lib/db/connection-host';

export const CA_ENV = 'KF_DB_CA_CERT';

export interface SslDecision {
  /** Pass straight to `new Pool({ ssl })`. `undefined` means "no TLS options" (local). */
  ssl: undefined | { ca: string; rejectUnauthorized: true };
  reason: string;
}

export function resolveSslFor(connectionString: string): SslDecision {
  const host = resolveConnectionHost(connectionString);
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
        `    curl -fsSL -o /tmp/supabase-prod-ca.crt \\\n` +
        `      https://supabase.com/downloads/prod-ca-2021.crt\n` +
        `    export ${CA_ENV}=/tmp/supabase-prod-ca.crt\n\n` +
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
