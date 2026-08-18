// tests/snapshot/verify.test.ts — unit lane (filesystem only, no database).
//
// A guard nobody has ever seen fail is not a guard, it is a decoration. These tests build real
// snapshot directories on disk — gzipped NDJSON plus a manifest, exactly what the export
// writes — plant a specific violation in each, and assert the verifier catches THAT violation.
//
// The cases are the ways the pipeline could actually break: a leaked email, a real phone in a
// placeholder column, a file for a table nobody allowlisted, a tampered file, a stale policy.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifySnapshot } from '../../lib/snapshot/verify';
import { SNAPSHOT_FORMAT_VERSION, sha256, type SnapshotManifest, type SnapshotRow } from '../../lib/snapshot/format';
import { SNAPSHOT_TABLES, exportedColumns, policyFingerprint } from '../../lib/snapshot/policy';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A minimal, VALID snapshot: every allowlisted table present, one row in `venue`. */
function buildSnapshot(overrides: { venueRow?: Partial<SnapshotRow>; extraFile?: [string, string] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'kf-snapshot-test-'));
  dirs.push(dir);

  const venueRow: SnapshotRow = {
    id: 'cccc0000-0000-4000-8000-000000000001',
    name: 'Mount Pleasant Branch',
    address: '1 Kingsway, Vancouver, BC V5T 3H7',
    municipality_id: 'aaaa0000-0000-4000-8000-000000000002',
    neighbourhood: 'Mount Pleasant',
    display_area: 'Vancouver — East',
    accessibility_notes: 'Step-free entrance on the north side.',
    official_url: 'https://example.org/mp',
    created_at: '2026-08-18 14:15:53.71545+00',
    updated_at: '2026-08-18 14:15:53.71545+00',
    geo: '0101000020E6100000DF4F8D976EC65EC09A99999999A14840',
    phone: '(604) 555-0100',
    geo_authority: '1',
    geo_source: 'municipal_open_data',
    geo_attribution: 'City of X',
    geo_set_at: '2026-05-02 11:00:00+00',
    ...overrides.venueRow,
  };

  const tables: SnapshotManifest['tables'] = [];
  SNAPSHOT_TABLES.forEach((policy, i) => {
    const file = `${String(i + 1).padStart(2, '0')}_${policy.table}.ndjson.gz`;
    const cols = exportedColumns(policy);
    // Policy columns first, then any EXTRA key the test planted — otherwise the
    // "unexpected column" case would be filtered out before it ever reached the file.
    const extra = Object.keys(overrides.venueRow ?? {}).filter((k) => !cols.includes(k));
    const rows =
      policy.table === 'venue'
        ? [JSON.stringify(Object.fromEntries([...cols, ...extra].map((c) => [c, venueRow[c] ?? null])))]
        : [];
    const buf = gzipSync(Buffer.from(rows.map((r) => `${r}\n`).join(''), 'utf8'));
    writeFileSync(join(dir, file), buf);
    tables.push({ table: policy.table, file, rows: rows.length, sha256: sha256(buf), bytes: buf.byteLength, redactions: {} });
  });

  if (overrides.extraFile) writeFileSync(join(dir, overrides.extraFile[0]), gzipSync(Buffer.from(overrides.extraFile[1])));

  const manifest: SnapshotManifest = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    label: 'test',
    createdAt: '2026-08-18T00:00:00.000Z',
    policyFingerprint: sha256(policyFingerprint()),
    schema: { migrations: [], tables: {} },
    tables,
    totals: { rows: 1, bytes: 0 },
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

describe('verifySnapshot', () => {
  it('passes a clean snapshot', async () => {
    const { problems, rowsScanned } = await verifySnapshot(buildSnapshot());
    expect(problems).toEqual([]);
    expect(rowsScanned).toBe(1);
  });

  it('CATCHES an email that survived in a scrubbed column', async () => {
    const dir = buildSnapshot({ venueRow: { accessibility_notes: 'Ask for amelia.novak@example.org.' } });
    const { problems } = await verifySnapshot(dir);
    expect(problems.join('\n')).toContain('venue.accessibility_notes row 1: RESIDUAL PERSONAL DATA (email)');
  });

  it('CATCHES an email that survived in a PRESERVE column — a policy bug, not a scrub miss', async () => {
    const dir = buildSnapshot({ venueRow: { geo_attribution: 'Provided by sam@example.org' } });
    expect((await verifySnapshot(dir)).problems.join('\n')).toContain('venue.geo_attribution row 1: RESIDUAL PERSONAL DATA');
  });

  it('CATCHES a real phone number left in the placeholder column', async () => {
    const dir = buildSnapshot({ venueRow: { phone: '(604) 555-0123' } });
    expect((await verifySnapshot(dir)).problems.join('\n')).toContain(
      'venue.phone row 1: placeholder_phone column has digits a placeholder would not produce'
    );
  });

  it('CATCHES credentials left inside a URL', async () => {
    const dir = buildSnapshot({ venueRow: { official_url: 'https://ops:hunter2@example.org/mp' } });
    // The email detector fires too ("hunter2@example.org" is email-shaped) — both are correct
    // findings on the same value, so assert the credentials one is present, not that it is alone.
    expect((await verifySnapshot(dir)).problems.join('\n')).toMatch(
      /venue\.official_url row 1: RESIDUAL PERSONAL DATA \(.*credentials.*\)/
    );
  });

  it('CATCHES a file for a table that is not allowlisted', async () => {
    // The nightmare case: somebody adds user_profile to the export by hand.
    const dir = buildSnapshot({ extraFile: ['99_user_profile.ndjson.gz', '{"id":"x"}\n'] });
    expect((await verifySnapshot(dir)).problems.join('\n')).toContain(
      'FILE FOR NON-ALLOWLISTED TABLE: 99_user_profile.ndjson.gz'
    );
  });

  it('CATCHES a column that is not in the policy', async () => {
    const dir = buildSnapshot({ venueRow: { owner_email: 'x@example.org' } });
    expect((await verifySnapshot(dir)).problems.join('\n')).toContain('unexpected column "owner_email"');
  });

  it('CATCHES a file tampered with after export', async () => {
    const dir = buildSnapshot();
    writeFileSync(join(dir, '07_venue.ndjson.gz'), gzipSync(Buffer.from('{"id":"tampered"}\n')));
    expect((await verifySnapshot(dir)).problems.join('\n')).toContain('sha256 does not match the manifest');
  });

  it('CATCHES a snapshot taken under a different policy', async () => {
    const dir = buildSnapshot();
    const manifestPath = join(dir, 'manifest.json');
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
    m.policyFingerprint = 'stale-fingerprint';
    writeFileSync(manifestPath, JSON.stringify(m));
    expect((await verifySnapshot(dir)).problems.join('\n')).toContain('policy fingerprint mismatch');
  });

  it('reports a directory that is not a snapshot at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kf-not-a-snapshot-'));
    dirs.push(dir);
    expect((await verifySnapshot(dir)).problems.join('\n')).toContain('no manifest.json');
  });

  it('NEVER echoes the offending value — a leak report must not be a second leak', async () => {
    const dir = buildSnapshot({ venueRow: { accessibility_notes: 'Ask for amelia.novak@example.org.' } });
    const { problems } = await verifySnapshot(dir);
    expect(problems.join('\n')).not.toContain('amelia.novak@example.org');
  });
});
