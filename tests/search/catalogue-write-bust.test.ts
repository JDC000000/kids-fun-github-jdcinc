// tests/search/catalogue-write-bust.test.ts — bustCatalogueAfterAdminWrite, the helper every
// catalogue-changing admin server action calls after its write commits
// (tests/admin/admin-actions-catalogue-bust.test.ts pins which actions call it, and when).
//
// The contract pinned here: it busts through the repository, and it NEVER throws — the admin's write
// has already committed, so a failed bust must be reported (log + Sentry), not turned into
// "nothing was changed". UNIT lane: the repository and the Sentry helper are mocked.
import { afterEach, describe, expect, it, vi } from 'vitest';

const bust = vi.hoisted(() => vi.fn(async () => {}));
const capture = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/search/postgres-repository', () => ({ bustSharedCatalogueCache: bust }));
vi.mock('@/lib/observability/route-handler', () => ({ captureAndFlush: capture }));

import { bustCatalogueAfterAdminWrite } from '@/lib/search/catalogue-write-bust';

afterEach(() => {
  vi.restoreAllMocks();
  bust.mockReset();
  capture.mockReset();
});

describe('bustCatalogueAfterAdminWrite', () => {
  it('busts the shared catalogue cache and logs which admin write did it', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await bustCatalogueAfterAdminWrite('correction.resolve');
    expect(bust).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain('auto-bust after admin correction.resolve');
    expect(capture).not.toHaveBeenCalled();
  });

  it('a failed bust never throws: it logs, reports to Sentry, and points at the manual bust', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('data cache down');
    bust.mockRejectedValueOnce(failure);

    await expect(bustCatalogueAfterAdminWrite('listing.create')).resolves.toBeUndefined();
    const line = String(error.mock.calls[0]?.[0]);
    expect(line).toContain('auto-bust after admin listing.create FAILED (data cache down)');
    expect(line).toContain('/api/admin/catalogue-cache/bust');
    expect(capture).toHaveBeenCalledWith(failure, undefined, {
      operation: 'catalogue_auto_bust',
      admin_action: 'listing.create',
    });
  });
});
