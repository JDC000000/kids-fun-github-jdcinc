// tests/corrections/client.test.ts — browser reportCorrection is safe + posts JSON.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { reportCorrection } from '../../lib/corrections/client';

const OCC = '11111111-1111-1111-1111-111111111111';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reportCorrection (browser helper)', () => {
  it('POSTs the occurrenceId + payload to /api/corrections', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const r = await reportCorrection(OCC, { note: 'time wrong' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/corrections');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ occurrenceId: OCC, note: 'time wrong' });
    expect(r.ok).toBe(true);
  });

  it('resolves { ok:false } (never throws) when the transport blows up', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    await expect(reportCorrection(OCC)).resolves.toEqual({ ok: false });
  });

  it('reports ok=false on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    await expect(reportCorrection(OCC)).resolves.toEqual({ ok: false });
  });
});
