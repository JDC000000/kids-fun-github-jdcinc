// lib/snapshot/scrub.ts — the anonymisation pass. Pure string functions, no I/O, no DB.
//
// Kept pure and separate from the export so it is unit-testable in the fast lane
// (tests/snapshot/scrub.test.ts) rather than only observable by running an export against a
// database. The export applies these IN THE STREAM, row by row, before anything is written:
// the raw value exists only in the exporting process's memory and never reaches disk.
//
// Every replacement is a CONSTANT. Nothing here is reversible and nothing is keyed — there
// is no salt to leak and no mapping to invert. Two different phone numbers of the same shape
// become the same placeholder, on purpose: distinctness of a redacted phone drives no code
// path, and a distinct-but-derived value is a re-identification surface.

export const REDACTION = {
  email: '[email-redacted]',
  phone: '[phone-redacted]',
  postal: '[postal-redacted]',
  credentials: '[credentials-redacted]',
  person: '[name-redacted]',
  token: '[redacted]',
} as const;

/** Rule ids, so the export can report a tally of WHAT it removed without echoing any content. */
export type ScrubRule = 'email' | 'phone' | 'phone_bare' | 'postal' | 'credentials' | 'person';

export interface ScrubResult {
  value: string;
  /** Rule → number of substitutions. Counts only; never the removed text. */
  hits: Partial<Record<ScrubRule, number>>;
}

// ── Detectors ────────────────────────────────────────────────────────────────────────
// Deliberately built as factories: a /g regex carries mutable lastIndex, and sharing one
// instance between a replace() and a test() is a classic source of intermittently-wrong
// results. Each call gets a fresh one.

export const detectors = {
  /** RFC-ish email. Intentionally broad on the local part. */
  email: (): RegExp => /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi,

  /** `scheme://user:pass@host` — credentials smuggled inside a scraped URL. */
  credentials: (): RegExp => /([a-z][a-z0-9+.\-]*:\/\/)[^/@\s:]+(?::[^/@\s]*)?@/gi,

  /**
   * A punctuated North-American phone number, optionally with an extension. Requires at least
   * one separator before the final four digits, which is what keeps it off bare numeric ids.
   */
  // Separator class spelled with explicit escapes (ASCII hyphen, dot, whitespace, and the
  // U+2010–U+2013 dash family scrapers love) rather than a literal dash range, which is easy
  // to misread as a typo and easy to break.
  //
  // The `(?<![\w-])` / `(?![\w-])` guards make a phone a STANDALONE TOKEN. Without them the
  // pattern happily matched the interior of a UUID (`…78-9012…`) and of ids like
  // `synthprod-bulk-1234567890`, which made the verifier scream about `provenance.id`. A real
  // scraped phone is always delimited by space or punctuation; a digit run welded to a hyphen
  // and more word characters is an identifier.
  phone: (): RegExp =>
    /(?<![\w-])(?:\+?1[\s.‐‑‒–-]?)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.‐‑‒–-]?\d{3}[\s.‐‑‒–-]\d{4}(?:\s*(?:ext|ext\.|x|extension)\s*\.?\s*\d{1,6})?(?![\w-])/gi,

  /**
   * Ten consecutive digits — an UNPUNCTUATED phone number. Only ever applied to prose and to
   * already-scrubbed values, never as an acceptance test on a `preserve` column: a bare
   * ten-digit run is also a perfectly ordinary upstream record id, and failing an export
   * because `source_record_id` happens to be ten digits would be a false alarm.
   */
  phoneBare: (): RegExp => /(?<![\w-])\d{10}(?![\w-])/g,

  /** Canadian postal code, with or without the middle space. */
  postal: (): RegExp => /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/gi,

  /** See personDetector() — the person heuristic is keyword-set dependent, not one fixed regex. */
  person: (): RegExp => personDetector(PERSON_KEYWORDS_BROAD),
} as const;

/**
 * ── THE PERSON HEURISTIC, AND WHY IT COMES IN TWO STRENGTHS ─────────────────────────
 * "Contact Jane Doe", "Instructor: Sam", "ask for Mrs Chen". There is no reliable way to
 * find a personal name in scraped text, so this looks for the CONTEXT a name appears in.
 * It is knowingly over-eager: the broad set also eats "Contact Us" and "Host Vancouver
 * Public Library".
 *
 * That trade is right for a description body (we lose two words of prose nothing asserts on,
 * and a real instructor's name stays out of a file that leaves the building) and WRONG for a
 * program title, where "Coach", "Host" and "Leader" are ordinary title words carrying FTS
 * weight-A search meaning. Redacting them would break the very relevance behaviour the
 * snapshot exists to test.
 *
 * So titles get the NARROW set — only keywords that are unambiguously introducing a person
 * to contact ("register with", "ask for", "attn") and never a bare role noun. "Parent & Tot
 * Swim (register with Coach Mira Halvorsen)" is still caught; "Coach Approach Basketball"
 * survives intact.
 */
export const PERSON_KEYWORDS_BROAD = [
  'contact person',
  'please contact',
  'contacts',
  'contact',
  'attn',
  'attention',
  'instructors',
  'instructor',
  'coaches',
  'coach',
  'teachers',
  'teacher',
  'leaders',
  'leader',
  'facilitators',
  'facilitator',
  'organisers',
  'organiser',
  'organizers',
  'organizer',
  'registrars',
  'registrar',
  'hosted by',
  'host',
  'led by',
  'run by',
  'taught by',
  'register with',
  'ask for',
] as const;

export const PERSON_KEYWORDS_NARROW = [
  'contact person',
  'please contact',
  'contact',
  'attn',
  'attention',
  'register with',
  'registration with',
  'ask for',
  'instructor',
  'taught by',
] as const;

/**
 * Keyword match is case-INsensitive ("CONTACT", "Contact", "contact" all count); the NAME
 * match is case-SENSITIVE, because "Contact Amelia Novak" is a person and "contact us for
 * details" is not. JS regex has no per-group flags, so the whole pattern runs with /i and the
 * capitalisation of the captured name is checked in the replacement callback instead — see
 * looksLikeName().
 */
function personDetector(keywords: readonly string[]): RegExp {
  const alternation = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // Up to FIVE candidate words, not two or three: "Instructor Anke van der Berg" is a real
  // four-word name, and a capture that stops short leaks the surname it was supposed to remove.
  // Over-capturing costs nothing because nameWordCount() decides where the name actually ends —
  // "ask for Priya Raman at the desk" captures five words and redacts two.
  return new RegExp(
    `\\b(${alternation})\\b(\\s*(?:is|:|-|–)?\\s+)((?:[\\p{L}'’.-]+)(?:\\s+[\\p{L}'’.-]+){0,4})`,
    'giu'
  );
}

/** Lowercase words that legitimately sit INSIDE a name and must not end the run. */
const NAME_PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'del', 'di', 'da', 'la', 'le', 'bin', 'al', 'mac', 'mc']);

function isNameWord(word: string): boolean {
  const bare = word.replace(/[.,;:!?'’)\]]+$/u, '');
  if (bare === '') return false;
  return /^[A-ZÀ-ÖØ-Þ]/u.test(bare) || NAME_PARTICLES.has(bare.toLowerCase());
}

/**
 * How many of `candidate`'s leading words form a name.
 *
 * The regex captures up to three words after the keyword, because a name can be three words —
 * but so can "Priya Raman at". Demanding that ALL captured words look like a name (an earlier
 * revision did) silently matched nothing whenever a preposition followed the name, i.e. in the
 * common case. So the match is the LONGEST LEADING RUN of name-shaped words, and the rest of
 * the sentence is handed back untouched. A run that would end on a particle ("Contact Van der")
 * is trimmed back, since a trailing "de"/"van" is a preposition far more often than a surname.
 */
function nameWordCount(candidate: string): number {
  const words = candidate.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  // The FIRST word must be capitalised: "contact us for details" is not a person.
  if (!/^[A-ZÀ-ÖØ-Þ]/u.test(words[0])) return 0;
  let n = 1;
  while (n < words.length && isNameWord(words[n])) n += 1;
  while (n > 1 && NAME_PARTICLES.has(words[n - 1].replace(/[.,;:!?'’)\]]+$/u, '').toLowerCase())) n -= 1;
  return n;
}

/**
 * Redact "<keyword> <Name>" occurrences, keeping the keyword and replacing only the name.
 * A candidate that does not read as a name (all lowercase, "us", "the library") is left alone
 * and not counted as a hit.
 */
function redactPersons(value: string, keywords: readonly string[]): { value: string; hits: number } {
  let hits = 0;
  const out = value.replace(personDetector(keywords), (match, keyword: string, joiner: string, candidate: string) => {
    const words = candidate.split(/(\s+)/); // keep separators so the tail rebuilds verbatim
    const take = nameWordCount(candidate);
    if (take === 0) return match;
    hits += 1;
    // words[] alternates word, sep, word, sep… so `take` words end at index 2*take-1.
    const tail = words.slice(2 * take - 1).join('');
    return `${keyword}${joiner}${REDACTION.person}${tail}`;
  });
  return { value: out, hits };
}

function apply(
  value: string,
  hits: Partial<Record<ScrubRule, number>>,
  rule: ScrubRule,
  re: RegExp,
  replacement: string | ((...args: string[]) => string)
): string {
  let n = 0;
  const out = value.replace(re, ((...args: unknown[]) => {
    n += 1;
    return typeof replacement === 'function'
      ? (replacement as (...a: string[]) => string)(...(args as string[]))
      : replacement;
  }) as (substring: string, ...a: unknown[]) => string);
  if (n > 0) hits[rule] = (hits[rule] ?? 0) + n;
  return out;
}

/**
 * Conservative pass — emails, URL credentials, punctuated phone numbers. Used for short
 * labels, street addresses and URLs, where postal codes and proper nouns are legitimate
 * public catalogue content whose exact shape the tests depend on.
 */
export function redactContact(value: string): ScrubResult {
  const hits: Partial<Record<ScrubRule, number>> = {};
  let out = value;
  // Credentials first: `https://u:p@host` contains an `@` that the email rule would otherwise
  // claim, which would leave the scheme dangling and hide that a credential was ever there.
  out = apply(out, hits, 'credentials', detectors.credentials(), (_m, scheme) => `${scheme}${REDACTION.credentials}@`);
  out = apply(out, hits, 'email', detectors.email(), REDACTION.email);
  out = apply(out, hits, 'phone', detectors.phone(), REDACTION.phone);
  return { value: out, hits };
}

/**
 * Middle pass — redactContact plus the NARROW person heuristic. Used for titles and short
 * scraped labels, where an instructor's name does occasionally appear but role words like
 * "Coach" carry real search meaning and must survive. See PERSON_KEYWORDS_NARROW.
 */
export function redactTitle(value: string): ScrubResult {
  const base = redactContact(value);
  const p = redactPersons(base.value, PERSON_KEYWORDS_NARROW);
  if (p.hits > 0) base.hits.person = (base.hits.person ?? 0) + p.hits;
  return { value: p.value, hits: base.hits };
}

/**
 * Aggressive pass — everything redactContact does, plus bare ten-digit numbers, Canadian
 * postal codes and the BROAD person heuristic. Used only for scraped long-form prose.
 */
export function redactProse(value: string): ScrubResult {
  const base = redactContact(value);
  const hits = base.hits;
  let out = base.value;
  out = apply(out, hits, 'phone_bare', detectors.phoneBare(), REDACTION.phone);
  out = apply(out, hits, 'postal', detectors.postal(), REDACTION.postal);
  const p = redactPersons(out, PERSON_KEYWORDS_BROAD);
  if (p.hits > 0) hits.person = (hits.person ?? 0) + p.hits;
  return { value: p.value, hits };
}

/**
 * Digits from this fixed fictitious number fill the digit positions of a phone placeholder,
 * cycling if the original is longer. 555-01xx is the reserved never-assigned range.
 */
const PLACEHOLDER_DIGITS = '6045550100';

/**
 * Replace a phone number with a fictitious one of the SAME SHAPE: every non-digit character
 * (spaces, brackets, dashes, "ext") is kept exactly where it was, and every digit position is
 * filled from PLACEHOLDER_DIGITS. So `(604) 555-1234 ext 22` → `(604) 555-0100 ext 60`.
 *
 * Shape is the point. Null-vs-set and formatting variety both reach the rendered detail page,
 * so they must survive to be drift-tested; the number itself must not.
 */
export function placeholderPhone(value: string): string {
  let i = 0;
  return value.replace(/\d/g, () => PLACEHOLDER_DIGITS[i++ % PLACEHOLDER_DIGITS.length]);
}

/**
 * Exact inverse check for placeholderPhone: are this value's digits, in order, the
 * PLACEHOLDER_DIGITS cycle? Used by the verifier to prove no real number survived, rather
 * than merely that the value "looks fake".
 */
export function isPlaceholderPhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  for (let i = 0; i < digits.length; i += 1) {
    if (digits[i] !== PLACEHOLDER_DIGITS[i % PLACEHOLDER_DIGITS.length]) return false;
  }
  return true;
}

/** Non-null becomes a constant; null-handling is the caller's job. */
export function placeholderToken(): string {
  return REDACTION.token;
}

/** Remove every REDACTION marker, so the acceptance scan cannot flag its own output. */
export function stripRedactionMarkers(value: string): string {
  let out = value;
  for (const marker of Object.values(REDACTION)) out = out.split(marker).join('');
  return out;
}

/**
 * Acceptance scan. Given a value that has already been through the pass named by `action`,
 * report anything that should not have survived. Used by scripts/snapshot/verify.ts as an
 * INDEPENDENT second barrier — if the export's scrub has a hole, this is what catches it
 * before the file is copied anywhere.
 *
 * `preserve` columns are checked with the high-precision rules only (email, credentials,
 * punctuated phone). See detectors.phoneBare for why bare digit runs are not an error there.
 */
export function residualFindings(rawValue: string, action: string): ScrubRule[] {
  const found: ScrubRule[] = [];
  // Strip our own markers first. `https://[credentials-redacted]@host` still matches the
  // credentials detector — the placeholder occupies exactly the position the credentials did —
  // so scanning the un-stripped value reports every SUCCESSFUL redaction as a failure.
  const value = stripRedactionMarkers(rawValue);
  const check = (rule: ScrubRule, re: RegExp): void => {
    if (re.test(value)) found.push(rule);
  };

  check('email', detectors.email());
  check('credentials', detectors.credentials());
  check('phone', detectors.phone());

  if (action === 'redact_title' && redactPersons(value, PERSON_KEYWORDS_NARROW).hits > 0) found.push('person');

  if (action === 'redact_prose') {
    check('phone_bare', detectors.phoneBare());
    check('postal', detectors.postal());
    if (redactPersons(value, PERSON_KEYWORDS_BROAD).hits > 0) found.push('person');
  }
  return found;
}
