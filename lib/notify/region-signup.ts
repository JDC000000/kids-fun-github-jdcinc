// lib/notify/region-signup.ts — the "email me when this area is live" waiting list.
//
// One typed contract + one pure validator + one server write helper, for the capture form the
// sparse-coverage notice renders on /search (app/search/_components/RegionNotifyForm.tsx →
// POST /api/notify/region → `region_notify_signup`, migration 0032).
//
// Validation is by hand, mirroring lib/corrections/validate.ts and lib/analytics/validate.ts —
// zod is not a dependency in this repo. The parser is pure and side-effect-free so the whole
// accept/reject surface is unit-testable without a request or a database.
//
// The REGION ALLOWLIST IS AN ARGUMENT, NOT AN IMPORT. This module is server-side data access;
// the set of areas a parent can wait on is the /search rail's chip vocabulary
// (app/search/_lib/params.ts REGION_CHIPS), and the route passes it in. That keeps one
// vocabulary (the route already does exactly this for the typed `age`/`when`/`time` params —
// see app/api/search/route.ts) instead of a second copy here that could drift into accepting
// an area the UI cannot offer.

import { query } from '@/lib/db/client';

/** Whole-request payload cap — a sanity ceiling against abuse (matches the corrections route). */
export const MAX_NOTIFY_PAYLOAD_BYTES = 4 * 1024; // 4 KB

/**
 * RFC 5321's maximum forward-path length. A cap rather than a guess at what an address may
 * contain: the local part of a real address may hold almost anything, so length is one of the
 * few things that can be rejected with certainty.
 */
export const MAX_EMAIL_LENGTH = 254;

/**
 * Deliberately permissive: one @, something before it, and a dot-bearing domain after it with
 * no whitespace anywhere.
 *
 * A stricter pattern is a liability here, not an asset. The only thing that can actually prove
 * an address is delivery, this form is the entire relationship, and every over-strict client
 * validator in history has rejected somebody's real mailbox. So this catches the typo class a
 * parent can see and fix ("jane@", "jane at gmail") and admits everything else — a bad address
 * costs one undeliverable email later; a rejected good one costs the signup now.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A validated signup ready to persist. */
export interface RegionNotifySignup {
  /** An area-chip slug from the caller-supplied allowlist ('wvan', 'bby', …). */
  regionChipId: string;
  /** Trimmed, length-capped, shape-checked. Stored verbatim; matched case-insensitively. */
  email: string;
}

export type RegionNotifyParseResult =
  | { ok: true; value: RegionNotifySignup }
  | { ok: false; error: string };

/**
 * Parse + validate an untrusted request body against the allowed area vocabulary. Never throws.
 *
 * Error strings are about the SHAPE of the request and are safe to return to the caller — none
 * of them echoes the submitted address back, which is what keeps an error response from turning
 * this endpoint into a reflector for arbitrary text.
 */
export function parseRegionNotifyBody(raw: unknown, allowedRegionChipIds: readonly string[]): RegionNotifyParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const body = raw as Record<string, unknown>;

  const regionChipId = firstString(body.region, body.regionChipId, body.region_chip_id);
  if (regionChipId == null || !allowedRegionChipIds.includes(regionChipId)) {
    return { ok: false, error: 'unknown region' };
  }

  const rawEmail = firstString(body.email);
  if (rawEmail == null) return { ok: false, error: 'email is required' };
  const email = rawEmail.trim();
  if (email.length > MAX_EMAIL_LENGTH) {
    return { ok: false, error: `email exceeds ${MAX_EMAIL_LENGTH} characters` };
  }
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'that does not look like an email address' };

  return { ok: true, value: { regionChipId, email } };
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

export interface RegionNotifyWriteResult {
  ok: boolean;
}

/**
 * Record one waiting-list signup. Never throws — a DB failure resolves to { ok:false }.
 *
 * THE CALLER MUST NOT SWALLOW A FALSE, and that is the one place this differs from
 * lib/corrections/report.ts, which writes best-effort behind an optimistic "thanks". A
 * correction is a gift: if it is lost, the parent has lost nothing they were promised. This
 * form makes a PROMISE — "we will email you" — and a promise made against a row that was never
 * written is exactly the kind of quiet substitution this product's whole empty-state posture
 * exists to prevent. The route returns a real error and the form says so.
 *
 * ON CONFLICT DO NOTHING against the (region, lower(email)) unique index: a second submission
 * of the same address for the same area is a parent tapping twice, so it is a success, not a
 * duplicate row and not an error. `ok` therefore means "this address is on the list", which is
 * the only thing the form actually claims — never "a row was inserted just now".
 */
export async function writeRegionNotifySignup(signup: RegionNotifySignup): Promise<RegionNotifyWriteResult> {
  try {
    await query(
      `INSERT INTO region_notify_signup (region_chip_id, email)
       VALUES ($1, $2)
       ON CONFLICT (region_chip_id, lower(email)) DO NOTHING`,
      [signup.regionChipId, signup.email]
    );
    return { ok: true };
  } catch (err) {
    // Never log the address itself — the message is the diagnostic, the row is the data.
    console.warn('[notify] region signup write failed:', (err as Error)?.message ?? err);
    return { ok: false };
  }
}
