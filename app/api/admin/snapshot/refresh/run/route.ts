// app/api/admin/snapshot/refresh/run/route.ts — POST /api/admin/snapshot/refresh/run
//
// The scheduled entrypoint that precomputes the /admin/* dashboard payloads into
// admin_dashboard_snapshot, so the pages stop re-deriving 2.9M analytics_event rows on every
// load. Same shape as app/api/analytics/retention/run and app/api/email/weekly/run — a shared
// secret presented by the platform's scheduler (a CRHQ `schedule`-skill job); NO new cron
// infra is stood up here.
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
