const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const parse = (value: string) => {
  const match = versionPattern.exec(value.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], preRelease: match[4] ?? null };
};

/**
 * Whether `candidate` is a later version than `current` (`major.minor.patch`, optional `v` prefix and
 * `-pre-release` suffix). Unparseable versions never count as newer, so a malformed tag shows no notice.
 */
export const isNewerVersion = (candidate: string, current: string) => {
  const next = parse(candidate);
  const now = parse(current);
  if (!next || !now) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next.core[index] !== now.core[index]) return next.core[index] > now.core[index];
  }
  // Same major.minor.patch: only the final release is newer than its pre-release.
  return next.preRelease === null && now.preRelease !== null;
};
