/**
 * The session-end receipt JSONL (src/core/context/hook-heartbeat.ts). Read
 * back the way the only real consumer reads it — the file at its documented
 * path, one JSON object per line — rather than through a helper that exists
 * for the test. Runs under a temp GBRAIN_HOME so nothing touches ~/.gbrain.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  appendSessionReceipt,
  sessionReceiptsPath,
  SESSION_RECEIPTS_MAX_LINES,
  type SessionReceiptEntry,
} from '../src/core/context/hook-heartbeat.ts';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-receipts-'));
}

/** What the consumer does: read the file, parse a line per receipt. */
function readAll(home: string): SessionReceiptEntry[] {
  const p = join(home, '.gbrain', 'integrations', 'hooks', 'session-receipts.jsonl');
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as SessionReceiptEntry);
}

const base = {
  harness: 'claude-code' as const,
  corpus_path: '/tmp/sess-1.txt',
  content_hash: 'abc123',
  turn_count: 4,
  workspace_root: '/repo',
  tool_calls_json: '[{"name":"bash","input":{"command":"pytest"}}]',
  secret_scan_ok: true,
};

describe('session-receipts', () => {
  test('the path is the one the consumer hardcodes, and append round-trips the full entry', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        expect(await sessionReceiptsPath()).toBe(
          join(home, '.gbrain', 'integrations', 'hooks', 'session-receipts.jsonl'),
        );
        await appendSessionReceipt({ ...base, session_id: 'sess-1' });
        const [e] = readAll(home);
        expect(e.session_id).toBe('sess-1');
        expect(e.harness).toBe('claude-code');
        expect(e.content_hash).toBe('abc123');
        expect(e.secret_scan_ok).toBe(true);
        expect(typeof e.ts).toBe('string');
        expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the file is 0600 inside a 0700 directory, the heartbeat contract', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await appendSessionReceipt({ ...base, session_id: 'sess-mode' });
        const p = await sessionReceiptsPath();
        expect(statSync(p).mode & 0o777).toBe(0o600);
        expect(statSync(join(home, '.gbrain', 'integrations', 'hooks')).mode & 0o777).toBe(0o700);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('appends keep oldest → newest order', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        for (const id of ['a', 'b', 'c']) {
          await appendSessionReceipt({ ...base, session_id: id, harness: 'codex', content_hash: id });
        }
        expect(readAll(home).map((e) => e.session_id)).toEqual(['a', 'b', 'c']);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('secret_scan_ok:false is preserved (the scan_unavailable degrade signal)', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await appendSessionReceipt({
          ...base,
          session_id: 'sess-unscanned',
          harness: 'opencode',
          tool_calls_json: '[]',
          secret_scan_ok: false,
        });
        expect(readAll(home)[0].secret_scan_ok).toBe(false);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the file is compacted on line count, keeping the newest', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        for (let i = 0; i < 2 * SESSION_RECEIPTS_MAX_LINES + 5; i++) {
          await appendSessionReceipt({ ...base, session_id: `s-${i}` });
        }
        const all = readAll(home);
        // Compaction trims to MAX_LINES once the file passes 2 * MAX_LINES, so
        // the steady state is bounded by 2 * MAX_LINES, not by what was written.
        expect(all.length).toBeLessThanOrEqual(2 * SESSION_RECEIPTS_MAX_LINES);
        expect(all.length).toBeLessThan(2 * SESSION_RECEIPTS_MAX_LINES + 5);
        expect(all[all.length - 1].session_id).toBe(`s-${2 * SESSION_RECEIPTS_MAX_LINES + 4}`);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('the file is ALSO compacted on bytes, so a few huge lines cannot grow it without limit', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        // Well under the line threshold, well over the byte one.
        const fat = JSON.stringify([{ name: 'Write', input: { content: 'x'.repeat(1_500_000) } }]);
        for (let i = 0; i < 8; i++) {
          await appendSessionReceipt({ ...base, session_id: `fat-${i}`, tool_calls_json: fat });
        }
        const p = await sessionReceiptsPath();
        expect(statSync(p).size).toBeLessThan(9 * 1024 * 1024);
        const all = readAll(home);
        expect(all.length).toBeLessThan(8);
        // Whatever survives, the newest receipt always does.
        expect(all[all.length - 1].session_id).toBe('fat-7');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('the byte trim leaves headroom, so a file at the budget does not rewrite itself on every append', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const fat = JSON.stringify([{ name: 'Write', input: { content: 'x'.repeat(1_500_000) } }]);
        // Drive the file to the byte budget, then keep appending.
        for (let i = 0; i < 8; i++) {
          await appendSessionReceipt({ ...base, session_id: `fill-${i}`, tool_calls_json: fat });
        }
        const p = await sessionReceiptsPath();
        // A whole-file rewrite goes through tmp+rename, which changes the
        // inode. writeHeartbeat's own doc names that window as the one place
        // a concurrent O_APPEND line can be silently dropped, so at steady
        // state it has to be rare rather than once per session end.
        let rewrites = 0;
        let ino = statSync(p).ino;
        for (let i = 0; i < 6; i++) {
          await appendSessionReceipt({ ...base, session_id: `after-${i}`, tool_calls_json: fat });
          const now = statSync(p).ino;
          if (now !== ino) { rewrites++; ino = now; }
        }
        expect(rewrites).toBeLessThan(6);
        // Still bounded, and the newest still survives.
        expect(statSync(p).size).toBeLessThan(9 * 1024 * 1024);
        const all = readAll(home);
        expect(all[all.length - 1].session_id).toBe('after-5');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('a receipt-write failure never throws into the hook it describes', async () => {
    // GBRAIN_HOME pointed at a path that cannot be a directory.
    const home = tempHome();
    const notADir = join(home, 'file');
    writeFileSync(notADir, 'x');
    try {
      await withEnv({ GBRAIN_HOME: notADir }, async () => {
        await appendSessionReceipt({ ...base, session_id: 'sess-broken' });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
