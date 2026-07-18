// lib/email/weekly.ts — orchestrate the weekly digest: single-user (the core,
// testable unit) and a bulk driver that simply loops it.
//
// I/O boundary for the feature. Reuses the live search stack exactly as
// /api/search does (loadPostgresListings + PostgresAliasResolver +
// PostgresRegionHierarchy + fsaGeocoder over the SearchEngine), reads user data via
// the service pool (a cross-user SYSTEM job — never user-facing CRUD — with explicit
// user_id filters throughout), resolves the recipient email via the service-role
// admin API, builds+renders the digest, and sends via Resend.
//
// SAFETY: sending is DRY-RUN unless WEEKLY_EMAIL_ENABLED === 'true'. `dryRun`
// defaults to !sendingEnabled(), so an accidental invocation in an unconfigured
// environment builds the payload but dispatches nothing. Real sends are recorded
// (watermark + CASL audit); dry runs are not (the watermark never moves on a test).
import { getPool, query } from '@/lib/db/client';
import { SearchEngine } from '@/lib/search/engine';
import { InMemoryListingRepository } from '@/lib/search/repository';
import { loadPostgresListings } from '@/lib/search/postgres-repository';
import { getPostgresAliasResolver } from '@/lib/search/postgres-alias-resolver';
import { getPostgresRegionHierarchy } from '@/lib/search/postgres-region-hierarchy';
import { fsaGeocoder } from '@/lib/geo/postal-fsa';
import { buildWeeklyDigest, type DigestSavedSearch, type WeeklyDigest } from './digest';
import { renderWeeklyDigest } from './render';
import { sendEmail, type ResendPayload } from './resend';
import { resolveRecipientEmail } from './recipients';
import { getLastSentAt, recordWeeklySend } from './send-log';
import { unsubscribeUrl } from './unsubscribe';
import { sendingEnabled } from './config';

export type UserSendStatus =
  | 'sent'
  | 'dry_run'
  | 'skipped_no_profile'
  | 'skipped_not_opted_in'
  | 'skipped_no_saved_searches'
  | 'skipped_no_email'
  | 'skipped_nothing_new'
  | 'error';

export interface UserSendResult {
  userId: string;
  status: UserSendStatus;
  activityCount: number;
  resendId?: string;
  error?: string;
  /** In dry-run, the exact Resend payload for verification (contains no secret). */
  payload?: ResendPayload;
}

/** Pre-loaded, shareable search state so a bulk run loads the read model once. */
export interface WeeklyDeps {
  engine: SearchEngine;
  /** occurrence id → created_at epoch ms, for the "new since watermark" filter. */
  createdAtMs: Map<string, number>;
}

interface ProfileRow {
  id: string;
  home_postal: string | null;
  email_opt_in: boolean;
  created_at: Date | string;
}

interface SavedRow {
  id: string;
  query_json: unknown;
}

/** Load the live search read model + occurrence timestamps once (reused across users). */
export async function loadWeeklyDeps(): Promise<WeeklyDeps> {
  const pool = getPool();
  const [listings, aliasResolver, regionHierarchy, createdRows] = await Promise.all([
    loadPostgresListings(pool),
    getPostgresAliasResolver(pool),
    getPostgresRegionHierarchy(pool),
    query<{ id: string; created_at: Date | string }>(
      `SELECT id, created_at FROM activity_occurrence WHERE archived_at IS NULL`
    ),
  ]);

  const engine = new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver,
    regionHierarchy,
    geocoder: fsaGeocoder,
    fixtureBacked: false,
  });

  const createdAtMs = new Map<string, number>();
  for (const r of createdRows) createdAtMs.set(r.id, new Date(r.created_at).getTime());

  return { engine, createdAtMs };
}

function newIdsSince(createdAtMs: Map<string, number>, since: Date): Set<string> {
  const t = since.getTime();
  const out = new Set<string>();
  for (const [id, ms] of createdAtMs) if (ms > t) out.add(id);
  return out;
}

/** Unwrap a saved_search.query_json envelope { name, params } defensively. */
function mapSaved(row: SavedRow): DigestSavedSearch {
  const env =
    row.query_json && typeof row.query_json === 'object' && !Array.isArray(row.query_json)
      ? (row.query_json as Record<string, unknown>)
      : {};
  const name = typeof env.name === 'string' ? env.name : null;
  const params =
    env.params && typeof env.params === 'object' && !Array.isArray(env.params)
      ? (env.params as Record<string, unknown>)
      : {};
  return { id: row.id, name, params };
}

/** RFC 8058 one-click list-unsubscribe headers (mailbox-provider "Unsubscribe" button). */
function listUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export interface SendUserOptions {
  now?: Date;
  /** Defaults to !sendingEnabled() — a real send requires opting in explicitly. */
  dryRun?: boolean;
  deps?: WeeklyDeps;
  perSearchLimit?: number;
}

/**
 * Build and (unless dry-run) send this user's weekly digest. The single testable
 * unit — bulk simply loops it. Never throws: every failure path returns a
 * structured UserSendResult.
 */
export async function sendWeeklyDigestForUser(
  userId: string,
  options: SendUserOptions = {}
): Promise<UserSendResult> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? !sendingEnabled();

  try {
    // 1. Profile (service pool; explicit user_id filter). Need opt-in, home postal, signup date.
    const profRows = await query<ProfileRow>(
      `SELECT id, home_postal, email_opt_in, created_at FROM user_profile WHERE id = $1`,
      [userId]
    );
    const profile = profRows[0];
    if (!profile) return { userId, status: 'skipped_no_profile', activityCount: 0 };

    // 2. CASL / opt-in: only opted-in users are ever emailed. This is the opt-out gate.
    if (!profile.email_opt_in) return { userId, status: 'skipped_not_opted_in', activityCount: 0 };

    // 3. Only users with at least one saved search get a digest.
    const savedRows = await query<SavedRow>(
      `SELECT id, query_json FROM saved_search WHERE user_id = $1 ORDER BY created_at`,
      [userId]
    );
    if (savedRows.length === 0) return { userId, status: 'skipped_no_saved_searches', activityCount: 0 };

    // 4. Recipient email (service-role admin; auth.users). Null → cannot send.
    const recipient = await resolveRecipientEmail(userId);
    if (!recipient.email) {
      return { userId, status: 'skipped_no_email', activityCount: 0, error: recipient.reason };
    }

    // 5. Watermark: last real send, else signup ("since signup if first email").
    const deps = options.deps ?? (await loadWeeklyDeps());
    const since = (await getLastSentAt(userId)) ?? new Date(profile.created_at);
    const newOccurrenceIds = newIdsSince(deps.createdAtMs, since);

    // 6. Build the digest (pure). Nothing new → skip, and DO NOT advance the watermark.
    const digest = buildWeeklyDigest({
      userId,
      engine: deps.engine,
      savedSearches: savedRows.map(mapSaved),
      homePostal: profile.home_postal,
      now,
      newOccurrenceIds,
      perSearchLimit: options.perSearchLimit,
    });
    if (!digest.shouldSend) return { userId, status: 'skipped_nothing_new', activityCount: 0 };

    // 7. Render + send.
    const unsub = unsubscribeUrl(userId);
    const rendered = renderWeeklyDigest(digest, { unsubscribeUrl: unsub });
    const result = await sendEmail({
      to: recipient.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers: listUnsubscribeHeaders(unsub),
      dryRun,
    });

    if (result.status === 'sent') {
      await recordWeeklySend({
        userId,
        activityCount: digest.totalActivities,
        resendId: result.id,
        dryRun: false,
      });
      return { userId, status: 'sent', activityCount: digest.totalActivities, resendId: result.id };
    }
    if (result.status === 'dry_run') {
      return { userId, status: 'dry_run', activityCount: digest.totalActivities, payload: result.payload };
    }
    // skipped_no_key | error — surface as an error, don't record a send.
    const message =
      result.status === 'skipped_no_key' ? 'RESEND_API_KEY not configured' : result.error;
    return { userId, status: 'error', activityCount: digest.totalActivities, error: message, payload: result.payload };
  } catch (err) {
    return { userId, status: 'error', activityCount: 0, error: (err as Error)?.message ?? 'unknown error' };
  }
}

export interface PreviewOptions {
  now?: Date;
  deps?: WeeklyDeps;
  perSearchLimit?: number;
}

/**
 * Build (never send) the digest a user would receive RIGHT NOW, using their real
 * watermark. Opt-in is intentionally NOT checked — opt-in gates SENDING, not a
 * user previewing their own digest. Returns null when there is nothing to preview
 * (no profile or no saved searches). `shouldSend:false` means "nothing new this
 * week" — a valid, honest preview state.
 */
export async function previewWeeklyDigestForUser(
  userId: string,
  options: PreviewOptions = {}
): Promise<WeeklyDigest | null> {
  const now = options.now ?? new Date();

  const profRows = await query<ProfileRow>(
    `SELECT id, home_postal, email_opt_in, created_at FROM user_profile WHERE id = $1`,
    [userId]
  );
  const profile = profRows[0];
  if (!profile) return null;

  const savedRows = await query<SavedRow>(
    `SELECT id, query_json FROM saved_search WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  );
  if (savedRows.length === 0) return null;

  const deps = options.deps ?? (await loadWeeklyDeps());
  const since = (await getLastSentAt(userId)) ?? new Date(profile.created_at);
  const newOccurrenceIds = newIdsSince(deps.createdAtMs, since);

  return buildWeeklyDigest({
    userId,
    engine: deps.engine,
    savedSearches: savedRows.map(mapSaved),
    homePostal: profile.home_postal,
    now,
    newOccurrenceIds,
    perSearchLimit: options.perSearchLimit,
  });
}

export interface BulkOptions {
  now?: Date;
  dryRun?: boolean;
  /** Cap the number of candidate users (safety for a first live run). */
  limit?: number;
  perSearchLimit?: number;
}

export interface BulkSummary {
  dryRun: boolean;
  candidates: number;
  counts: Record<UserSendStatus, number>;
  results: UserSendResult[];
}

function emptyCounts(): Record<UserSendStatus, number> {
  return {
    sent: 0,
    dry_run: 0,
    skipped_no_profile: 0,
    skipped_not_opted_in: 0,
    skipped_no_saved_searches: 0,
    skipped_no_email: 0,
    skipped_nothing_new: 0,
    error: 0,
  };
}

/**
 * Send the digest to every opted-in user who has at least one saved search. Loads
 * the search read model once and reuses it. Serial (weekly cadence, gentle on the
 * DB and the mail API). Dry-run unless explicitly enabled — see sendWeeklyDigestForUser.
 */
export async function sendWeeklyDigestBulk(options: BulkOptions = {}): Promise<BulkSummary> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? !sendingEnabled();
  const deps = await loadWeeklyDeps();

  const lim = options.limit && options.limit > 0 ? Math.min(Math.trunc(options.limit), 10000) : null;
  const rows = await query<{ id: string }>(
    `SELECT DISTINCT up.id
       FROM user_profile up
       JOIN saved_search ss ON ss.user_id = up.id
      WHERE up.email_opt_in = true
      ORDER BY up.id
      ${lim != null ? `LIMIT ${lim}` : ''}`
  );

  const counts = emptyCounts();
  const results: UserSendResult[] = [];
  for (const r of rows) {
    const res = await sendWeeklyDigestForUser(r.id, {
      now,
      dryRun,
      deps,
      perSearchLimit: options.perSearchLimit,
    });
    counts[res.status] += 1;
    results.push(res);
  }

  return { dryRun, candidates: rows.length, counts, results };
}
