import type { BrainEngine } from '../core/engine.ts';
import { normalizeSourceConfig, parseSourceConfig } from '../core/sources-load.ts';

type SourceStrategy = 'markdown' | 'code' | 'auto';

export async function runSourceSetStrategy(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  const requested = args[1];
  if (!id || !requested || !['markdown', 'code', 'auto', 'unset'].includes(requested)) {
    console.error('Usage: gbrain sources set-strategy <id> <markdown|code|auto|unset>');
    process.exit(2);
  }

  const rows = await engine.executeRaw<{ config: Record<string, unknown> | string }>(
    `SELECT config FROM sources WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) {
    console.error(`Source "${id}" not found.`);
    process.exit(4);
  }

  const config = parseSourceConfig(rows[0].config);
  if (requested === 'unset') delete config.strategy;
  else config.strategy = requested as SourceStrategy;
  await engine.executeRaw(
    `UPDATE sources SET config = $1::text::jsonb WHERE id = $2`,
    [JSON.stringify(normalizeSourceConfig(config)), id],
  );
  console.log(
    requested === 'unset'
      ? `Source "${id}" sync strategy is now unset (defaults to markdown).`
      : `Source "${id}" sync strategy set to "${requested}".`,
  );
}
