// lib/profile/child-profile.ts — the on-device child profile ("who are you looking for").
//
// The STORAGE HALF ONLY of the child-first-class-profile design
// (docs/child-first-class-profile-design.md, §4 — read §3 first). This module persists a
// parent's children's ages in `localStorage` and nothing else. There is deliberately no UI,
// no cookie mirror, no default-application logic and no server surface in this unit; those
// tiers depend on product questions (Q2 names, Q3 URL materialisation, Q7 where the prompt
// lives) that are not decided, and the design doc argues at length that guessing at them is
// the failure mode.
//
// ─── PRIVACY INVARIANT — READ BEFORE ADDING ANY FIELD ────────────────────────────────────
// NO NAMES. NO COORDINATES. NO POSTAL CODE. NO EMAIL. NO BIRTH DATE. EVER.
// Not in the envelope, not on an entry, not "temporarily", not behind a flag. This module
// stores a list of ages in months and nothing that identifies the child those ages belong to.
// `FORBIDDEN_KEY_RE` below enforces that mechanically on BOTH write and read, so neither a
// future edit here nor a hand-tampered blob in a browser can smuggle one of those values in.
//
// WHY THAT IS AN INVARIANT AND NOT A PREFERENCE. This product deliberately STOPPED collecting
// children's ages server-side (F-8 / PIPEDA Round 25 Task WW): `user_profile.saved_child_ages`
// is no longer writable (lib/db/user-profile.ts:80-85), the profile validator rejects the key
// (lib/user/profile-validate.ts:9-13), `child_ages`/`dob`/`birthdate` are in Sentry's
// `DENY_KEYS` (sentry.scrub.ts:133-144), `user_profile` is in the snapshot exporter's
// `EXCLUDED_TABLES` ("PII — CHILDREN … Never exported", lib/snapshot/policy.ts:323), and
// app/privacy/page.tsx:125-127 publishes, in plain English, that we do not collect children's
// ages or names. Jon approved (2026-08-19) the CLIENT-SIDE-ONLY posture this module implements
// — the data never reaches a server, never joins an identity, never appears in a request
// header or an access log, and a normal "clear site data" erases it — on the explicit basis
// that no server-side collection is reintroduced and that published sentence stays true.
// A field that travels is a different decision than the one that was approved.
//
// WHY THERE IS NO `name` FIELD, even as an unused optional. The design's §4d sketches
// `name?: string` so the shape need not change if Q2 is later answered "yes". It is left out,
// on purpose:
//   • A child's name would be the FIRST name-class PII in this product, and the existing
//     defence-in-depth does not cover it — sentry.scrub.ts's 34-key `DENY_KEYS` has no `name`,
//     `first_name` or `child_name` entry (design §7). Declaring the field here without closing
//     that gap builds the hole before the fence.
//   • Declared-but-never-populated is the worse of the two failure modes this codebase has
//     already been bitten by: params.ts's removed `includeUnknownCost` note (:202-218) is
//     nine lines about how keeping exactly one half of a concept alive is what produced a
//     silent, CI-green behaviour change. A type that says a name may be stored, next to code
//     that always drops it, is that shape in miniature — the next reader reasons from the type.
//   • Adding it later is cheap and SAFE BY CONSTRUCTION: bump `CHILD_PROFILE_VERSION`, and
//     every record written by this build is treated as absent rather than migrated (see
//     `parseProfile`). The versioned envelope exists precisely so the shape can change once.
// If Q2 is answered "names", the work is: add the field, add the length/unicode validation,
// close the `DENY_KEYS` gap, bump the version, and re-word the privacy policy. Not this unit.
//
// ─── CONVENTIONS ─────────────────────────────────────────────────────────────────────────
// Modelled closely on app/search/_lib/anon-memory.ts, which is the product's only other
// client-side store and has already solved every mechanical problem here: a versioned envelope
// with unknown versions treated as absent, hard byte caps, a forbidden-key guard applied on
// both write and read, an injectable `StorageLike` so the logic unit-tests without a DOM, and
// total defensiveness — every entry point is try-wrapped and NEVER THROWS, because a storage
// failure (private mode, quota, disabled) must degrade to "no profile", never break a render.
//
// PLACEMENT. anon-memory lives in the /search-scoped `app/search/_lib/` because it is only used
// there. A child profile is read by the home page, /search and /preview, so it lives in the
// shared `lib/` tree (design §10, S1). It has NO imports on purpose: the search vocabulary is
// a separate concern and lives in lib/profile/child-age-bands.ts, the one place the profile
// crosses into `AgeBandKey`.

/** localStorage key holding the on-device child profile. Namespaced to avoid collisions. */
export const CHILD_PROFILE_KEY = 'kf_child_profile';

/** Bump when the stored shape changes; other versions are ignored (treated as absent, never migrated). */
export const CHILD_PROFILE_VERSION = 1;

/**
 * Hard caps. This record is tiny by design, so anything abnormal is a tamper/bloat signal
 * rather than a real parent — refuse it instead of trusting it.
 *
 * `MAX_CHILDREN` and `MAX_AGE_MONTHS` are DISPLAY/COPY placeholders, not technical limits, and
 * both are flagged as revisitable in the design (§4d caps "needs Jon"; §9-Q8 asks how many
 * children the header copy can carry). 4 is the doc's own starting point. 216 months is the
 * 18th birthday — past it, "child profile" has stopped meaning anything, and the cap's real
 * job is to reject 9_999_999, not to adjudicate a 17-year-old.
 */
const MAX_CHILDREN = 4;
const MAX_AGE_MONTHS = 216;
const MAX_RAW_BYTES = 1024;
const MAX_ID_LEN = 24;

/** Local ids are bookkeeping, never data: a short, opaque, non-identifying token. */
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;

/**
 * Keys that must NEVER appear in the stored JSON, checked as JSON KEYS (`"name":`) so a value
 * can never trip the guard. This is the privacy invariant made mechanical, in the same spirit
 * as anon-memory's `FORBIDDEN_KEYS` coordinate strip — and it is deliberately WIDER than the
 * fields this module writes today, because its job is to catch the field that has not been
 * added yet.
 */
const FORBIDDEN_KEY_RE =
  /"(?:name|first_?name|last_?name|child_?name|nick_?name|lat|lng|latitude|longitude|postal(?:_?code)?|address|email|phone|dob|birth_?date|birth_?day|birth_?month|birth_?year)"\s*:/i;

/** One child. Ages in MONTHS — the canonical unit the rest of the product uses (`occurrence_age`). */
export interface ChildEntry {
  /** Stable local id, so a later edit/remove UI need not rely on an array index. Non-identifying. */
  id: string;
  /** Age in whole months, 0..MAX_AGE_MONTHS inclusive. */
  ageMonths: number;
}

/** What a caller may hand in: the id is optional and minted here when absent. */
export interface ChildInput {
  id?: string;
  ageMonths: number;
}

/** The persisted record. */
export interface ChildProfile {
  /** Schema version (=== CHILD_PROFILE_VERSION for any record this build will honour). */
  v: number;
  /** The children, capped at MAX_CHILDREN, each with a unique id. Never empty in a valid record. */
  children: ChildEntry[];
  /** Epoch ms of the last write (best-effort; 0 if unknown). Not shown as a precise time. */
  updatedAt: number;
}

/** A minimal Web Storage surface — injectable so the logic is unit-testable without a DOM. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** A real, storable age: a whole number of months inside the sanity bounds. */
function isValidAgeMonths(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_AGE_MONTHS;
}

/**
 * Normalise an arbitrary list into storable entries: keep only the two known fields (an
 * ALLOWLIST — anything else a caller or a tampered blob carries is dropped by construction,
 * which is the primary defence behind the privacy invariant), drop entries whose age is not a
 * real month count, replace an invalid or duplicated id with a fresh unique one, and cap the
 * count. Deterministic: no clock, no randomness. Never throws.
 *
 * An entry with a broken id keeps its age rather than being dropped — the age is the datum a
 * parent gave us, the id is our own bookkeeping, so losing a child over it would be the wrong
 * trade. An entry with a broken AGE is dropped, because there is nothing left of it.
 */
export function sanitizeChildren(input: unknown): ChildEntry[] {
  if (!Array.isArray(input)) return [];
  const out: ChildEntry[] = [];
  const usedIds = new Set<string>();
  for (const raw of input) {
    if (out.length >= MAX_CHILDREN) break;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (!isValidAgeMonths(entry.ageMonths)) continue;
    const supplied = typeof entry.id === 'string' ? entry.id.slice(0, MAX_ID_LEN) : '';
    const id = ID_RE.test(supplied) && !usedIds.has(supplied) ? supplied : nextId(usedIds);
    usedIds.add(id);
    out.push({ id, ageMonths: entry.ageMonths });
  }
  return out;
}

/** The lowest `cN` not already taken. Deterministic, so the same input always packs identically. */
function nextId(used: Set<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = `c${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Serialize a profile to its stored JSON string, or `null` when there is nothing worth storing
 * (no valid children) or the result is abnormally large or trips the forbidden-key guard.
 * Never throws.
 *
 * The guard REFUSES the write rather than stripping, which is the opposite of `parseProfile`'s
 * posture and deliberately so: a forbidden key on the way OUT can only have come from this
 * module's own code, i.e. it is a bug in a future edit, and failing to persist is a far better
 * outcome than silently writing a child's name to disk.
 */
export function packProfile(children: unknown, now: number): string | null {
  const safe = sanitizeChildren(children);
  if (safe.length === 0) return null;
  const rec: ChildProfile = {
    v: CHILD_PROFILE_VERSION,
    children: safe,
    updatedAt: Number.isFinite(now) ? now : 0,
  };
  const raw = JSON.stringify(rec);
  if (raw.length > MAX_RAW_BYTES) return null;
  if (FORBIDDEN_KEY_RE.test(raw)) return null; // privacy invariant — never persist an identifying field
  return raw;
}

/**
 * Parse + validate a stored string back into a usable profile, or `null` if unusable (absent,
 * malformed, oversized, wrong schema version, no valid children). Re-runs the full sanitize on
 * read, so a hand-edited blob is trusted no further than one this build wrote. Never throws.
 *
 * Validation on READ is not belt-and-braces here: `localStorage` is writable by anything
 * running on the origin and by the parent's own devtools, so "we wrote it, therefore it is
 * well-formed" is not an available assumption.
 */
export function parseProfile(raw: string | null | undefined): ChildProfile | null {
  if (!raw || raw.length > MAX_RAW_BYTES) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  // Unknown version → treated as ABSENT, never migrated. A record written by a build that knew
  // a different shape is not a record this build can reason about, and a half-understood
  // migration of a privacy-sensitive blob is worse than starting over.
  if (rec.v !== CHILD_PROFILE_VERSION) return null;
  const children = sanitizeChildren(rec.children);
  if (children.length === 0) return null;
  const updatedAt = typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0;
  return { v: CHILD_PROFILE_VERSION, children, updatedAt };
}

/** Resolve the browser's localStorage, or `null` if unavailable (SSR, private mode, disabled). */
function defaultStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null; // some browsers throw merely on access when storage is blocked
  }
}

/** Read the stored profile, or `null` if none/unusable/unavailable. Never throws. */
export function readProfile(storage: StorageLike | null = defaultStorage()): ChildProfile | null {
  if (!storage) return null;
  try {
    return parseProfile(storage.getItem(CHILD_PROFILE_KEY));
  } catch {
    return null;
  }
}

/**
 * Persist the profile. A no-op that LEAVES any existing profile intact when there is nothing
 * valid to store — `clearProfile` is the ONLY thing that ever erases, so "remove my last child"
 * has to be spelled as a clear, not as a write of an empty list. Returns whether a write
 * happened. Never throws (quota / disabled → false).
 *
 * One eraser, on purpose: it is the same rule anon-memory follows, and it means no accidental
 * empty-array call can silently wipe a parent's profile.
 */
export function writeProfile(
  children: ChildInput[],
  now: number,
  storage: StorageLike | null = defaultStorage()
): boolean {
  if (!storage) return false;
  const raw = packProfile(children, now);
  if (raw == null) return false; // nothing valid — do NOT clobber a prior good profile
  try {
    storage.setItem(CHILD_PROFILE_KEY, raw);
    return true;
  } catch {
    return false; // quota exceeded / storage disabled — silently give up, never break the render
  }
}

/** Forget the profile entirely (the parent's explicit "Forget my children"). Never throws. */
export function clearProfile(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(CHILD_PROFILE_KEY);
  } catch {
    /* no-op */
  }
}
