/**
 * F1b/F4b — mechanical quote verify/repair on dream pages (eval write-path
 * fix wave). Pure repair-ladder cases + one PGLite write-back integration
 * block. The ladder invariant under test everywhere: NEVER fabricate — every
 * replacement is a verbatim transcript slice; ungroundable spans lose their
 * quote marks but keep their text.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  normalizeForGrounding,
  normForGrounding,
  extractQuoteSpans,
  groundQuote,
  repairBody,
  countUngroundedNumericClaims,
  verifyAndRepairDreamPages,
} from '../src/core/cycle/synthesize-verify.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

function grounded(content: string) {
  const { norm, map } = normalizeForGrounding(content);
  return { content, norm, map };
}

describe('normalizeForGrounding', () => {
  test('folds whitespace, curly quotes, dashes, case — and maps back to original offsets', () => {
    const s = 'He said  “We’re    NOT\n\nready — at all.”';
    const { norm, map } = normalizeForGrounding(s);
    expect(norm).toBe('he said "we\'re not ready - at all."');
    expect(map.length).toBe(norm.length);
    // Map invariant: every normalized char points at a real original index,
    // non-decreasing, and mapping a match back yields a verbatim slice.
    for (let i = 1; i < map.length; i++) expect(map[i]).toBeGreaterThanOrEqual(map[i - 1]);
    const at = norm.indexOf('not ready');
    const start = map[at];
    const end = map[at + 'not ready'.length - 1] + 1;
    expect(s.slice(start, end)).toBe('NOT\n\nready');
  });

  test('empty and whitespace-only inputs', () => {
    expect(normForGrounding('')).toBe('');
    expect(normForGrounding('   \n\t ')).toBe('');
  });
});

describe('extractQuoteSpans', () => {
  test('pairs straight and curly quotes; enforces min length', () => {
    const body = 'Intro. "This is a properly long quoted span." And “another long enough quoted span here.” But "short" is skipped.';
    const { spans, unbalanced } = extractQuoteSpans(body);
    expect(unbalanced).toBe(0);
    expect(spans.map(s => s.inner)).toEqual([
      'This is a properly long quoted span.',
      'another long enough quoted span here.',
    ]);
  });

  test('skips code fences, inline code, and wikilinks', () => {
    const body = [
      'Prose with "a real quote long enough to count here".',
      '```',
      'code with "a fake quote inside a fence that must not count"',
      '```',
      'Inline `"quoted in code"` and a wikilink [[people/alice-example "x"]] stay out.',
    ].join('\n');
    const { spans } = extractQuoteSpans(body);
    expect(spans.map(s => s.inner)).toEqual(['a real quote long enough to count here']);
  });

  test('unbalanced paragraph is skipped and counted; other paragraphs still pair', () => {
    const body = 'One lonely " mark in this paragraph breaks pairing.\n\nBut "this later balanced quoted span still counts fine."';
    const { spans, unbalanced } = extractQuoteSpans(body);
    expect(unbalanced).toBe(1);
    expect(spans.map(s => s.inner)).toEqual(['this later balanced quoted span still counts fine.']);
  });
});

describe('groundQuote — the repair ladder', () => {
  const transcript = [
    'user (t1): I think the real insight is that memory systems fail at the',
    'write path, not the read path — everyone measures retrieval.',
    'user (t2): We decided to ship the “verify-at-write” pass in Q3, budget $250K.',
    'assistant (t3): Noted. The team agreed the mechanical checker beats an LLM judge.',
  ].join('\n');
  const t = grounded(transcript);

  test('exact substring → exact', () => {
    const g = groundQuote('memory systems fail at the', t);
    expect(g.status).toBe('exact');
  });

  test('normalized match (straight vs curly, collapsed whitespace) → verbatim replacement', () => {
    const g = groundQuote('We decided to ship the "verify-at-write" pass in Q3, budget $250K.', t);
    expect(g.status).toBe('normalized');
    if (g.status === 'normalized') {
      expect(transcript).toContain(g.replacement);
      expect(g.replacement).toContain('“verify-at-write”');
    }
  });

  test('near match (light paraphrase, high token overlap) → verbatim window', () => {
    const g = groundQuote('the team agreed the mechanical checker beats an LLM judge today', t);
    expect(g.status).toBe('near');
    if (g.status === 'near') {
      expect(transcript).toContain(g.replacement);
      expect(normForGrounding(g.replacement)).toContain('mechanical checker beats an llm judge');
    }
  });

  test('heavy paraphrase (low overlap) → none (caller strips)', () => {
    const g = groundQuote('our fundamental product philosophy centers customer delight above metrics', t);
    expect(g.status).toBe('none');
  });

  test('short quotes never near-match (min 4 tokens)', () => {
    const g = groundQuote('checker beats judge', t);
    expect(g.status).toBe('none');
  });

  test('ambiguous near-match (two similar homes) → none, never guess', () => {
    const twin = grounded([
      'alpha version: the deploy failed because the cache was stale in region one today',
      'beta version: the deploy failed because the cache was stale in region two today',
    ].join('\n'));
    const g = groundQuote('the deploy failed because the cache was stale in some region', twin);
    expect(g.status).toBe('none');
  });
});

describe('repairBody', () => {
  // The principle sentence carries an INTERIOR em-dash + curly apostrophe —
  // a page quote written with a hyphen + straight apostrophe is normalized-
  // equal but not byte-equal, which is exactly the rung-2 case. (Inner text
  // that is byte-identical is EXACT even when the surrounding quote-mark
  // style differs — quote fidelity is about the quoted content.)
  const transcript = 'user: We agreed the launch moves to March 14th because the audit slipped. Also: “the brain mustn’t invent quotes — ever.”';
  const t = grounded(transcript);

  test('full ladder: exact kept, normalized repaired to verbatim, ungrounded stripped', () => {
    const body = [
      'Summary paragraph without quotes.',
      '',
      'Decision: "We agreed the launch moves to March 14th because the audit slipped."',
      '',
      'Principle: "the brain mustn\'t invent quotes - ever."',
      '',
      'Invented: "our destiny is to reinvent human memory for all mankind forever."',
    ].join('\n');
    const r = repairBody(body, t);
    expect(r.quotes).toBe(3);
    expect(r.exact).toBe(1);            // launch-date quote is verbatim already
    expect(r.normalized).toBe(1);       // hyphen/apostrophe span repaired to the verbatim original
    expect(r.stripped).toBe(1);         // invented span loses its marks
    expect(r.changed).toBe(true);
    // Replacement is the verbatim INNER slice (page keeps its own quote marks).
    expect(r.body).toContain('"the brain mustn’t invent quotes — ever."');
    // Stripped span keeps its text, loses the quotation marks.
    expect(r.body).toContain('Invented: our destiny is to reinvent human memory for all mankind forever.');
    expect(r.body).not.toContain('"our destiny');
  });

  test('clean body → changed=false, byte-identical', () => {
    const body = 'Decision: "We agreed the launch moves to March 14th because the audit slipped." Done.';
    const r = repairBody(body, t);
    expect(r.changed).toBe(false);
    expect(r.body).toBe(body);
    expect(r.exact).toBe(1);
  });
});

describe('countUngroundedNumericClaims (F4b, warn-only)', () => {
  const t = grounded('user: ARR hit $2M in January 2026, churn 5%, headcount 12.');

  test('grounded claims do not warn; invented ones do; fences skipped; deduped', () => {
    const body = [
      'ARR reached $2M with churn at 5%.',          // both grounded
      'Series B raised $50M at a $900M cap.',       // 2 invented
      'Again: $50M.',                                // dup — counted once
      '```',
      '$77M inside a fence never counts',
      '```',
    ].join('\n');
    expect(countUngroundedNumericClaims(body, t)).toBe(2);
  });
});

describe('verifyAndRepairDreamPages — PGLite write-back integration', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
  });
  afterAll(async () => {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  });

  test('repairs the DB page via the canonical pipeline; scopes to hash-suffixed slugs; fail-open counters', async () => {
    {
      const transcript = 'user: The verdict was “ship the repair pass now — measure later.” That is the whole plan.';
      const hash6 = 'abc123';
      const slug = `wiki/personal/reflections/2026-08-31-repair-pass-${hash6}`;
      const pageMd = [
        '---',
        'type: note',
        '---',
        'The user concluded: "ship the repair pass now - measure later." Strong conviction.',
        '',
        'Fabricated: "we will rewrite the entire engine in Rust next week for fun."',
      ].join('\n');
      await importFromContent(engine, slug, pageMd, { noEmbed: true, remote: false, sourceId: 'default' });
      // A pre-existing people page the child touched — slug carries NO hash
      // suffix → must be skipped, never rewritten.
      await importFromContent(engine, 'wiki/people/alice-example', '---\ntype: person\n---\nAlice said "something from an entirely different source conversation".', { noEmbed: true, remote: false, sourceId: 'default' });

      const stats = await verifyAndRepairDreamPages(
        engine,
        [
          { slug, source_id: 'default', raw_source: '/t/session.md' },
          { slug: 'wiki/people/alice-example', source_id: 'default', raw_source: '/t/session.md' },
          { slug: 'wiki/personal/reflections/orphan-def456', source_id: 'default' },              // no raw_source
        ],
        new Map([['/t/session.md', { content: transcript, hash6 }]]),
      );

      expect(stats.pages_checked).toBe(1);
      expect(stats.pages_repaired).toBe(1);
      expect(stats.quotes_total).toBe(2);
      expect(stats.normalized_fixed).toBe(1);   // straight → verbatim curly original
      expect(stats.stripped).toBe(1);           // fabricated quote unquoted
      expect(stats.skipped_preexisting).toBe(1);
      expect(stats.skipped_no_transcript).toBe(1);
      expect(stats.errors).toBe(0);

      const page = await engine.getPage(slug, { sourceId: 'default' });
      expect(page).not.toBeNull();
      const bodyText = `${page?.compiled_truth ?? ''}\n${page?.timeline ?? ''}`;
      // Replacement is the verbatim inner slice; the page keeps its own marks.
      expect(bodyText).toContain('"ship the repair pass now — measure later."');
      expect(bodyText).toContain('Fabricated: we will rewrite the entire engine in Rust next week for fun.');
      expect(bodyText).not.toContain('"we will rewrite');
      // Untouched pre-existing page keeps its quote verbatim.
      const alice = await engine.getPage('wiki/people/alice-example', { sourceId: 'default' });
      expect(`${alice?.compiled_truth ?? ''}`).toContain('"something from an entirely different source conversation"');
    }
  }, 60_000);
});
