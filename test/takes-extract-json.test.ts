/**
 * #3962 — `takes extract --from-pages --json` must emit the structured
 * extraction result instead of the human summary line.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runTakes } from '../src/commands/takes.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let pages: Array<Record<string, unknown>> = [];
const seenModels: string[] = [];
const engine = {
  getConfig: async (key: string) => key === 'takes.bootstrap_enabled' ? 'true' : null,
  executeRaw: async () => pages,
} as unknown as BrainEngine;

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join('');
}

beforeAll(() => {
  configureGateway({
    chat_model: 'openai:gpt-test',
    env: { OPENAI_API_KEY: 'sk-test-takes-json' },
  });
  __setChatTransportForTests(async (opts) => {
    seenModels.push(opts.model ?? '(unset)');
    return {
      text: '[]',
      blocks: [{ type: 'text' as const, text: '[]' }],
      stopReason: 'end' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model ?? '(unset)',
      providerId: 'test',
    };
  });
});

afterAll(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

describe('gbrain takes extract --from-pages --json (#3962)', () => {
  test('emits the extraction result as parseable JSON', async () => {
    pages = [];
    const stdout = await captureStdout(() =>
      runTakes(engine, ['extract', '--from-pages', '--dry-run', '--json']));

    expect(JSON.parse(stdout)).toEqual({
      pages_scanned: 0,
      claims_extracted: 0,
      consent_gate_blocked: false,
      llm_unavailable: false,
      // #4473: md-first skip accounting.
      pages_skipped: 0,
      skipped: [],
      mirror_warnings: 0,
    });
  });

  test('passes --model through to the takes classifier', async () => {
    seenModels.length = 0;
    pages = [{
      id: 1,
      slug: 'concepts/openai-routing',
      source_id: 'default',
      type: 'concept',
      compiled_truth: 'A concrete founder-facing claim. '.repeat(10),
      updated_at: new Date().toISOString(),
    }];

    await captureStdout(() => runTakes(engine, [
      'extract', '--from-pages', '--dry-run', '--json',
      '--model', 'openai:gpt-5.6-luna',
    ]));

    expect(seenModels).toEqual(['openai:gpt-5.6-luna']);
  });
});
