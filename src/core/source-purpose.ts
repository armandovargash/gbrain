import type { BrainEngine } from './engine.ts';
import { parseSourceConfig } from './sources-load.ts';

/**
 * A code source is retrieved through the symbol/edge graph. It must not be
 * folded into health checks whose remediation is memory extraction or vector
 * embedding: doing so prescribes expensive work that cannot improve code
 * retrieval and makes a healthy mixed-purpose brain look degraded.
 */
export function isCodeSourceConfig(config: unknown): boolean {
  return parseSourceConfig(config).strategy === 'code';
}

/** Active sources whose contract is curated/searchable memory, not code. */
export async function listActiveMemorySourceIds(engine: BrainEngine): Promise<string[]> {
  const sources = await engine.listAllSources();
  return sources
    .filter((source) => !isCodeSourceConfig(source.config))
    .map((source) => source.id);
}

/** SQL predicate for queries that already join the source table as `s`. */
export const ACTIVE_MEMORY_SOURCE_SQL =
  "s.archived IS NOT TRUE AND COALESCE(s.config->>'strategy', '') <> 'code'";

/** SQL predicate for queries whose page alias is `p`. */
export const ACTIVE_MEMORY_PAGE_SQL =
  `EXISTS (
     SELECT 1 FROM sources s
      WHERE s.id = p.source_id
        AND ${ACTIVE_MEMORY_SOURCE_SQL}
   )`;
