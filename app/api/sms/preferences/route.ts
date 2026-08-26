// app/api/sms/preferences/route.ts — mutations from the preferences page (PRD §2.4).
//
// DRAFT (SMS pivot). POST only, one endpoint, three actions: save / unsubscribe / delete.
//
// ── WHY THE MUTATIONS ARE A ROUTE AND NOT PART OF THE PAGE ──────────────────────────────
// The page at /u/[preferencesToken] is a GET, and its URL is the kind of thing a messaging client
// PREFETCHES to render a link preview — the same behaviour round 6 flagged as a CTR risk. If any
// state change hung off that GET, a preview fetch would silently unsubscribe people. Keeping every
// mutation behind POST makes that structurally impossible rather than unlikely.
//
// ── CSRF, HONESTLY ──────────────────────────────────────────────────────────────────────
// Classic CSRF does not apply: there is no cookie or session for a hostile page to ride. The
// credential is the token, and an attacker who has the token already has everything this endpoint
// could give them. So the threat here is not forgery — it is TOKEN LEAKAGE, which is fought on the
// page (no-referrer, no-store, noindex) and by never putting the token anywhere it need not be.
//
// The token travels in the BODY rather than the URL for that reason: a POST path lands in access
// logs and proxy logs the same way a GET path does, and this is the one request that does not have
// to put it there.
import { NextResponse } from 'next/server';
import {
  performPreferencesAction,
  type PreferencesAction,
  type PreferencesOutcome,
} from '@/lib/sms/preferences';
import { withObservedRoute } from '@/lib/observability/route-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Same ceiling as the signup route — a preferences patch is smaller than a signup. */
export const MAX_PREFERENCES_PAYLOAD_BYTES = 4 * 1024;

const ACTIONS: readonly PreferencesAction[] = ['save', 'unsubscribe', 'delete'];

/**
 * HTTP status per outcome.
 *
 * `not_found` and `not_permitted` BOTH return 404, deliberately. `not_permitted` means the row
 * exists but is stopped — and telling an unrecognised caller "that token is real, it just belongs
 * to someone who unsubscribed" is a fact about another person. One status, one message.
 */
function statusFor(outcome: PreferencesOutcome): number {
  switch (outcome) {
    case 'applied':
    case 'already_in_state':
      return 200;
    case 'invalid':
      return 400;
    case 'not_found':
    case 'not_permitted':
      return 404;
    default:
      return 503;
  }
}

export const POST = withObservedRoute(preferencesPost, { tags: { route: 'api/sms/preferences' } });

async function preferencesPost(request: Request): Promise<NextResponse> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_PREFERENCES_PAYLOAD_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  }

  const rawText = await request.text();
  if (Buffer.byteLength(rawText, 'utf8') > MAX_PREFERENCES_PAYLOAD_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  }

  let json: unknown;
  try {
    json = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return NextResponse.json({ ok: false, error: 'body must be a JSON object' }, { status: 400 });
  }
  const body = json as Record<string, unknown>;

  const action = body.action;
  if (typeof action !== 'string' || !ACTIONS.includes(action as PreferencesAction)) {
    return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token : null;

  const result = await performPreferencesAction({
    token,
    action: action as PreferencesAction,
    body,
    now: new Date(),
  });

  // THE RESPONSE NAMES NOTHING. No subscriber id, no token echo, no postal code, no ages — and
  // not the resolved `change` either, which carries all of them. The client already knows what it
  // submitted; the only new information it needs is whether it worked.
  const payload: Record<string, unknown> = {
    ok: result.outcome === 'applied' || result.outcome === 'already_in_state',
    outcome: result.outcome,
  };
  if (result.error) payload.error = result.error;
  if (result.field) payload.field = result.field;

  return NextResponse.json(payload, { status: statusFor(result.outcome) });
}
