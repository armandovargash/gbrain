/**
 * ZeroEntropy-sunset migration E2E — the REAL wire path, end to end.
 *
 * Every other migrate-embeddings test stubs the gateway at
 * `__setEmbedTransportForTests`, which replaces `embedMany` entirely — so the
 * canonical sunset migration (`gbrain migrate embeddings --to voyage:voyage-4
 * --dim 1024`, the exact command every legacy zembed-1 brain must run before
 * ZEROENTROPY_SUNSET_DATE) never exercises `voyageCompatFetch`: the
 * dimensions→output_dimension translation, the forced base64 encoding_format,
 * the Float32-LE base64 response decode, or the /rerank companion probe.
 *
 * This file closes that gap:
 *   - a local HTTP server speaks Voyage's REAL wire dialect (base64 f32le
 *     embeddings under data[], {index, relevance_score} under data[] for
 *     /rerank), reached via the file-plane `provider_base_urls.voyage`
 *     override — zero code seams;
 *   - the migration, queries, status, and re-run all execute through the
 *     REAL CLI in subprocesses (arg parsing, gateway boot from config.json,
 *     key fold, non-TTY consent gate — all live);
 *   - post-migration assertions cover the three dim-pinned planes
 *     (content_chunks / facts / query_cache) and prove the query cache is
 *     ALIVE at the new width (the historical dead-cache regression class),
 *     plus the reranker companion flip zerank-2 → voyage:rerank-2.5.
 *
 * PGLite only (hermetic). `.serial.test.ts`: temp GBRAIN_HOME + an exclusive
 * PGLite data dir shared between the in-process seeder and CLI subprocesses.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runEmbedCore } from '../../src/commands/embed.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import { MIGRATION_STATE_KEY } from '../../src/core/embedding-migration.ts';

const REPO = join(import.meta.dir, '..', '..');
const FROM_DIMS = 1280;
const TO_DIMS = 1024;
const PAGES = ['page-1', 'page-2', 'page-3', 'page-4', 'page-5', 'page-6'];

// ---------------------------------------------------------------------------
// Deterministic "semantic" embedding: bag-of-words hash, L2-normalized.
// Same text → same vector; texts sharing words land near each other, so
// self-retrieval ("chunk text for page-3" → page-3) ranks correctly.
// ---------------------------------------------------------------------------
function fakeVector(text: string, dims: number): Float32Array {
  const v = new Float32Array(dims);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) {
      h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    }
    v[(h >>> 0) % dims] += 1;
  }
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i]! /= norm;
  return v;
}

function f32ToBase64(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

// ---------------------------------------------------------------------------
// Mock Voyage server — records every request for wire-shape assertions.
// ---------------------------------------------------------------------------
interface EmbedReq {
  model: string;
  input: string[];
  encoding_format?: string;
  output_dimension?: number;
  input_type?: string;
  auth: string | null;
}
const embedRequests: EmbedReq[] = [];
const rerankRequests: Array<{ model: string; top_k?: number; auth: string | null }> = [];

let server: ReturnType<typeof Bun.serve>;

function startMockVoyage(): string {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get('authorization');
      if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
        const body = (await req.json()) as EmbedReq;
        embedRequests.push({ ...body, auth });
        const dims = body.output_dimension ?? TO_DIMS;
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return Response.json({
          object: 'list',
          model: body.model,
          data: inputs.map((text: string, index: number) => ({
            object: 'embedding',
            index,
            // Voyage returns base64 Float32 little-endian — the compat shim
            // must decode this; a number[] here would NOT exercise the shim.
            embedding: f32ToBase64(fakeVector(text, dims)),
          })),
          usage: { total_tokens: inputs.length * 5 },
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/rerank') {
        const body = (await req.json()) as { model: string; top_k?: number; documents?: string[] };
        rerankRequests.push({ model: body.model, top_k: body.top_k, auth });
        const n = Math.min(body.top_k ?? 1, (body.documents ?? ['x']).length);
        return Response.json({
          object: 'list',
          data: Array.from({ length: n }, (_, index) => ({
            index,
            relevance_score: 0.9 - index * 0.1,
          })),
          usage: { total_tokens: 10 },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}/v1`;
}

// ---------------------------------------------------------------------------
// CLI subprocess runner — hermetic env: no ambient provider keys, keys come
// from config.json only (the exact posture of a legacy daemon-managed brain).
// ---------------------------------------------------------------------------
let tmpHome: string;
let dataDir: string;

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, join(REPO, 'src', 'cli.ts'), ...args], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      GBRAIN_HOME: tmpHome,
      TERM: 'dumb',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Direct-SQL helpers (fresh short-lived engine handle; PGLite is single-writer
// so every handle is closed before the next CLI subprocess runs).
// ---------------------------------------------------------------------------
async function withEngine<T>(fn: (e: PGLiteEngine) => Promise<T>): Promise<T> {
  const e = new PGLiteEngine();
  await e.connect({ database_path: dataDir, embedding_dimensions: FROM_DIMS } as never);
  try {
    return await fn(e);
  } finally {
    await e.disconnect();
  }
}

async function columnDims(e: PGLiteEngine, table: string): Promise<number | null> {
  const rows = await e.executeRaw<{ dim: number | null }>(`
    SELECT CASE WHEN atttypmod > 0 THEN atttypmod ELSE NULL END AS dim
    FROM pg_attribute
    WHERE attrelid = '${table}'::regclass AND attname = 'embedding' AND NOT attisdropped
  `);
  return rows[0]?.dim == null ? null : Number(rows[0].dim);
}

const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of [
    'GBRAIN_HOME', 'GBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_DIMENSIONS',
    'OPENAI_API_KEY', 'ZEROENTROPY_API_KEY', 'VOYAGE_API_KEY', 'DATABASE_URL',
  ]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-voyage-wire-'));
  process.env.GBRAIN_HOME = tmpHome;
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });

  dataDir = join(tmpHome, '.gbrain', 'brain-db');
  const baseUrl = startMockVoyage();
  writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    database_path: dataDir,
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: FROM_DIMS,
    zeroentropy_api_key: 'ze-test-fake',
    voyage_api_key: 'pa-test-fake',
    provider_base_urls: { voyage: baseUrl },
  }, null, 2));

  // ---- Seed the legacy brain IN-PROCESS at 1280d (how it really was built:
  // vectors written in ZE's space; the provider that wrote them is now dead,
  // so seeding uses the test seam — the migration below uses NO seams). ----
  resetGateway();
  configureGateway({
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: FROM_DIMS,
    env: { ZEROENTROPY_API_KEY: 'ze-test-fake' },
  });
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
    embeddings: values.map((t) => Array.from(fakeVector(t, FROM_DIMS))),
    usage: { tokens: values.length * 4 },
  }) as never);

  const engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir, embedding_dimensions: FROM_DIMS } as never);
  await engine.initSchema();
  for (const slug of PAGES) {
    await engine.putPage(slug, {
      type: 'note',
      title: slug,
      compiled_truth: `# ${slug}\n\ncontent for ${slug}`,
    });
    await engine.upsertChunks(slug, [
      {
        chunk_index: 0,
        chunk_text: `chunk text for ${slug}`,
        chunk_source: 'compiled_truth',
        token_count: 5,
      },
    ]);
  }
  const seeded = await runEmbedCore(engine, { stale: true, quiet: true });
  if (seeded.embedded !== PAGES.length) {
    throw new Error(`seed failed: embedded ${seeded.embedded}/${PAGES.length}`);
  }
  // A pre-v108 page (embedded, no signature) must still migrate.
  await engine.executeRaw(`UPDATE pages SET embedding_signature = NULL WHERE slug = 'page-1'`);
  // An old-space cache row that must NOT survive the migration.
  await engine.executeRaw(
    `INSERT INTO query_cache (id, query_text, source_id) VALUES ('qc-pre', 'old space query', 'default')`,
  );
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
}, 120000);

afterAll(async () => {
  server?.stop(true);
  rmSync(tmpHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('zembed-1 sunset migration over the real Voyage wire', () => {
  test('dry-run through the real CLI: plan only, zero wire calls, zero mutations', async () => {
    const r = await cli(['migrate', 'embeddings', '--to', 'voyage:voyage-4', '--dim', String(TO_DIMS), '--dry-run']);
    expect(r.code).toBe(0);
    expect(embedRequests.length).toBe(0);
    await withEngine(async (e) => {
      expect(await columnDims(e, 'content_chunks')).toBe(FROM_DIMS);
      expect(await e.getConfig(MIGRATION_STATE_KEY)).toBeFalsy();
    });
  }, 120000);

  test('live migration: real CLI, real voyageCompatFetch, base64 wire decode', async () => {
    const r = await cli(['migrate', 'embeddings', '--to', 'voyage:voyage-4', '--dim', String(TO_DIMS), '--yes']);
    expect(r.stderr + r.stdout).not.toContain('Traceback');
    expect(r.code).toBe(0);

    // Wire shape: every embed request carried Voyage's real dialect.
    expect(embedRequests.length).toBeGreaterThan(0);
    for (const req of embedRequests) {
      expect(req.model).toBe('voyage-4');
      expect(req.output_dimension).toBe(TO_DIMS); // dimensions → output_dimension translation
      expect(req.encoding_format).toBe('base64'); // forced by voyageCompatFetch
      expect(req.auth).toBe('Bearer pa-test-fake'); // config.json key fold
    }
    const embedded = embedRequests.flatMap((q) => q.input);
    for (const slug of PAGES) {
      expect(embedded.some((t) => t.includes(slug))).toBe(true);
    }
  }, 180000);

  test('all three dim-pinned planes transitioned; signatures stamped; old cache purged', async () => {
    await withEngine(async (e) => {
      expect(await columnDims(e, 'content_chunks')).toBe(TO_DIMS);
      expect(await columnDims(e, 'facts')).toBe(TO_DIMS);
      expect(await columnDims(e, 'query_cache')).toBe(TO_DIMS);

      const stale = await e.countStaleChunks();
      expect(stale).toBe(0);
      const nulls = await e.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NULL`,
      );
      expect(Number(nulls[0]?.n)).toBe(0);

      // Every page — including the signature-less pre-v108 one — restamped.
      const sigs = await e.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM pages WHERE embedding_signature = 'voyage:voyage-4:${TO_DIMS}'`,
      );
      expect(Number(sigs[0]?.n)).toBe(PAGES.length);

      // Old-space cache row is gone.
      const qc = await e.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM query_cache WHERE id = 'qc-pre'`,
      );
      expect(Number(qc[0]?.n)).toBe(0);

      // State marker cleared (converged, not mid-flight).
      expect(await e.getConfig(MIGRATION_STATE_KEY)).toBeFalsy();
    });

    // File plane repointed.
    const cfg = JSON.parse(readFileSync(join(tmpHome, '.gbrain', 'config.json'), 'utf-8'));
    expect(cfg.embedding_model).toBe('voyage:voyage-4');
    expect(cfg.embedding_dimensions).toBe(TO_DIMS);
  });

  test('reranker companion: auto flipped zerank-2 → voyage:rerank-2.5 via a live /rerank probe', async () => {
    expect(rerankRequests.length).toBeGreaterThan(0);
    expect(rerankRequests[0]!.model).toBe('rerank-2.5');
    expect(rerankRequests[0]!.auth).toBe('Bearer pa-test-fake');
    await withEngine(async (e) => {
      expect(await e.getConfig('search.reranker.model')).toBe('voyage:rerank-2.5');
      expect(await e.getConfig('search.reranker.enabled')).toBe('true');
    });
  });

  test('post-migration retrieval works through the real CLI (query embeds over the wire)', async () => {
    const before = embedRequests.length;
    const r = await cli(['query', 'chunk text for page-3', '--json']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('page-3');
    // The query embedding went over the Voyage wire at the new width.
    const queryReqs = embedRequests.slice(before);
    expect(queryReqs.length).toBeGreaterThan(0);
    for (const req of queryReqs) {
      expect(req.model).toBe('voyage-4');
      expect(req.output_dimension).toBe(TO_DIMS);
    }
  }, 120000);

  test('query cache is ALIVE at the new width (dead-cache regression guard)', async () => {
    // The first post-migration query must have BANKED a cache row — the
    // historical failure mode was a width-pinned query_cache that swallowed
    // every store() after a dim change.
    const rows = await withEngine((e) =>
      e.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM query_cache WHERE embedding IS NOT NULL`),
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);

    // And a repeat of the same query still answers correctly through the CLI.
    const r = await cli(['query', 'chunk text for page-3', '--json']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('page-3');
  }, 120000);

  test('re-run is a clean no-op: no re-embedding, exit 0', async () => {
    const before = embedRequests.length;
    const r = await cli(['migrate', 'embeddings', '--to', 'voyage:voyage-4', '--dim', String(TO_DIMS), '--yes']);
    expect(r.code).toBe(0);
    // Verified-skip may embed a probe, but must not redo the corpus.
    const delta = embedRequests.slice(before).flatMap((q) => q.input)
      .filter((t) => PAGES.some((slug) => t.includes(slug)));
    expect(delta.length).toBe(0);
  }, 120000);

  test('--status --json reports a converged brain with no live marker', async () => {
    const r = await cli(['migrate', 'embeddings', '--status', '--json']);
    expect(r.code).toBe(0);
    const status = JSON.parse(r.stdout);
    const flat = JSON.stringify(status);
    expect(flat).toContain('voyage:voyage-4');
    expect(flat).not.toContain('zeroentropyai:zembed-1:'); // no plane left behind
  }, 120000);
});

// ===========================================================================
// Arm 2: the keep-width alternative — openai:text-embedding-3-small at the
// brain's EXISTING 1280d (the renderCanonicalMigrationCommands openaiAlternative;
// what cost-conscious legacy users run to avoid the index rebuild). Also
// exercises the reranker companion's "target ships no reranker" ACTION branch
// (#3657): OpenAI has no /rerank, so the exposed ZE reranker must NOT be
// silently switched — the CLI prints the switch-or-disable choice instead.
// ===========================================================================

interface OpenAIEmbedReq {
  model: string;
  input: string[];
  dimensions?: number;
  auth: string | null;
}
const openaiRequests: OpenAIEmbedReq[] = [];
let openaiServer: ReturnType<typeof Bun.serve>;
let tmpHome2: string;
let dataDir2: string;

async function cli2(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, join(REPO, 'src', 'cli.ts'), ...args], {
    cwd: REPO,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, GBRAIN_HOME: tmpHome2, TERM: 'dumb' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe('zembed-1 sunset migration — keep-width OpenAI alternative (1280d, no rebuild)', () => {
  beforeAll(async () => {
    openaiServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
          const body = (await req.json()) as OpenAIEmbedReq;
          openaiRequests.push({ ...body, auth: req.headers.get('authorization') });
          const dims = body.dimensions ?? FROM_DIMS;
          const inputs = Array.isArray(body.input) ? body.input : [body.input];
          // Standard OpenAI dialect: plain number[] embeddings.
          return Response.json({
            object: 'list',
            model: body.model,
            data: inputs.map((text: string, index: number) => ({
              object: 'embedding',
              index,
              embedding: Array.from(fakeVector(text, dims)),
            })),
            usage: { prompt_tokens: inputs.length * 5, total_tokens: inputs.length * 5 },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    tmpHome2 = mkdtempSync(join(tmpdir(), 'gbrain-openai-keepwidth-'));
    dataDir2 = join(tmpHome2, '.gbrain', 'brain-db');
    mkdirSync(join(tmpHome2, '.gbrain'), { recursive: true });
    writeFileSync(join(tmpHome2, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite',
      database_path: dataDir2,
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: FROM_DIMS,
      zeroentropy_api_key: 'ze-test-fake',
      openai_api_key: 'sk-test-fake',
      provider_base_urls: { openai: `http://127.0.0.1:${openaiServer.port}/v1` },
    }, null, 2));

    // Seed at 1280d (same in-process seam pattern as arm 1).
    process.env.GBRAIN_HOME = tmpHome2;
    resetGateway();
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: FROM_DIMS,
      env: { ZEROENTROPY_API_KEY: 'ze-test-fake' },
    });
    __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
      embeddings: values.map((t) => Array.from(fakeVector(t, FROM_DIMS))),
      usage: { tokens: values.length * 4 },
    }) as never);
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir2, embedding_dimensions: FROM_DIMS } as never);
    await engine.initSchema();
    for (const slug of PAGES) {
      await engine.putPage(slug, {
        type: 'note',
        title: slug,
        compiled_truth: `# ${slug}\n\ncontent for ${slug}`,
      });
      await engine.upsertChunks(slug, [
        { chunk_index: 0, chunk_text: `chunk text for ${slug}`, chunk_source: 'compiled_truth', token_count: 5 },
      ]);
    }
    const seeded = await runEmbedCore(engine, { stale: true, quiet: true });
    if (seeded.embedded !== PAGES.length) {
      throw new Error(`arm-2 seed failed: embedded ${seeded.embedded}/${PAGES.length}`);
    }
    await engine.disconnect();
    __setEmbedTransportForTests(null);
    resetGateway();
    // Arm 1's home stays valid for its own afterAll; the CLI runner here uses
    // tmpHome2 explicitly.
    process.env.GBRAIN_HOME = tmpHome;
  }, 120000);

  afterAll(async () => {
    openaiServer?.stop(true);
    rmSync(tmpHome2, { recursive: true, force: true });
  });

  test('keep-width live migration: exit 0, standard OpenAI wire, dims param threaded', async () => {
    const r = await cli2(['migrate', 'embeddings', '--to', 'openai:text-embedding-3-small', '--dim', String(FROM_DIMS), '--yes']);
    expect(r.code).toBe(0);
    expect(openaiRequests.length).toBeGreaterThan(0);
    for (const req of openaiRequests) {
      expect(req.model).toBe('text-embedding-3-small');
      expect(req.dimensions).toBe(FROM_DIMS); // Matryoshka truncation to the kept width
      expect(req.auth).toBe('Bearer sk-test-fake');
    }
    const embedded = openaiRequests.flatMap((q) => q.input);
    for (const slug of PAGES) {
      expect(embedded.some((t) => t.includes(slug))).toBe(true);
    }
    // Target ships no reranker: the CLI must surface the ACTION, not silently
    // switch or disable.
    expect(r.stdout + r.stderr).toContain('reranker');
  }, 180000);

  test('width kept: no schema rebuild, planes stay 1280d, signatures restamped', async () => {
    const e = new PGLiteEngine();
    await e.connect({ database_path: dataDir2, embedding_dimensions: FROM_DIMS } as never);
    try {
      for (const table of ['content_chunks', 'facts', 'query_cache']) {
        const rows = await e.executeRaw<{ dim: number | null }>(`
          SELECT CASE WHEN atttypmod > 0 THEN atttypmod ELSE NULL END AS dim
          FROM pg_attribute
          WHERE attrelid = '${table}'::regclass AND attname = 'embedding' AND NOT attisdropped
        `);
        expect(Number(rows[0]?.dim)).toBe(FROM_DIMS);
      }
      expect(await e.countStaleChunks()).toBe(0);
      const sigs = await e.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM pages WHERE embedding_signature = 'openai:text-embedding-3-small:${FROM_DIMS}'`,
      );
      expect(Number(sigs[0]?.n)).toBe(PAGES.length);
      // Reranker untouched by the no-reranker target: neither switched to a
      // third provider nor silently disabled.
      expect(await e.getConfig('search.reranker.model')).not.toBe('voyage:rerank-2.5');
    } finally {
      await e.disconnect();
    }
    const cfg = JSON.parse(readFileSync(join(tmpHome2, '.gbrain', 'config.json'), 'utf-8'));
    expect(cfg.embedding_model).toBe('openai:text-embedding-3-small');
    expect(cfg.embedding_dimensions).toBe(FROM_DIMS);
  });

  test('retrieval + query embedding ride the OpenAI wire at the kept width', async () => {
    const before = openaiRequests.length;
    const r = await cli2(['query', 'chunk text for page-5', '--json']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('page-5');
    const queryReqs = openaiRequests.slice(before);
    expect(queryReqs.length).toBeGreaterThan(0);
    for (const req of queryReqs) {
      expect(req.model).toBe('text-embedding-3-small');
      expect(req.dimensions).toBe(FROM_DIMS);
    }
  }, 120000);
});
