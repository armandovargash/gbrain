import type { BrainEngine } from './engine.ts';

export type SyncStrategy = 'markdown' | 'code' | 'auto';

/** Keep an explicit CLI strategy authoritative, otherwise inherit source config. */
export function resolveSingleSourceSyncStrategy(
  explicit: SyncStrategy | undefined,
  sourceConfig: Record<string, unknown> | null | undefined,
): SyncStrategy | undefined {
  if (explicit) return explicit;
  const configured = sourceConfig?.strategy;
  return configured === 'markdown' || configured === 'code' || configured === 'auto'
    ? configured
    : undefined;
}

export async function resolveRegisteredSourceSyncStrategy(
  engine: BrainEngine,
  sourceId: string,
  explicit: SyncStrategy | undefined,
): Promise<SyncStrategy | undefined> {
  const rows = await engine.executeRaw<{ config: Record<string, unknown> }>(
    `SELECT config FROM sources WHERE id = $1`,
    [sourceId],
  );
  return resolveSingleSourceSyncStrategy(explicit, rows[0]?.config);
}
