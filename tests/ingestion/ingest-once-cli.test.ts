import { afterEach, describe, it, expect } from 'vitest';
import { parseArgs } from '../../worker/src/ingest-once';

describe('ingest-once CLI args', () => {
  const oldEnv = { ...process.env };
  afterEach(() => {
    process.env.KIDS_FUN_SOURCE_ID = oldEnv.KIDS_FUN_SOURCE_ID;
    process.env.KIDS_FUN_SOURCE_FAMILY = oldEnv.KIDS_FUN_SOURCE_FAMILY;
    process.env.KIDS_FUN_SOURCE_NAME = oldEnv.KIDS_FUN_SOURCE_NAME;
    process.env.KIDS_FUN_INGEST_ENV = oldEnv.KIDS_FUN_INGEST_ENV;
    process.env.APP_ENV = oldEnv.APP_ENV;
  });

  it('fails closed when environment is missing or invalid', () => {
    delete process.env.KIDS_FUN_INGEST_ENV;
    delete process.env.APP_ENV;
    expect(() => parseArgs(['--source-id', 'source-1'])).toThrow(/explicit --env/);
    expect(() => parseArgs(['--source-id', 'source-1', '--env', 'preview'])).toThrow(/explicit --env/);
  });

  it('accepts an explicit staging or production environment', () => {
    expect(parseArgs(['--source-id', 'source-1', '--env', 'staging']).environment).toBe('staging');
    expect(parseArgs(['--source-id', 'source-1', '--env', 'production']).environment).toBe('production');
  });
});
