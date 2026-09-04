import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  ACTIVE_MEMORY_SOURCE_SQL,
  isCodeSourceConfig,
} from '../src/core/source-purpose.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { checkLinksExtractionLag } from '../src/commands/doctor.ts';

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
});

describe('source purpose', () => {
  test('only an explicit code strategy is a code source', () => {
    expect(isCodeSourceConfig({ strategy: 'code' })).toBe(true);
    expect(isCodeSourceConfig({ strategy: 'markdown' })).toBe(false);
    expect(isCodeSourceConfig({ strategy: 'auto' })).toBe(false);
    expect(isCodeSourceConfig({})).toBe(false);
    expect(isCodeSourceConfig(null)).toBe(false);
  });

  test('SQL predicate matches JS recovery for nested strings and array fragments', async () => {
    const configs: Array<[string, unknown]> = [
      ['object-code', { strategy: 'code', concurrent_key: 'kept' }],
      ['nested-code', JSON.stringify(JSON.stringify({ strategy: 'code', concurrent_key: 'kept' }))],
      ['array-code', [{ federated: true }, JSON.stringify({ strategy: 'code' })]],
      ['memory', { strategy: 'markdown' }],
    ];
    for (const [id, config] of configs) {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::jsonb)`,
        [id, JSON.stringify(config)],
      );
    }

    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT s.id FROM sources s WHERE ${ACTIVE_MEMORY_SOURCE_SQL} ORDER BY s.id`,
    );
    const sqlMemoryIds = rows.map((row) => row.id);

    expect(configs.filter(([, config]) => !isCodeSourceConfig(config)).map(([id]) => id)).toEqual(['memory']);
    expect(sqlMemoryIds).toContain('memory');
    expect(sqlMemoryIds).not.toContain('object-code');
    expect(sqlMemoryIds).not.toContain('nested-code');
    expect(sqlMemoryIds).not.toContain('array-code');

    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth)
       VALUES
         ('object-code', 'code/object', 'code', 'code', 'Object code', 'code'),
         ('nested-code', 'code/nested', 'code', 'code', 'Nested code', 'code'),
         ('array-code', 'code/array', 'code', 'code', 'Array code', 'code')`,
    );
    const extractionHealth = await checkLinksExtractionLag(engine);
    expect(extractionHealth.status).toBe('ok');
    expect(extractionHealth.message).toBe('Extraction lag not applicable (no pages)');
  });
});
