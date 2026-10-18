import { describe, expect, it } from 'vitest';
import { isNewerVersion } from './version';

describe('isNewerVersion', () => {
  it.each([
    ['0.3.0', '0.2.0', true],
    ['v0.2.1', '0.2.0', true],
    ['1.0.0', '0.9.9', true],
    ['0.10.0', '0.9.0', true],
    ['0.2.0', '0.2.0-rc.1', true],
    ['0.2.0', '0.2.0', false],
    ['v0.1.1', '0.2.0', false],
    ['0.2.0-rc.1', '0.2.0', false],
    ['0.3.0-rc.1', '0.3.0-rc.2', false],
    ['latest', '0.2.0', false],
    ['0.3', '0.2.0', false],
  ])('%s is newer than %s: %s', (candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected);
  });
});
