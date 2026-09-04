import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  checkEmbedStaleness,
  checkEntityLinkCoverage,
  checkTimelineCoverage,
  checkTypeProliferation,
} from '../src/core/onboard/checks.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  for (const table of ['links', 'content_chunks', 'timeline_entries', 'tags', 'page_versions', 'pages']) {
    await engine.executeRaw(`DELETE FROM ${table}`);
  }
  await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
});

async function addNonMemorySources() {
  await engine.executeRaw(`
    INSERT INTO sources (id, name, archived, config) VALUES
      ('code-source', 'code-source', false, '{"strategy":"code"}'::jsonb),
      ('archived-source', 'archived-source', true, '{"strategy":"markdown"}'::jsonb)
  `);
}

describe('onboard health source-purpose isolation', () => {
  test('code and archived chunks do not create a memory embedding backlog', async () => {
    await addNonMemorySources();
    for (const sourceId of ['code-source', 'archived-source']) {
      await engine.putPage(`${sourceId}/page`, {
        type: 'company', title: sourceId, compiled_truth: `${sourceId} body`,
      }, { sourceId });
      await engine.upsertChunks(`${sourceId}/page`, [{
        chunk_index: 0, chunk_text: `${sourceId} body`, chunk_source: 'compiled_truth',
        token_count: 2, embedding: undefined,
      }], { sourceId });
    }

    expect((await checkEmbedStaleness(engine)).check).toEqual({
      name: 'embed_staleness', status: 'ok', message: 'No stale chunks',
    });
    expect((await checkEntityLinkCoverage(engine)).check.message).toContain('vacuous');
    expect((await checkTimelineCoverage(engine)).check.message).toContain('vacuous');
  });

  test('types that exist only in code or archived sources do not imply memory proliferation', async () => {
    await addNonMemorySources();
    for (let i = 0; i < 40; i++) {
      const sourceId = i % 2 === 0 ? 'code-source' : 'archived-source';
      await engine.putPage(`${sourceId}/type-${i}`, {
        type: `non-memory-type-${i}`, title: `Type ${i}`, compiled_truth: 'not active memory',
      }, { sourceId });
    }

    const result = await checkTypeProliferation(engine);
    expect(result.check.status).toBe('ok');
    expect(result.check.message).toStartWith('0 distinct typed values');
  });
});
