// app/api/admin/snapshot/refresh/run/route.ts — POST /api/admin/snapshot/refresh/run
//
// The scheduled entrypoint that precomputes the /admin/* dashboard payloads into
// admin_dashboard_snapshot, so the pages stop re-deriving 2.9M analytics_event rows on every
// load. Same auth shape as app/api/analytics/retention/run and app/api/email/weekly/run: a
// shared secret presented by whatever external scheduler calls it. No new cron infra here.
//
// ═══ HOW TO WIRE THIS, AND THE ONE WAY NOT TO ═══
// Call it with a plain HTTP POST from an EXTERNAL scheduler — a system crontab, a systemd
// timer, a GitHub Actions schedule, any curl on a timer.
//
// ⚠ Do NOT wire it as a CRHQ `schedule`-skill job, even though the sibling routes above are
// driven that way and copying them is the obvious move. CRHQ only offers session-based job
// types (`new_session` / `message_session`), so every single run would boot an LLM agent
// session. This endpoint exists to serve Jon's 2026-09-14 instruction — "fix means make it
// less expensive / FEWER TOKENS TO USE / schedule run it less often" — and paying agent
// tokens on a fixed cadence to save database seconds would defeat the half of that goal the
// caching does not already address. As a bare HTTP POST this job's token cost is exactly zero.
//
// ⚠ It must be a POST-ISSUING scheduler, not a GET-based one. Vercel Cron in particular
// issues GET, and this route deliberately exports POST only (a three-minute write job has no
// business behind a GET), so a Vercel-Cron wiring gets 405 and silently never refreshes —
// the pages would just keep showing an ageing snapshot with an honest but stale "as of" line.
// If a GET-only scheduler is the only option available, put a POST-issuing shim in front of
// it rather than adding a GET handler here; tests/admin/snapshot-refresh-route.test.ts pins
// the absence of that handler on purpose.
//
// If the platform's function ceiling is shorter than the whole job (~222s measured on prod
// 2026-09-18), POST the `keys` array to split it across several shorter calls.
//
// AUTH: bearer / `x-cron-secret` shared secret (ADMIN_SNAPSHOT_CRON_SECRET), compared in
// constant time. Unconfigured → 503 (fail closed, never open). This endpoint is cheap to call
// and expensive to serve — up to ~3 minutes of database work — so an open one would be a
// free denial-of-service lever against the product's own database.
//
// WRITES: only admin_dashboard_snapshot, and only derived data. There is no destructive path
// here at all, which is why this route has no dry-run switch (unlike the retention jobs): the
// worst a bad run can do is replace a cached number with a freshly computed one.
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { adminSnapshotCronSecret } from '@/lib/admin/snapshot-config';
import { refreshAllSnapshots } from '@/lib/admin/snapshot-refresh';
import { ALL_ADMIN_SNAPSHOT_KEYS, type AdminSnapshotKey } from '@/lib/admin/snapshot';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // pg pool needs the Node runtime, not edge.
// The whole job is measured at ~100s and budgeted to 180s per key (see
// ADMIN_SNAPSHOT_REFRESH_TIMEOUT_MS). The platform default function ceiling is well below
// that, so it is raised explicitly here rather than discovered as a truncated run.
export const maxDuration = 800;

function presentedSecret(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return request.headers.get('x-cron-secret');
}

function secretOk(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // Length is compared first because timingSafeEqual THROWS on a length mismatch rather than
  // returning false. The leak is the length of the configured secret, not the secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Narrow a caller-supplied key list to the ones that actually exist.
 *
 * Returns `null` for "the caller asked for something unknown", which the handler turns into a
 * 400. Silently dropping an unrecognised key would let a scheduler typo look like a successful
 * refresh of a dashboard that in fact never got rebuilt.
 */
function parseKeys(raw: unknown): readonly AdminSnapshotKey[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const known = new Set<string>(ALL_ADMIN_SNAPSHOT_KEYS);
  if (!raw.every((k) => typeof k === 'string' && known.has(k))) return null;
  return raw as readonly AdminSnapshotKey[];
}

export async function POST(request: Request): Promise<NextResponse> {
  const expected = adminSnapshotCronSecret();
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: 'admin snapshot refresh not configured' },
      { status: 503 }
    );
  }
  if (!secretOk(presentedSecret(request), expected)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let body: { keys?: unknown } = {};
  try {
    const raw = await request.text();
    body = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  const keys = parseKeys(body.keys);
  if (keys === null) {
    return NextResponse.json(
      { ok: false, error: 'keys must be a non-empty array of known snapshot keys' },
      { status: 400 }
    );
  }

  const result = await refreshAllSnapshots(keys ?? ALL_ADMIN_SNAPSHOT_KEYS);

  // ═══ A PARTIAL REFRESH IS REPORTED AS A FAILURE, NOT AS SUCCESS-WITH-DETAIL ═══
  // refreshAllSnapshots never throws — it isolates each key so one bad payload cannot cost the
  // other three their refresh. That means the STATUS CODE is the only thing a scheduler looks
  // at, and returning 200 for "built 1 of 4" would make a broken dashboard invisible to it.
  const status = result.failed > 0 ? 503 : 200;
  return NextResponse.json({ ok: result.failed === 0, ...result }, { status });
}
