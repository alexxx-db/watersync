import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Lockfile = { packages: Record<string, { resolved?: string }> };

// `npm install` records the registry it downloaded from. A private mirror (such as one reachable only from a
// corporate network) then ends up in the lockfile and breaks `npm ci` in the Databricks Apps build and in CI.
describe('package-lock.json', () => {
  it('resolves every package from the public npm registry', () => {
    const lockfile = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as Lockfile;
    const elsewhere = Object.entries(lockfile.packages)
      .filter(([, entry]) => entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/'))
      .map(([name, entry]) => `${name} -> ${entry.resolved}`);
    expect(elsewhere).toEqual([]);
  });
});
