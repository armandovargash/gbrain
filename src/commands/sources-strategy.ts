import type { BrainEngine } from '../core/engine.ts';

type SourceStrategy = 'markdown' | 'code' | 'auto';

export async function runSourceSetStrategy(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  const requested = args[1];
  if (!id || !requested || !['markdown', 'code', 'auto', 'unset'].includes(requested)) {
    console.error('Usage: gbrain sources set-strategy <id> <markdown|code|auto|unset>');
    process.exit(2);
  }

  // Mutate only config.strategy in one statement. The previous SELECT then
  // whole-object UPDATE could erase a concurrent supervisor/cycle config write.
  const objectConfig = `CASE
    WHEN jsonb_typeof(COALESCE(config, '{}'::jsonb)) = 'object'
      THEN COALESCE(config, '{}'::jsonb)
    ELSE '{}'::jsonb
  END`;
  const rows = requested === 'unset'
    ? await engine.executeRaw<{ id: string }>(
        `UPDATE sources
            SET config = (${objectConfig}) - 'strategy'
          WHERE id = $1
        RETURNING id`,
        [id],
      )
    : await engine.executeRaw<{ id: string }>(
        `UPDATE sources
            SET config = (${objectConfig}) || jsonb_build_object('strategy', $2::text)
          WHERE id = $1
        RETURNING id`,
        [id, requested as SourceStrategy],
      );
  if (rows.length === 0) {
    console.error(`Source "${id}" not found.`);
    process.exit(4);
  }
  console.log(
    requested === 'unset'
      ? `Source "${id}" sync strategy is now unset (defaults to markdown).`
      : `Source "${id}" sync strategy set to "${requested}".`,
  );
}
