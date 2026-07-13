import { describe, it, expect } from 'vitest';
import { Client } from 'pg';

// 0014_admin_rls.sql — security regression test: admin_user / admin_audit_log
// must be default-deny to the authenticated role (no anon-key REST enumeration
// of the admin roster). See migration header for the finding this fixes.
const hasDb = Boolean(process.env.DATABASE_URL);

function authenticatedConnectionString(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.username = 'authenticated';
  url.password = 'local_dev_only_not_a_secret';
  return url.toString();
}

describe.skipIf(!hasDb)('admin_user / admin_audit_log RLS (security regression)', () => {
  it('the authenticated role cannot SELECT from admin_user', async () => {
    const client = new Client({ connectionString: authenticatedConnectionString() });
    await client.connect();
    try {
      await expect(client.query('SELECT * FROM admin_user')).rejects.toThrow();
    } finally {
      await client.end();
    }
  });

  it('the authenticated role cannot SELECT from admin_audit_log', async () => {
    const client = new Client({ connectionString: authenticatedConnectionString() });
    await client.connect();
    try {
      await expect(client.query('SELECT * FROM admin_audit_log')).rejects.toThrow();
    } finally {
      await client.end();
    }
  });
});
