import { describe, expect, it } from 'vitest';
import { poolConfigFor } from '../lib/db/pool-config';

describe('poolConfigFor', () => {
  it('does not force SSL for local Postgres', () => {
    expect(poolConfigFor('postgres://postgres:postgres@127.0.0.1:5432/kids_fun').ssl).toBeUndefined();
    expect(poolConfigFor('postgres://postgres:postgres@localhost:5432/kids_fun').ssl).toBeUndefined();
  });

  it('enables SSL for remote/Supabase-style hosts even without sslmode in the secret', () => {
    expect(poolConfigFor('postgres://postgres:secret@db.example.supabase.co:5432/postgres').ssl).toEqual({ rejectUnauthorized: false });
  });

  it('respects an explicit sslmode=disable override', () => {
    expect(poolConfigFor('postgres://postgres:secret@db.example.com:5432/postgres?sslmode=disable').ssl).toBeUndefined();
  });
});
