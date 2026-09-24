// tests/admin/staging-viewer-guard.test.ts — the refusals of scripts/staging-viewer/guard.ts, which
// the staging viewer mint script runs BEFORE any network call. "Staging only" is enforced here, by
// the tool, not by the care of whoever runs it.
import { describe, expect, it } from 'vitest';
import {
  assertExpectedUserId,
  assertSessionOutPath,
  assertSignedInAsExpected,
  assertStagingAppOrigin,
  assertStagingSupabaseUrl,
  assertViewerEmail,
  PRODUCTION_SUPABASE_REF,
  STAGING_APP_ORIGIN,
  STAGING_SUPABASE_REF,
} from '../../scripts/staging-viewer/guard';

const never = () => false;
const UID = '3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c';

describe('Supabase project: staging ref only', () => {
  it('accepts exactly the staging project', () => {
    expect(assertStagingSupabaseUrl(`https://${STAGING_SUPABASE_REF}.supabase.co`).hostname).toBe(
      `${STAGING_SUPABASE_REF}.supabase.co`
    );
  });

  it('🔴 refuses PRODUCTION by name', () => {
    expect(() => assertStagingSupabaseUrl(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`)).toThrow(/PRODUCTION/);
  });

  it('🔴 refuses anything else: unset, http, other host, look-alikes, ports', () => {
    for (const bad of [
      undefined,
      '',
      'not a url',
      `http://${STAGING_SUPABASE_REF}.supabase.co`,
      `https://${STAGING_SUPABASE_REF}.supabase.co.evil.example`,
      `https://evil.example/${STAGING_SUPABASE_REF}.supabase.co`,
      `https://x${STAGING_SUPABASE_REF}.supabase.co`,
      `https://${STAGING_SUPABASE_REF}.supabase.co:8443`,
      'http://127.0.0.1:54321',
    ]) {
      expect(() => assertStagingSupabaseUrl(bad), String(bad)).toThrow(/REFUSING/);
    }
  });
});

describe('app origin: the staging deployment only', () => {
  it('defaults to, and accepts, the staging origin', () => {
    expect(assertStagingAppOrigin(undefined).origin).toBe(STAGING_APP_ORIGIN);
    expect(assertStagingAppOrigin(STAGING_APP_ORIGIN).origin).toBe(STAGING_APP_ORIGIN);
  });

  it('🔴 refuses every production origin by name, and anything else', () => {
    for (const host of ['kidsfunapp.ca', 'www.kidsfunapp.ca', 'kids-fun-psi.vercel.app', 'kids-fun-jdci-nc.vercel.app']) {
      expect(() => assertStagingAppOrigin(`https://${host}`), host).toThrow(/PRODUCTION/);
    }
    for (const bad of ['http://kids-fun-staging-jdci-nc.vercel.app', 'https://kids-fun-ashy.vercel.app', 'https://evil.example']) {
      expect(() => assertStagingAppOrigin(bad), bad).toThrow(/REFUSING/);
    }
  });
});

describe('identity', () => {
  it('requires the reserved viewer email domain', () => {
    expect(assertViewerEmail('agent-qa@viewer.kids-fun.test')).toBe('agent-qa@viewer.kids-fun.test');
    for (const bad of [undefined, '', 'jon@gmail.com', 'x@kids-fun.test', 'x@viewer.kids-fun.test.evil.example', '@viewer.kids-fun.test']) {
      expect(() => assertViewerEmail(bad), String(bad)).toThrow(/REFUSING/);
    }
  });

  it('requires an expected user id, and the signed-in user must match it', () => {
    expect(assertExpectedUserId(UID)).toBe(UID);
    expect(() => assertExpectedUserId(undefined)).toThrow(/REFUSING/);
    expect(() => assertExpectedUserId('not-a-uuid')).toThrow(/REFUSING/);
    expect(() => assertSignedInAsExpected(UID, UID)).not.toThrow();
    expect(() => assertSignedInAsExpected('00000000-0000-4000-8000-000000000000', UID)).toThrow(/NOT been written/);
    expect(() => assertSignedInAsExpected(undefined, UID)).toThrow(/REFUSING/);
  });
});

describe('session file', () => {
  const ok = '/opt/projects/crhq-satellite/.scratch/kf-viewer/state.json';

  it('accepts an absolute .json path inside .scratch/ that does not exist yet', () => {
    expect(assertSessionOutPath(ok, never)).toBe(ok);
  });

  it('🔴 refuses outside .scratch/, relative, traversal, non-json, and overwriting', () => {
    for (const bad of [
      undefined,
      '',
      'state.json',
      '.scratch/kf-viewer/state.json',
      '/tmp/state.json',
      '/opt/projects/crhq-satellite/documents/state.json',
      '/opt/projects/crhq-satellite/.scratch/../documents/state.json',
      '/opt/projects/crhq-satellite/.scratch/kf-viewer/state.txt',
    ]) {
      expect(() => assertSessionOutPath(bad, never), String(bad)).toThrow(/REFUSING/);
    }
    expect(() => assertSessionOutPath(ok, () => true)).toThrow(/already exists/);
  });
});
