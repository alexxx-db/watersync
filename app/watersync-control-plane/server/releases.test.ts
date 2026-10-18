import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { latestRelease, resetReleaseCache } from './releases.js';

const fetchMock = vi.fn<typeof fetch>();
const github = (status: number, body: unknown = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

beforeEach(() => {
  resetReleaseCache();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('latestRelease', () => {
  it('returns the latest release with the version taken from its tag', async () => {
    fetchMock.mockReturnValue(
      github(200, {
        tag_name: 'v0.3.0',
        name: 'WaterSync 0.3.0',
        body: '## What changed',
        html_url: 'https://github.com/databricks-industry-solutions/watersync/releases/tag/v0.3.0',
        published_at: '2026-11-01T10:00:00Z',
      })
    );
    await expect(latestRelease()).resolves.toEqual({
      version: '0.3.0',
      name: 'WaterSync 0.3.0',
      notes: '## What changed',
      url: 'https://github.com/databricks-industry-solutions/watersync/releases/tag/v0.3.0',
      publishedAt: '2026-11-01T10:00:00Z',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/databricks-industry-solutions/watersync/releases/latest',
      expect.anything()
    );
  });

  it('returns null when the repository has no release', async () => {
    fetchMock.mockReturnValue(github(404, { message: 'Not Found' }));
    await expect(latestRelease()).resolves.toBeNull();
  });

  it('returns null without throwing when GitHub cannot be reached, and does not retry right away', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(latestRelease()).resolves.toBeNull();
    await expect(latestRelease()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches the answer for an hour', async () => {
    fetchMock.mockImplementation(() =>
      github(200, { tag_name: 'v0.3.0', html_url: 'https://github.com/x/y/releases/1' })
    );
    await latestRelease();
    await latestRelease(Date.now() + 59 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await latestRelease(Date.now() + 61 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent callers', async () => {
    fetchMock.mockImplementation(() =>
      github(200, { tag_name: '0.3.0', html_url: 'https://github.com/x/y/releases/1' })
    );
    const [first, second] = await Promise.all([latestRelease(), latestRelease()]);
    expect(first?.version).toBe('0.3.0');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
