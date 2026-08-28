// lib/sms/redact.ts — the one shape in which a phone number may appear in an operational message.
//
// DRAFT (SMS pivot). Extracted in round 17: this function was byte-for-byte duplicated in
// lib/sms/weekly-send-io.ts and app/api/sms/inbound/route.ts, and the inbound route's copy carried
// a comment claiming the redaction "lives here rather than at each call site" — which was
// precisely, and only, untrue of that copy.
//
// A REDACTION RULE IS EXACTLY THE KIND OF THING THAT MUST HAVE ONE HOME. Two copies is two places
// to relax "last four digits" independently, and the failure mode of relaxing one is a phone
// number in a log line that somebody believed was redacted.

/**
 * Last four digits only — `****0123`.
 *
 * FOR OPERATIONAL MESSAGES, NOT FOR STORAGE OR MATCHING. The durable identity of a subscriber in
 * the audit trail is `sms_send_log.phone_hash` (a salted one-way digest, migration 0035); this is
 * for the moment a human needs to correlate a log line with a support conversation.
 *
 * FOUR CHARACTERS OR FEWER REDACT ENTIRELY rather than exposing a short string in full. No E.164
 * number is that short, so this is unreachable in practice — it is here so that a malformed or
 * truncated value cannot fall through into the log verbatim.
 */
export function redactPhone(phone: string): string {
  return phone.length <= 4 ? '****' : `****${phone.slice(-4)}`;
}
