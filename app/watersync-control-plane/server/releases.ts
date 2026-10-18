import { logger, serializeError } from './logging.js';

export type Release = {
  /** Tag without a leading "v", e.g. 0.3.0. */
  version: string;
  name: string;
  /** Release notes as written on GitHub (Markdown). */
  notes: string;
  url: string;
  publishedAt: string | null;
};

// Set WATERSYNC_RELEASES_REPO to another owner/name, or to an empty value to turn the check off.
const repository = process.env.WATERSYNC_RELEASES_REPO ?? 'databricks-industry-solutions/watersync';
const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;
// Unauthenticated GitHub API calls are limited per egress IP, which Databricks Apps share, so ask rarely.
const successTtlMs = 60 * 60 * 1000;
const failureTtlMs = 15 * 60 * 1000;

let cached: { release: Release | null; expiresAt: number } | null = null;
let pending: Promise<Release | null> | null = null;

type GitHubRelease = {
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  html_url?: string;
  published_at?: string | null;
};

async function fetchLatestRelease(): Promise<{ release: Release | null; ttlMs: number }> {
  if (!repositoryPattern.test(repository)) return { release: null, ttlMs: successTtlMs };
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'watersync-control-plane',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(5000),
    });
    // 404: the repository has no published release yet (drafts and pre-releases are never "latest").
    if (response.status === 404) return { release: null, ttlMs: successTtlMs };
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const body = (await response.json()) as GitHubRelease;
    const tag = body.tag_name?.trim();
    if (!tag || !body.html_url) return { release: null, ttlMs: successTtlMs };
    return {
      release: {
        version: tag.replace(/^v/i, ''),
        name: body.name?.trim() || tag,
        notes: body.body ?? '',
        url: body.html_url,
        publishedAt: body.published_at ?? null,
      },
      ttlMs: successTtlMs,
    };
  } catch (error) {
    // Usually no outbound internet access from the workspace; the UI then just shows no notice.
    logger.warn('releases.check_failed', { repository, error: serializeError(error) });
    return { release: null, ttlMs: failureTtlMs };
  }
}

/** Latest published GitHub release of the WaterSync repository, or null when unknown. Never throws. */
export async function latestRelease(now = Date.now()): Promise<Release | null> {
  if (cached && cached.expiresAt > now) return cached.release;
  // Concurrent page loads share one request.
  pending ??= fetchLatestRelease()
    .then(({ release, ttlMs }) => {
      cached = { release, expiresAt: Date.now() + ttlMs };
      return release;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** For tests. */
export function resetReleaseCache() {
  cached = null;
  pending = null;
}
