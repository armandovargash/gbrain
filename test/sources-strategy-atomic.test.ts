/**
 * Atomic source strategy mutation regression.
 *
 * The old read/modify/write pair replaced the whole JSONB object and could
 * erase a config key written between its SELECT and UPDATE. The command now
 * mutates only `strategy` in one SQL statement; these PGLite-backed checks
 * prove unrelated keys survive both set and unset operations.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSourceSetStrategy } from '../src/commands/sources-strategy.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ('gstack', 'gstack', '{"federated":true,"ttl_days":90,"strategy":"markdown"}'::jsonb)`,
  );
});

async function config(): Promise<Record<string, unknown>> {
  const rows = await engine.executeRaw<{ config: Record<string, unknown> | string }>(
    `SELECT config FROM sources WHERE id = 'gstack'`,
  );
  return typeof rows[0]!.config === 'string'
    ? JSON.parse(rows[0]!.config)
    : rows[0]!.config;
}

describe('sources set-strategy — atomic JSONB mutation', () => {
  test('setting strategy preserves every unrelated config key', async () => {
    await runSourceSetStrategy(engine, ['gstack', 'code']);
    expect(await config()).toEqual({ federated: true, ttl_days: 90, strategy: 'code' });
  });

  test('unsetting strategy removes only strategy', async () => {
    await runSourceSetStrategy(engine, ['gstack', 'unset']);
    expect(await config()).toEqual({ federated: true, ttl_days: 90 });
  });
});
