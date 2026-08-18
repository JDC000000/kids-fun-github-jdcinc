// tests/snapshot/policy.test.ts — unit lane. Guards the ALLOWLIST ITSELF.
//
// These are the assertions that make "we never export user data" a mechanical property rather
// than a claim in a comment. They run on every CI run, need no database, and are the reason a
// future change that quietly adds `user_profile` to SNAPSHOT_TABLES cannot merge green.
import { describe, expect, it } from 'vitest';
import {
  ALLOWLISTED_TABLES,
  EXCLUDED_TABLES,
  SNAPSHOT_TABLES,
  classifiedColumns,
  exportedColumns,
  policyFingerprint,
  tablePolicy,
} from '../../lib/snapshot/policy';
import { diffPolicyAgainstSchema } from '../../lib/snapshot/schema-guard';
import type { ColumnFingerprint } from '../../lib/snapshot/format';
import { safeErrorMessage } from '../../lib/snapshot/safe-error';

/**
 * The tables that hold personal data. Named individually and asserted individually, so that a
 * failure says WHICH table someone allowlisted rather than "the count changed".
 *
 * user_profile is first for a reason: saved_child_ages holds real children's ages and
 * google_identity holds a real account email. scripts/pipeda-cleanup/ exists because of it.
 */
const NEVER_EXPORT = [
  'user_profile',
  'saved_search',
  'admin_user',
  'admin_audit_log',
  'weekly_email_send',
  'correction_report',
  'analytics_event',
] as const;

describe('the allowlist', () => {
  it.each(NEVER_EXPORT)('never exports %s', (table) => {
    expect(ALLOWLISTED_TABLES).not.toContain(table);
    expect(tablePolicy(table)).toBeUndefined();
    // …and the reason it is out is recorded, so the next person does not have to re-derive it.
    expect(EXCLUDED_TABLES[table]).toBeTruthy();
  });

  it('exports only catalogue tables', () => {
    expect([...ALLOWLISTED_TABLES].sort()).toEqual(
      [
        'activity_occurrence',
        'activity_series',
        'age_band',
        'category',
        'occurrence_age',
        'occurrence_category_tag',
        'provenance',
        'region',
        'source',
        'synonym_alias',
        'tag',
        'venue',
      ].sort()
    );
  });

  it('never lists a table in both the allowlist and the exclusion list', () => {
    for (const t of ALLOWLISTED_TABLES) expect(EXCLUDED_TABLES[t]).toBeUndefined();
  });

  it('gives every excluded table a non-trivial reason', () => {
    for (const [table, why] of Object.entries(EXCLUDED_TABLES)) {
      expect(why.length, `${table} needs a real reason`).toBeGreaterThan(30);
    }
  });

  it('gives every allowlisted table a justification and a key', () => {
    for (const t of SNAPSHOT_TABLES) {
      expect(t.why.length, `${t.table} needs a justification`).toBeGreaterThan(30);
      expect(t.key, `${t.table} needs a key column`).toBeTruthy();
      expect(classifiedColumns(t)).toContain(t.key);
    }
  });

  it('gives every classified column a stated reason', () => {
    for (const t of SNAPSHOT_TABLES) {
      for (const [col, policy] of Object.entries(t.columns)) {
        expect(policy.why.length, `${t.table}.${col} needs a reason`).toBeGreaterThan(10);
      }
    }
  });

  it('keeps the FK load order valid — every table appears after the ones it references', () => {
    // Not decoration: the loader inserts in this order, so a table listed before its parent
    // would fail at load time against a real snapshot and pass every unit test.
    const order = SNAPSHOT_TABLES.map((t) => t.table);
    const refs: Record<string, string[]> = {
      synonym_alias: ['category', 'tag'],
      venue: ['region'],
      activity_series: ['source', 'venue', 'category'],
      activity_occurrence: ['activity_series', 'category'],
      occurrence_age: ['activity_occurrence'],
      occurrence_category_tag: ['activity_occurrence', 'category', 'tag'],
      provenance: ['activity_occurrence'],
    };
    for (const [table, parents] of Object.entries(refs)) {
      for (const parent of parents) {
        expect(order.indexOf(parent), `${parent} must load before ${table}`).toBeLessThan(order.indexOf(table));
      }
    }
  });
});

describe('what is preserved vs scrubbed', () => {
  /** The claim the whole snapshot rests on, asserted column by column. */
  const MUST_BE_PRESERVED: [string, string][] = [
    ['activity_occurrence', 'start_datetime_utc'],
    ['activity_occurrence', 'end_datetime_utc'],
    ['activity_occurrence', 'last_checked_at'],
    ['activity_occurrence', 'archived_at'],
    ['activity_occurrence', 'created_at'],
    ['activity_occurrence', 'updated_at'],
    ['activity_occurrence', 'registration_required'],
    ['activity_occurrence', 'cost_min_cad'],
    ['activity_occurrence', 'cost_max_cad'],
    ['occurrence_age', 'age_min_months'],
    ['occurrence_age', 'age_max_months'],
    ['occurrence_age', 'age_band_matches'],
    ['age_band', 'lower_months_inclusive'],
    ['age_band', 'upper_months_exclusive'],
    ['region', 'name'],
    ['region', 'level'],
    ['region', 'parent_id'],
    ['region', 'centroid'],
    ['venue', 'municipality_id'],
    ['venue', 'geo'],
    ['venue', 'neighbourhood'],
    ['venue', 'display_area'],
  ];

  it.each(MUST_BE_PRESERVED)('preserves %s.%s faithfully', (table, column) => {
    const policy = tablePolicy(table);
    expect(policy?.columns[column]?.action).toBe('preserve');
  });

  /** Free text that could carry incidental personal data must NOT be `preserve`. */
  const MUST_BE_SCRUBBED: [string, string][] = [
    ['activity_occurrence', 'description_snippet'],
    ['activity_occurrence', 'activity_name'],
    ['activity_occurrence', 'source_url'],
    ['activity_occurrence', 'booking_url'],
    ['activity_occurrence', 'location_url'],
    ['activity_series', 'canonical_title'],
    ['venue', 'name'],
    ['venue', 'address'],
    ['venue', 'accessibility_notes'],
    ['venue', 'official_url'],
    ['venue', 'phone'],
    ['occurrence_age', 'age_notes'],
    ['source', 'robots_override_note'],
    ['provenance', 'source_url'],
  ];

  it.each(MUST_BE_SCRUBBED)('scrubs %s.%s', (table, column) => {
    const policy = tablePolicy(table);
    expect(policy?.columns[column]?.action).not.toBe('preserve');
    expect(policy?.columns[column]?.action).not.toBe('derived_drop');
  });

  it('never exports the pre-scrub FTS index', () => {
    // search_tsv is a lexeme index of the UNSCRUBBED description. Exporting it would hand back
    // exactly what the scrub removed, one word at a time.
    const occ = tablePolicy('activity_occurrence');
    expect(occ?.columns.search_tsv.action).toBe('derived_drop');
    expect(exportedColumns(occ!)).not.toContain('search_tsv');
  });
});

describe('schema guard', () => {
  const live = (): Map<string, ColumnFingerprint[]> => {
    const m = new Map<string, ColumnFingerprint[]>();
    for (const t of SNAPSHOT_TABLES) {
      m.set(
        t.table,
        classifiedColumns(t).map((name) => ({ name, type: 'text', notNull: false }))
      );
    }
    return m;
  };

  it('passes when the schema matches the policy', () => {
    expect(diffPolicyAgainstSchema(live()).errors).toEqual([]);
  });

  it('FAILS LOUDLY when a migration adds a column to an allowlisted table', () => {
    // The realistic leak: venue.phone arrived exactly this way, in migration 0024.
    const m = live();
    m.set('venue', [...m.get('venue')!, { name: 'owner_personal_email', type: 'text', notNull: false }]);
    const { errors } = diffPolicyAgainstSchema(m);
    expect(errors.join('\n')).toContain('UNCLASSIFIED COLUMN venue.owner_personal_email');
  });

  it('fails when a classified column disappears, because the policy is then stale', () => {
    const m = live();
    m.set('venue', m.get('venue')!.filter((c) => c.name !== 'phone'));
    expect(diffPolicyAgainstSchema(m).errors.join('\n')).toContain('STALE POLICY: venue.phone');
  });

  it('only NOTICES a brand-new table — deny-by-default means it cannot leak', () => {
    const m = live();
    m.set('brand_new_thing', [{ name: 'id', type: 'uuid', notNull: true }]);
    const { errors, notices } = diffPolicyAgainstSchema(m);
    expect(errors).toEqual([]);
    expect(notices.join('\n')).toContain('NEW TABLE "brand_new_thing"');
  });

  it('does not notice a table that is explicitly excluded', () => {
    const m = live();
    m.set('user_profile', [{ name: 'id', type: 'uuid', notNull: true }]);
    expect(diffPolicyAgainstSchema(m).notices.join('\n')).not.toContain('user_profile');
  });
});

describe('policyFingerprint', () => {
  it('is stable across calls, so a snapshot manifest can be compared to a checkout', () => {
    expect(policyFingerprint()).toBe(policyFingerprint());
  });

  it('covers every table and action', () => {
    const fp = policyFingerprint();
    for (const t of SNAPSHOT_TABLES) expect(fp).toContain(t.table);
  });
});

describe('safeErrorMessage — no snapshot tool may print a credential', () => {
  it('redacts a connection string quoted back by a driver error', () => {
    const out = safeErrorMessage(new Error('could not connect to postgres://admin:hunter2@db.example.com:5432/prod'));
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('db.example.com');
    expect(out).toContain('[connection-string-redacted]');
  });

  it('drops everything after the first line, where stack traces live', () => {
    expect(safeErrorMessage(new Error('boom\n  at Object.<anonymous> (/app/secret/path.ts:1:1)'))).toBe('boom');
  });

  it('handles non-Error throws without leaking their shape', () => {
    expect(safeErrorMessage({ password: 'hunter2' })).toBe('unknown error');
  });
});
