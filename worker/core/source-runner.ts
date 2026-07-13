// worker/core/source-runner.ts — terms-gated one-source ingest runner.
// Selects a DB source, applies the terms gate, resolves its adapter, then runs
// the fixture-safe ingest pipeline. This is the safe bridge between the durable
// job queue/source registry and the runtime entrypoints; live network fetching
// remains blocked in adapters until each source clears D-6/live-wiring tasks.
import type { Pool } from 'pg';
import { evaluateTermsGate, type Environment } from './terms-gate';
import { resolveAdapterForSourceRow } from './adapter-registry';
import { ingestSource, type IngestSummary } from './ingest';

export type SourceSelector =
  | { id: string; family?: never; name?: never }
  | { id?: never; family: string; name: string };

export interface SourceForIngest {
  id: string;
  family: string;
  name: string;
  termsStatus: string;
  robotsStatus: string;
}

export interface TermsGatedIngestResult {
  ok: boolean;
  source: SourceForIngest;
  gate: { allowed: boolean; reason: string };
  adapterFamily?: string;
  summary?: IngestSummary;
  error?: string;
}

function selectorWhere(selector: SourceSelector): { sql: string; values: string[] } {
  if ('id' in selector && selector.id) {
    return { sql: 'id = $1', values: [selector.id] };
  }
  if ('family' in selector && selector.family && selector.name) {
    return { sql: 'family = $1 AND name = $2', values: [selector.family, selector.name] };
  }
  throw new Error('invalid source selector');
}

export async function loadSourceForIngest(
  pool: Pool,
  selector: SourceSelector
): Promise<SourceForIngest> {
  const where = selectorWhere(selector);
  const { rows } = await pool.query<{
    id: string;
    family: string;
    name: string;
    terms_status: string;
    robots_status: string;
  }>(
    `SELECT id, family, name, terms_status, robots_status
     FROM source
     WHERE ${where.sql}
     LIMIT 1`,
    where.values
  );
  if (!rows[0]) {
    const label = selector.id ?? `${selector.family} / ${selector.name}`;
    throw new Error(`source not found: ${label}`);
  }
  return {
    id: rows[0].id,
    family: rows[0].family,
    name: rows[0].name,
    termsStatus: rows[0].terms_status,
    robotsStatus: rows[0].robots_status,
  };
}

export async function runTermsGatedIngest(
  pool: Pool,
  selector: SourceSelector,
  environment: Environment = 'staging'
): Promise<TermsGatedIngestResult> {
  const source = await loadSourceForIngest(pool, selector);
  const gate = evaluateTermsGate(source, environment);
  if (!gate.allowed) {
    return { ok: false, source, gate, error: gate.reason };
  }

  const adapter = resolveAdapterForSourceRow(source);
  if (!adapter) {
    return {
      ok: false,
      source,
      gate,
      error: `no adapter registered for source family/name: ${source.family} / ${source.name}`,
    };
  }

  const summary = await ingestSource(pool, adapter, source.id);
  return {
    ok: summary.errors.length === 0,
    source,
    gate,
    adapterFamily: adapter.family,
    summary,
    error: summary.errors.length > 0 ? summary.errors.join('; ') : undefined,
  };
}
