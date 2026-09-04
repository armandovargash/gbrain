/**
 * A failed upgrade is no longer actionable once the running binary is at or
 * beyond its target and the schema plane is current. Kept outside doctor.ts so
 * the large command facade does not grow for a pure version decision.
 */
export function upgradeErrorResolved(
  failedToVersion: string,
  binaryVersion: string,
  schemaCurrent: boolean,
): boolean {
  if (!schemaCurrent) return false;
  if (typeof failedToVersion !== 'string' || typeof binaryVersion !== 'string') return false;
  const a = binaryVersion.replace(/^v/, '').split('.');
  const b = failedToVersion.replace(/^v/, '').split('.');
  if (a.length === 0 || b.length === 0 || [...a, ...b].some((part) => !/^\d+$/.test(part))) {
    return false;
  }
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const da = Number(a[i] ?? '0');
    const db = Number(b[i] ?? '0');
    if (da > db) return true;
    if (da < db) return false;
  }
  return true;
}
