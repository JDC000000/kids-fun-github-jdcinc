// lib/sms/keywords.ts — what a parent actually typed back at us.
//
// DRAFT (SMS pivot). Pure string logic, no I/O, so every tolerance decision below is directly
// unit-testable and none of them is buried in a route handler.
//
// TWO KINDS OF KEYWORD, AND ONLY ONE OF THEM IS OURS.
//
//   STOP / START / HELP (and their carrier aliases) are handled by Twilio's Advanced Opt-Out
//   BEFORE our webhook ever runs. Twilio suppresses or un-suppresses the number at its end and
//   sends the standard reply itself. We still classify them here for one reason: our database
//   must not drift from Twilio's suppression list. If Twilio has stopped a number and
//   sms_consent still says 'active', the Friday job will keep selecting that subscriber, keep
//   building a message, and keep getting it rejected — and our own CASL audit trail will say we
//   tried to text someone who had opted out. So the webhook MIRRORS the transition into our
//   status column. It is a mirror, not a decision: Twilio is the source of truth for
//   suppression, we are the source of truth for what we intended to send.
//
//   JOIN is ours alone. It is the CASL express-consent confirmation — the reply that moves a
//   subscription from 'pending' to 'active' and stamps confirmed_timestamp. Twilio does nothing
//   with it.
//
// HOW TOLERANT THE MATCH IS, AND WHERE THAT STOPS.
//
//   Tolerated, because they are all the same person typing the same word: case ("join"),
//   surrounding whitespace (" Join "), trailing punctuation ("join!"), an autocorrect-inserted
//   period, and the smart quotes and unicode punctuation phone keyboards insert unasked.
//
//   NOT tolerated, deliberately:
//     * A keyword embedded in a sentence. "I don't want to join" contains JOIN and means the
//       exact opposite of JOIN. Substring matching a consent confirmation is how you record
//       express consent that was never given, so the normalised body must be the keyword and
//       NOTHING else.
//     * Typos. There is a trigram matcher in this repo (lib/search/text/trigram.ts) and it
//       would happily rate "JOIM" a near-match for "JOIN". Fuzzy matching is right for search,
//       where a wrong guess costs a bad result, and wrong here, where a wrong guess costs a
//       consent record that a regulator would read as fabricated. An unrecognised reply gets a
//       human-readable nudge instead; that is the correct failure mode.
//     * An accent quietly deleted on the way in. See normalizeInboundBody below — this one was
//       an actual bug in the first draft of this file, not a hypothetical.

/** What an inbound message resolves to. 'unknown' is a normal, expected outcome. */
export type InboundKeyword = 'join' | 'stop' | 'start' | 'help' | 'unknown';

/**
 * Carrier/Twilio opt-out vocabulary. These arrive already actioned by Twilio's Advanced
 * Opt-Out; we classify them only so the webhook can mirror the resulting state into our DB.
 * Kept as the full documented alias lists rather than a shortened set, because a subscriber
 * who texted CANCEL is just as opted out as one who texted STOP, and a DB that only mirrors
 * STOP would drift on every alias.
 */
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_WORDS = new Set(['START', 'YES', 'UNSTOP']);
const HELP_WORDS = new Set(['HELP', 'INFO']);

/** Our own express-consent confirmation. Single word, no aliases — see the header. */
const JOIN_WORDS = new Set(['JOIN']);

/**
 * Reduce an inbound body to a comparable form: Unicode-compose it, remove punctuation and
 * symbols (which covers '!', '.', smart quotes and emoji alike), collapse runs of whitespace,
 * trim, uppercase.
 *
 * ═══ THE TWO LINES HERE THAT ARE NOT COSMETIC ═══
 *
 * `.normalize('NFC')` FIRST. Phone keyboards — iOS in particular — routinely emit DECOMPOSED
 * text, where "í" is the plain letter "i" followed by a separate combining acute accent
 * (U+0301). A combining accent is a Unicode MARK, not a letter, not a digit and not
 * whitespace. This was written first as "delete everything that is not \p{L}, \p{N} or
 * whitespace", which looked conservative and was the opposite: it deleted the accent and
 * turned a decomposed "Joín" into a clean "JOIN" — a reply that does not say JOIN, silently
 * promoted into a CASL express-consent confirmation. (Found by tests/sms/keywords.test.ts, not
 * by reading the code.) Composing first turns the pair back into a single precomposed letter
 * that survives.
 *
 * REMOVE \p{P}/\p{S}, do not KEEP \p{L}/\p{N}. Same bug, generalised: an allowlist of
 * "letters and digits" deletes every category nobody thought about — marks, and also the
 * invisible formatting characters — and every one of those deletions makes the body strictly
 * MORE likely to collide with a keyword. A denylist of exactly the two things we mean to
 * forgive (punctuation and symbols) can only ever leave the body longer and less
 * keyword-shaped, so its failure direction is 'unknown', which is the safe answer.
 */
export function normalizeInboundBody(body: string | null | undefined): string {
  if (!body) return '';
  return body
    .normalize('NFC')
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Classify an inbound message body. Matches only when the ENTIRE normalised body is the
 * keyword — see the header for why a substring match is not acceptable for a consent
 * confirmation.
 */
export function classifyInboundKeyword(body: string | null | undefined): InboundKeyword {
  const normalized = normalizeInboundBody(body);
  if (normalized === '') return 'unknown';
  if (JOIN_WORDS.has(normalized)) return 'join';
  if (STOP_WORDS.has(normalized)) return 'stop';
  if (START_WORDS.has(normalized)) return 'start';
  if (HELP_WORDS.has(normalized)) return 'help';
  return 'unknown';
}

/** Convenience predicate for the one keyword this product owns end to end. */
export function isJoinKeyword(body: string | null | undefined): boolean {
  return classifyInboundKeyword(body) === 'join';
}
