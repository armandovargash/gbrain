/**
 * Engine parity — CJK keyword asymmetry pin (test-gap plan D4).
 *
 * PGLite has a dedicated CJK keyword branch (src/core/pglite-engine/
 * cjk-search.ts — ILIKE + term-frequency ranking, routed via hasCJK() in
 * both searchKeyword and searchKeywordChunks). The Postgres engine has NO
 * such branch: it always goes through websearch_to_tsquery('<ftsLang>', …),
 * which cannot segment unsegmented CJK text. This suite pins the CURRENT
 * asymmetry as an EXPLICIT, documented degradation so it can't drift
 * silently in either direction:
 *
 *   - If someone accidentally breaks the PGLite CJK branch, the positive
 *     controls here go red.
 *   - If someone builds the Postgres CJK branch (the pgroonga / zhparser /
 *     ngram-trigram / ILIKE-fallback feature TODO — see TODOS.md, "Postgres
 *     CJK FTS via pgroonga / zhparser / ngram trigrams", filed twice: the
 *     v0.42 non-Latin wave entry and the v0.33+ follow-up entry), the
 *     PINNED-GAP assertions here go red and tell them exactly what to flip
 *     to parity assertions.
 *
 * NOT duplicated from test/cjk.test.ts (pure helpers), test/e2e/
 * cjk-roundtrip.test.ts (PGLite-only pipeline), or test/e2e/
 * sync-cjk-git.test.ts (sync path). The delta here is the CROSS-ENGINE
 * COMPARISON on an identical corpus.
 *
 * Locale-regime note (load-bearing for CI stability). Vanilla Postgres
 * tokenizes CJK per the database's lc_ctype:
 *   - C locale (e.g. a distro-native initdb): CJK chars classify as "blank"
 *     — to_tsvector drops them entirely and websearch_to_tsquery over a
 *     pure-CJK query yields an EMPTY tsquery (matches nothing). Mixed
 *     CJK+ASCII queries silently DROP the CJK terms.
 *   - UTF-8 locale (e.g. the pgvector/pgvector:pg16 CI image, en_US.utf8):
 *     an unbroken CJK run becomes ONE whole-run token, so substring queries
 *     still match nothing; only exact whitespace-delimited token matches
 *     work. Mixed queries keep CJK terms as AND-required tokens.
 * Every un-branched assertion below is chosen to hold under BOTH regimes
 * (the seeded corpus never contains a degradation-query term as a
 * standalone whitespace-delimited token). The one place the regimes
 * genuinely diverge (mixed query with a nonexistent CJK term) is pinned
 * per-regime behind a runtime probe.
 *
 * Gated by DATABASE_URL like engine-parity.test.ts — skips without a real
 * Postgres (the PGLite-only half is already covered by cjk-roundtrip).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { hasDatabase, setupDB, teardownDB, getConn } from './helpers.ts';

const SKIP_PG = !hasDatabase();
const describeBoth = SKIP_PG ? describe.skip : describe;

const JA_SLUG = 'originals/cjk-parity-ja';
const ZH_SLUG = 'originals/cjk-parity-zh';
const MIXED_SLUG = 'originals/cjk-parity-mixed';
const ASCII_SLUG = 'originals/cjk-parity-ascii';

// Seeding shape reused from test/e2e/cjk-roundtrip.test.ts (importFromContent
// with noEmbed — exercises the real chunker + search_vector population).
//
// CORPUS INVARIANT: none of the pure-CJK degradation queries (多言語, 晴れ,
// 测试) may appear ANYWHERE in the corpus as a standalone whitespace/ASCII-
// punctuation-delimited token. Under the UTF-8 locale regime Postgres WOULD
// token-match such an occurrence and the "Postgres returns empty" pin would
// become locale-dependent (green here, red on CI or vice versa). The mixed
// page deliberately uses a DIFFERENT CJK term (検索) for the same reason.
const SEED_PAGES: Array<{ slug: string; title: string; body: string }> = [
  {
    slug: JA_SLUG,
    title: 'JA note',
    body: '多言語対応のシステムを再度検証します。今日は晴れです。明日は雨です。',
  },
  {
    slug: ZH_SLUG,
    title: 'ZH note',
    body: '这是一个测试文档。测试内容很重要。我们再次测试一下系统。',
  },
  {
    slug: MIXED_SLUG,
    title: 'Mixed note',
    body: 'The system uses 検索 framework for validation.',
  },
  {
    slug: ASCII_SLUG,
    title: 'ASCII note',
    body: 'NovaMind builds enterprise automation agents for production deployments.',
  },
];

async function seedEngine(eng: BrainEngine) {
  for (const p of SEED_PAGES) {
    const md = `---\ntype: concept\ntitle: ${p.title}\n---\n\n${p.body}`;
    const result = await importFromContent(eng, p.slug, md, { noEmbed: true });
    expect(result.status).toBe('imported');
    expect(result.chunks).toBeGreaterThan(0);
  }
}

const slugsOf = (rs: SearchResult[]) => rs.map(r => r.slug);

// Pure-CJK queries: substrings of seeded bodies, never standalone tokens.
const CJK_QUERIES: Array<{ query: string; expectSlug: string }> = [
  { query: '多言語', expectSlug: JA_SLUG }, // Han (JA)
  { query: '晴れ', expectSlug: JA_SLUG },   // Han + Hiragana
  { query: '测试', expectSlug: ZH_SLUG },   // Han (ZH)
];

describeBoth('Engine parity — CJK keyword asymmetry (pinned gap)', () => {
  let pgEngine: BrainEngine;
  let pgliteEngine: PGLiteEngine;
  /** true when this Postgres produces lexemes for CJK (UTF-8 locale regime);
   *  false when CJK is dropped as "blank" (C locale regime). */
  let pgCjkLexemes: boolean;

  beforeAll(async () => {
    pgEngine = await setupDB();
    await seedEngine(pgEngine);

    pgliteEngine = new PGLiteEngine();
    await pgliteEngine.connect({});
    await pgliteEngine.initSchema();
    await seedEngine(pgliteEngine);

    // Runtime locale-regime probe (see file header). Must be one of the two
    // documented regimes — anything else means a new tokenizer showed up and
    // the pins below need re-derivation.
    const rows = await getConn().unsafe(
      `SELECT websearch_to_tsquery('english', '多言語')::text AS q`,
    );
    const q = String(rows[0]?.q ?? '');
    pgCjkLexemes = q.length > 0;
    if (pgCjkLexemes) expect(q).toContain('多言語');
  }, 90_000);

  afterAll(async () => {
    await pgliteEngine.disconnect();
    await teardownDB();
  }, 30_000);

  test('positive control: PGLite CJK branch finds the seeded pages (searchKeyword)', async () => {
    for (const { query, expectSlug } of CJK_QUERIES) {
      const hits = await pgliteEngine.searchKeyword(query, { limit: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].slug).toBe(expectSlug);
    }
  });

  test('positive control: PGLite CJK branch also serves searchKeywordChunks', async () => {
    const hits = await pgliteEngine.searchKeywordChunks('测试', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(slugsOf(hits)).toContain(ZH_SLUG);
  });

  test('PINNED GAP: Postgres returns EMPTY for the same CJK queries (searchKeyword)', async () => {
    // ------------------------------------------------------------------
    // THIS IS A PINNED, DOCUMENTED DEGRADATION — NOT DESIRED BEHAVIOR.
    //
    // PostgresEngine.searchKeyword has no CJK branch: it matches only via
    // `search_vector @@ websearch_to_tsquery('<ftsLang>', $1)`. Under the
    // C locale regime the tsquery for a pure-CJK query is EMPTY (CJK chars
    // classify as "blank"); under the UTF-8 locale regime the query becomes
    // a lexeme but the unsegmented seeded bodies indexed as whole-run
    // tokens, so a substring query still matches nothing. Either way: zero
    // results for CJK users on Postgres, while PGLite (positive control
    // above) finds the pages.
    //
    // Feature TODO: TODOS.md — "Postgres CJK FTS via pgroonga / zhparser /
    // ngram trigrams" (v0.42 non-Latin wave entry + v0.33+ follow-up
    // entry). The planned fix: doctor advisory for the extension, and
    // searchKeyword / searchKeywordChunks falling through to the
    // PGLite-style ILIKE branch when no CJK-capable extension is installed.
    //
    // WHEN THAT LANDS: flip these expectations to parity — assert Postgres
    // returns the same slugs as the PGLite positive controls (top slug ===
    // expectSlug), then delete the regime probe if the branch makes results
    // locale-independent. Also flip the searchKeywordChunks + mixed-query
    // pins below.
    // ------------------------------------------------------------------
    for (const { query } of CJK_QUERIES) {
      const hits = await pgEngine.searchKeyword(query, { limit: 5 });
      expect(hits).toEqual([]);
    }
  });

  test('PINNED GAP: Postgres searchKeywordChunks is equally blind to CJK', async () => {
    // Same degradation, chunk-grain primitive (PGLite routes BOTH methods
    // through the CJK branch; Postgres routes NEITHER). Same flip
    // instructions as above.
    const hits = await pgEngine.searchKeywordChunks('测试', { limit: 5 });
    expect(hits).toEqual([]);
  });

  test('parity where parity exists: ASCII queries return the same results on both engines', async () => {
    // Includes an ASCII query that lands on a CJK-containing page — CJK
    // content must not break ASCII retrieval of the same page on either
    // engine.
    const asciiQueries: Array<{ query: string; expectSlug: string }> = [
      { query: 'enterprise automation', expectSlug: ASCII_SLUG },
      { query: 'framework validation', expectSlug: MIXED_SLUG },
    ];
    for (const { query, expectSlug } of asciiQueries) {
      const pgHits = await pgEngine.searchKeyword(query, { limit: 5 });
      const pgliteHits = await pgliteEngine.searchKeyword(query, { limit: 5 });
      expect(pgHits.length).toBeGreaterThan(0);
      expect(pgHits[0].slug).toBe(expectSlug);
      expect(pgliteHits[0].slug).toBe(expectSlug);
      expect(new Set(slugsOf(pgHits))).toEqual(new Set(slugsOf(pgliteHits)));
    }
  });

  test('mixed CJK+ASCII query: both engines find the mixed page (different mechanisms)', async () => {
    // PGLite: hasCJK('framework 検索') is true → CJK branch → AND-of-ILIKE
    // over whitespace terms ['framework', '検索'] → the mixed page contains
    // both substrings.
    const pgliteHits = await pgliteEngine.searchKeyword('framework 検索', { limit: 5 });
    expect(slugsOf(pgliteHits)).toEqual([MIXED_SLUG]);

    // Postgres: matches under BOTH locale regimes, but for different
    // reasons — C regime drops 検索 from the tsquery and matches on
    // 'framework' alone; UTF-8 regime keeps '検索' as an AND term and the
    // mixed page happens to carry it as a standalone space-delimited token.
    // Coincidental agreement, NOT CJK support (see the divergence pin
    // below).
    const pgHits = await pgEngine.searchKeyword('framework 検索', { limit: 5 });
    expect(slugsOf(pgHits)).toEqual([MIXED_SLUG]);
  });

  test('PINNED GAP: mixed query with a nonexistent CJK term exposes the real Postgres semantics', async () => {
    // '存在しない語' appears nowhere in the corpus.
    //
    // PGLite CJK branch has strict AND semantics over every whitespace
    // term — one unmatched CJK term empties the result. Locale-independent.
    const pgliteHits = await pgliteEngine.searchKeyword('framework 存在しない語', { limit: 5 });
    expect(pgliteHits).toEqual([]);

    // Postgres diverges BY LOCALE REGIME — the sharpest evidence that it
    // has no real CJK handling (pinned per-regime via the runtime probe):
    //   - C regime: the CJK term is SILENTLY DROPPED from the tsquery, so
    //     the query degrades to 'framework' and STILL returns the mixed
    //     page — a false positive a CJK user never asked for.
    //   - UTF-8 regime: the CJK term survives as an AND-required lexeme
    //     that no page carries → empty.
    // WHEN THE POSTGRES CJK BRANCH LANDS (TODOS.md pgroonga entry — see the
    // searchKeyword pin above), both regimes must converge on the PGLite
    // behavior ([]): replace this branch with expect(pgHits).toEqual([]).
    const pgHits = await pgEngine.searchKeyword('framework 存在しない語', { limit: 5 });
    if (pgCjkLexemes) {
      expect(pgHits).toEqual([]);
    } else {
      expect(slugsOf(pgHits)).toEqual([MIXED_SLUG]);
    }
  });
});
