// lib/snapshot/safe-error.ts — never let a failure print a credential.
//
// The snapshot tools are the one place in this repo an operator holds a PRODUCTION connection
// string in their shell. node-postgres errors quote what they were given ("password
// authentication failed", "getaddrinfo ENOTFOUND", and — when a URL is malformed — sometimes
// the URL itself), and the fastest way to leak a secret is to paste a stack trace into a
// ticket. So no snapshot tool prints a raw error: everything goes through here first.
//
// This project has a live incident history of environment values being spliced into status
// reports, which is why this is a module with a test and not an inline `.replace()`.

import { redactContact } from './scrub';

/** Anything that looks like a postgres connection URL, with or without credentials. */
const CONNECTION_URL = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|https?):\/\/\S+/gi;

/**
 * A printable one-line description of an unknown error with connection strings and inline
 * credentials removed. Stack traces are dropped entirely — they add nothing an operator can
 * act on here and are the usual vehicle for an accidental paste.
 */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';
  const noUrls = raw.replace(CONNECTION_URL, '[connection-string-redacted]');
  return redactContact(noUrls).value.split('\n')[0].slice(0, 500);
}
