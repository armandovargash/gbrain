/**
 * Health measures the active company-memory graph. Code sources have their own
 * symbol/call-graph readiness contract, and archived sources are outside the
 * active serving set. Neither may dilute the memory score.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

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

async function seedKnowledgeBaseline() {
  await engine.putPage('wiki/a', { type: 'note', title: 'A', compiled_truth: 'alpha' });
  await engine.putPage('wiki/b', { type: 'note', title: 'B', compiled_truth: 'bravo' });
  const vector = new Float32Array(1536);
  await engine.upsertChunks('wiki/a', [{
    chunk_index: 0, chunk_text: 'alpha', chunk_source: 'compiled_truth', token_count: 1, embedding: vector,
  }]);
  await engine.upsertChunks('wiki/b', [{
    chunk_index: 0, chunk_text: 'bravo', chunk_source: 'compiled_truth', token_count: 1, embedding: vector,
  }]);
  await engine.executeRaw(`
    INSERT INTO links (from_page_id, to_page_id, link_type)
    SELECT a.id, b.id, 'mentions' FROM pages a, pages b
    WHERE a.slug = 'wiki/a' AND b.slug = 'wiki/b'
  `);
}

describe('getHealth source-purpose isolation', () => {
  test('a graph-only code source cannot dilute company-memory health', async () => {
    await seedKnowledgeBaseline();
    const before = await engine.getHealth();

    await engine.executeRaw(`
      INSERT INTO sources (id, name, config)
      VALUES ('code-worktree', 'code-worktree', '{"federated":true,"strategy":"code"}'::jsonb)
    `);
    await engine.putPage('src/example-ts', {
      type: 'code', title: 'src/example.ts', compiled_truth: 'export function example() { return 1; }',
    }, { sourceId: 'code-worktree' });
    await engine.upsertChunks('src/example-ts', [{
      chunk_index: 0,
      chunk_text: 'export function example() { return 1; }',
      chunk_source: 'compiled_truth',
      token_count: 9,
      embedding: undefined,
      language: 'typescript',
      symbol_name: 'example',
      symbol_type: 'function',
    }], { sourceId: 'code-worktree' });

    const after = await engine.getHealth();
    expect(after.page_count).toBe(before.page_count);
    expect(after.missing_embeddings).toBe(before.missing_embeddings);
    expect(after.embed_coverage).toBe(before.embed_coverage);
    expect(after.orphan_pages).toBe(before.orphan_pages);
    expect(after.brain_score).toBe(before.brain_score);

    const codeOnly = await engine.getHealth({ sourceId: 'code-worktree' });
    expect(codeOnly.page_count).toBe(0);
    expect(codeOnly.brain_score).toBe(100);
  });

  test('an archived knowledge source cannot dilute active health', async () => {
    await seedKnowledgeBaseline();
    const before = await engine.getHealth();

    await engine.executeRaw(`
      INSERT INTO sources (id, name, archived, config)
      VALUES ('old-memory', 'old-memory', true, '{"federated":false}'::jsonb)
    `);
    await engine.putPage('wiki/old', {
      type: 'note', title: 'Old', compiled_truth: 'archived and intentionally unembedded',
    }, { sourceId: 'old-memory' });
    await engine.upsertChunks('wiki/old', [{
      chunk_index: 0,
      chunk_text: 'archived and intentionally unembedded',
      chunk_source: 'compiled_truth',
      token_count: 6,
      embedding: undefined,
    }], { sourceId: 'old-memory' });

    const after = await engine.getHealth();
    expect(after.page_count).toBe(before.page_count);
    expect(after.missing_embeddings).toBe(before.missing_embeddings);
    expect(after.brain_score).toBe(before.brain_score);
  });
});
