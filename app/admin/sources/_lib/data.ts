// app/admin/sources/_lib/data.ts — G-T34-3 no-code source registry: the DB read +
// write model. SERVER-ONLY (imports the pg service pool) — never import this from a
// client component; the client form imports pure values from ./vocab instead.
//
// Every write goes through withAdminTransaction + writeAdminAudit so the source row
// change and its admin_audit_log entry commit atomically (no un-audited admin change).
// Server-only by construction (imports the pg service pool) — only imported by the
// page server component + the 'use server' actions, never by a client component.
import { query } from '@/lib/db/client';
import { writeAdminAudit, withAdminTransaction, ADMIN_AUDIT_ACTIONS } from '@/lib/admin/audit';
import { cadenceFromSeconds, type SourceInput } from './vocab';

/** A source row as shown in the console list + used as the audit before/after snapshot. */
export interface SourceRow {
  id: string;
  family: string;
  name: string;
  authorityTier: string;
  termsStatus: string;
  robotsStatus: string;
  platform: string | null;
  ingestionMethod: string;
  seasonState: string;
  healthState: string;
  /** Tier label (e.g. '1 day') if the stored interval matches a known tier, else the raw text. */
  baselineCadence: string;
  nearDateCadence: string | null;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Raised when a create/edit would violate the (family, name) uniqueness constraint. */
export class SourceConflictError extends Error {
  constructor(public readonly family: string, public readonly name: string) {
    super(`a source with family "${family}" and name "${name}" already exists`);
    this.name = 'SourceConflictError';
  }
}

interface SourceDbRow {
  id: string;
  family: string;
  name: string;
  authority_tier: string;
  terms_status: string;
  robots_status: string;
  platform: string | null;
  ingestion_method: string;
  season_state: string;
  health_state: string;
  baseline_cadence_text: string;
  baseline_cadence_secs: string | null;
  near_date_cadence_text: string | null;
  near_date_cadence_secs: string | null;
  last_check_at: Date | string | null;
  next_check_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

// The column projection, reused verbatim by SELECT list and INSERT/UPDATE RETURNING so
// every read of a source row (list, edit-load, post-write snapshot) has identical shape.
const RETURNING_COLS = `
    id, family, name, authority_tier, terms_status, robots_status, platform,
    ingestion_method::text AS ingestion_method, season_state::text AS season_state, health_state,
    baseline_cadence::text AS baseline_cadence_text,
    EXTRACT(EPOCH FROM baseline_cadence)::bigint AS baseline_cadence_secs,
    near_date_cadence::text AS near_date_cadence_text,
    EXTRACT(EPOCH FROM near_date_cadence)::bigint AS near_date_cadence_secs,
    last_check_at, next_check_at, created_at, updated_at`;
const SELECT_COLS = `${RETURNING_COLS}
  FROM source`;

function iso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Present a stored interval as a tier label when it matches one, else the raw ::text form. */
function cadenceLabel(text: string | null, secs: string | null): string | null {
  if (text == null) return null;
  const asTier = cadenceFromSeconds(secs == null ? null : Number(secs));
  return asTier ?? text;
}

function toRow(r: SourceDbRow): SourceRow {
  return {
    id: r.id,
    family: r.family,
    name: r.name,
    authorityTier: r.authority_tier,
    termsStatus: r.terms_status,
    robotsStatus: r.robots_status,
    platform: r.platform,
    ingestionMethod: r.ingestion_method,
    seasonState: r.season_state,
    healthState: r.health_state,
    baselineCadence: cadenceLabel(r.baseline_cadence_text, r.baseline_cadence_secs) ?? r.baseline_cadence_text,
    nearDateCadence: cadenceLabel(r.near_date_cadence_text, r.near_date_cadence_secs),
    lastCheckAt: iso(r.last_check_at),
    nextCheckAt: iso(r.next_check_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

/** All sources, newest activity first — the console list. */
export async function listSources(): Promise<SourceRow[]> {
  const rows = await query<SourceDbRow>(
    `SELECT ${SELECT_COLS} ORDER BY family ASC, name ASC`
  );
  return rows.map(toRow);
}

/** One source by id (for the edit form + audit before-snapshot), or null. */
export async function getSourceById(id: string): Promise<SourceRow | null> {
  const rows = await query<SourceDbRow>(`SELECT ${SELECT_COLS} WHERE id = $1`, [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Create a source row (no code) and write its audit entry, atomically.
 * @returns the created SourceRow. @throws SourceConflictError on a (family, name) clash.
 */
export async function createSource(input: SourceInput, adminUserId: string): Promise<SourceRow> {
  try {
    return await withAdminTransaction(async (client) => {
      const res = await client.query<SourceDbRow>(
        `INSERT INTO source
           (family, name, authority_tier, terms_status, robots_status, platform,
            baseline_cadence, near_date_cadence, ingestion_method, season_state, health_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7::interval,$8::interval,$9::ingestion_method,$10::season_state,$11)
         RETURNING ${RETURNING_COLS}`,
        [
          input.family,
          input.name,
          input.authorityTier,
          input.termsStatus,
          input.robotsStatus,
          input.platform,
          input.baselineCadence,
          input.nearDateCadence,
          input.ingestionMethod,
          input.seasonState,
          input.healthState,
        ]
      );
      const created = toRow(res.rows[0]);
      await writeAdminAudit(
        {
          adminUserId,
          action: ADMIN_AUDIT_ACTIONS.SOURCE_CREATE,
          targetTable: 'source',
          targetId: created.id,
          before: null,
          after: created,
        },
        client
      );
      return created;
    });
  } catch (err) {
    throw normalizeConflict(err, input);
  }
}

/**
 * Update a source row (no code) and write its audit entry (before/after), atomically.
 * @returns the updated SourceRow. @throws SourceConflictError on a (family, name) clash;
 *          Error('source not found') if the id no longer exists.
 */
export async function updateSource(
  id: string,
  input: SourceInput,
  adminUserId: string,
  before: SourceRow
): Promise<SourceRow> {
  try {
    return await withAdminTransaction(async (client) => {
      const res = await client.query<SourceDbRow>(
        `UPDATE source SET
           family = $2, name = $3, authority_tier = $4, terms_status = $5, robots_status = $6,
           platform = $7, baseline_cadence = $8::interval, near_date_cadence = $9::interval,
           ingestion_method = $10::ingestion_method, season_state = $11::season_state, health_state = $12
         WHERE id = $1
         RETURNING ${RETURNING_COLS}`,
        [
          id,
          input.family,
          input.name,
          input.authorityTier,
          input.termsStatus,
          input.robotsStatus,
          input.platform,
          input.baselineCadence,
          input.nearDateCadence,
          input.ingestionMethod,
          input.seasonState,
          input.healthState,
        ]
      );
      if (!res.rows[0]) throw new Error('source not found');
      const updated = toRow(res.rows[0]);
      await writeAdminAudit(
        {
          adminUserId,
          action: ADMIN_AUDIT_ACTIONS.SOURCE_UPDATE,
          targetTable: 'source',
          targetId: id,
          before,
          after: updated,
        },
        client
      );
      return updated;
    });
  } catch (err) {
    throw normalizeConflict(err, input);
  }
}

function normalizeConflict(err: unknown, input: SourceInput): unknown {
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
    return new SourceConflictError(input.family, input.name);
  }
  return err;
}
