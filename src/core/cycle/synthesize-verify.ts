/**
 * synthesize-verify.ts — mechanical quote verify/repair on dream pages (F1b/F4b,
 * eval write-path fix wave).
 *
 * The synthesis prompt mandates verbatim quotes; measured against the Cat 35
 * benchmark, fewer than half of quoted spans in produced pages were substrings
 * of the source transcript — the model paraphrases inside quotation marks.
 * This pass runs right after the children's put_page writes and BEFORE
 * stampDreamProvenance / reverseWriteRefs / the phase-end embed sweep, so the
 * provenance stamp, the markdown file, and the embedded chunks all carry the
 * repaired body.
 *
 *   writtenRefs ──▶ scope filter ──▶ per-page repair ladder ──▶ write-back
 *   (slug,src,      only NEW pages     per quoted span:          only when a
 *    raw_source)    whose slug carries  1. exact substring → keep span changed,
 *        │          this transcript's   2. normalized match → replace with
 *        │          hash6 suffix           the VERBATIM transcript span
 *        ▼          (people/pattern     3. near match (rare-trigram anchor,
 *   skipped_*        edits skipped)        ≥0.8 token overlap) → replace
 *   counters                            4. else STRIP the quote marks
 *                                          (honest paraphrase, never invent)
 *
 * Ladder invariant: NEVER fabricate — every replacement is a verbatim slice of
 * the source transcript; when nothing grounds, the span loses its quotation
 * marks but keeps its text. Whole-page verification is scoped to pages this
 * transcript CREATED (slug carries the transcript's content-hash suffix, which
 * binds page↔transcript identity); pre-existing pages a child modified
 * (people/patterns) may quote OTHER sources and are skipped, counted.
 *
 * Failure contract (fail-open, pacer precedent — a verify bug never kills the
 * phase): unbalanced quote marks → skip that paragraph's spans + count;
 * page read-back miss → skip page + count; write-back throw → log slug+source,
 * count, continue. Zero LLM calls; pure string ops with soft caps.
 *
 * Write-back reuses the SAME canonical pipeline the children's put_page tool
 * executes — importFromContent (page + tags + chunks + link extraction in one
 * transaction, content_hash recomputed) with noEmbed: the phase-end embed
 * sweep backfills, exactly like the oneshot runner's deferEmbeds writes. A
 * bare engine.putPage would upsert only the pages row and leave stale
 * chunk_text for the sweep to embed.
 *
 * Kill switch: `dream.synthesize.quote_verify` (default on), read by
 * loadSynthConfig — the incident escape hatch for the one mechanism that
 * rewrites page bodies.
 */

import type { BrainEngine } from '../engine.ts';
import { importFromContent } from '../import-file.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { throwIfAborted } from '../abort-check.ts';

/** Minimum quoted-span inner length considered a "quote" (shorter spans are
 * scare quotes / titles, not transcript quotations). */
const MIN_QUOTE_CHARS = 15;
/** Soft cap: quoted spans examined per page (CPU bound, not correctness). */
const MAX_QUOTES_PER_PAGE = 200;
/** Near-match acceptance floor (token overlap) and ambiguity margin. */
const NEAR_MATCH_FLOOR = 0.8;
const NEAR_MATCH_AMBIGUITY = 0.05;
/** Soft cap on candidate anchor positions scanned per quote. */
const MAX_ANCHOR_CANDIDATES = 50;

export interface QuoteVerifyStats {
  pages_checked: number;
  pages_repaired: number;
  quotes_total: number;
  exact: number;
  normalized_fixed: number;
  near_fixed: number;
  stripped: number;
  unbalanced: number;
  skipped_preexisting: number;
  skipped_no_transcript: number;
  /** F4b warn-only: numeric/date claims in page bodies absent from the transcript. */
  numeric_claim_warns: number;
  /** Pages where read-back or write-back failed (fail-open, logged). */
  errors: number;
}

function emptyStats(): QuoteVerifyStats {
  return {
    pages_checked: 0,
    pages_repaired: 0,
    quotes_total: 0,
    exact: 0,
    normalized_fixed: 0,
    near_fixed: 0,
    stripped: 0,
    unbalanced: 0,
    skipped_preexisting: 0,
    skipped_no_transcript: 0,
    numeric_claim_warns: 0,
    errors: 0,
  };
}

/**
 * Offset-mapped grounding normalization — the wave's shared primitive (also
 * used by the triage-rescue segment check and, at prompt-build time, by
 * buildTriageMapBlock's quote filter via the plain `norm` form).
 *
 * Folds: whitespace runs → single space, curly quotes/apostrophes → straight,
 * unicode dashes → '-', case → lower. `map[i]` = index in the ORIGINAL string
 * of the character that produced `norm[i]`, so any match in normalized space
 * maps back to a VERBATIM original slice (outside-voice amendment: without
 * the map, "replace with verbatim span" would not be verbatim).
 */
export function normalizeForGrounding(s: string): { norm: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (/\s/.test(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (ch === '‘' || ch === '’' || ch === 'ʼ') ch = "'";
    else if (ch === '“' || ch === '”') ch = '"';
    else if (ch === '–' || ch === '—' || ch === '−') ch = '-';
    if (pendingSpace) {
      out.push(' ');
      map.push(map.length > 0 ? map[map.length - 1] : i);
      pendingSpace = false;
    }
    out.push(ch.toLowerCase());
    map.push(i);
  }
  return { norm: out.join(''), map };
}

/** Plain normalized form (no map) — for presence checks. */
export function normForGrounding(s: string): string {
  return normalizeForGrounding(s).norm;
}

interface GroundedTranscript {
  content: string;
  norm: string;
  map: number[];
}

export interface TranscriptForVerify {
  content: string;
  /** First 6 hex chars of the transcript content hash — the slug binding. */
  hash6: string;
}

/**
 * Quote-span extraction from a page BODY (frontmatter already split off).
 * Pairs straight or curly double quotes within a paragraph; skips fenced code
 * blocks, inline code, wikilinks, and markdown link targets. A paragraph with
 * an ODD number of quote marks is unbalanced — its spans are skipped (counted
 * by the caller), never guessed at.
 */
export function extractQuoteSpans(body: string): { spans: Array<{ start: number; end: number; inner: string }>; unbalanced: number } {
  const spans: Array<{ start: number; end: number; inner: string }> = [];
  let unbalanced = 0;

  // Mask fenced code blocks + inline code + wikilinks + link targets so quote
  // marks inside them never pair with prose quotes. Masking (not removal)
  // preserves offsets.
  const masked = body
    .replace(/```[\s\S]*?(?:```|$)/g, m => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, m => ' '.repeat(m.length))
    .replace(/\[\[[^\]]*\]\]/g, m => ' '.repeat(m.length))
    .replace(/\]\([^)]*\)/g, m => ' '.repeat(m.length));

  // Paragraph-wise pairing keeps an unbalanced paragraph from swallowing the
  // rest of the document into one bogus span.
  let paraStart = 0;
  const paragraphs = masked.split(/\n\s*\n/);
  for (const para of paragraphs) {
    const marks: number[] = [];
    for (let i = 0; i < para.length; i++) {
      const ch = para[i];
      if (ch === '"' || ch === '“' || ch === '”') marks.push(paraStart + i);
    }
    if (marks.length % 2 !== 0) {
      unbalanced++;
    } else {
      for (let m = 0; m + 1 < marks.length; m += 2) {
        const start = marks[m];
        const end = marks[m + 1];
        const inner = body.slice(start + 1, end);
        if (inner.length >= MIN_QUOTE_CHARS) spans.push({ start, end, inner });
        if (spans.length >= MAX_QUOTES_PER_PAGE) break;
      }
    }
    paraStart += para.length + 2; // rejoin the split "\n\n" (approximate but
    // consistent: split consumes variable \n\s*\n, so recompute exactly below.
    if (spans.length >= MAX_QUOTES_PER_PAGE) break;
  }

  // The paragraph-offset approximation above can drift when the separator is
  // longer than two chars; re-anchor every span against the real body so a
  // repair never lands at the wrong offset. Drop any span that fails to
  // re-anchor (defensive; counts as unbalanced rather than mis-repairing).
  const anchored: Array<{ start: number; end: number; inner: string }> = [];
  for (const sp of spans) {
    const probe = body.slice(sp.start, sp.end + 1);
    if (probe.length === sp.inner.length + 2
      && (probe[0] === '"' || probe[0] === '“' || probe[0] === '”')
      && probe.slice(1, -1) === sp.inner) {
      anchored.push(sp);
    } else {
      const idx = body.indexOf(`"${sp.inner}"`);
      if (idx >= 0) anchored.push({ start: idx, end: idx + sp.inner.length + 1, inner: sp.inner });
      else unbalanced++;
    }
  }
  return { spans: anchored, unbalanced };
}

export type GroundResult =
  | { status: 'exact' }
  | { status: 'normalized' | 'near'; replacement: string }
  | { status: 'none' };

/**
 * Ground one quoted span against the transcript. Returns the verbatim
 * transcript slice to substitute when the span is a normalized or near match;
 * 'none' when nothing grounds (caller strips the quote marks).
 */
export function groundQuote(inner: string, t: GroundedTranscript): GroundResult {
  if (t.content.includes(inner)) return { status: 'exact' };

  const q = normalizeForGrounding(inner);
  if (q.norm.length === 0) return { status: 'none' };

  // Rung 2: normalized whole-span match → map back to the original slice.
  const pos = t.norm.indexOf(q.norm);
  if (pos >= 0) {
    // Ambiguity check: a second occurrence with different original text is
    // fine (both are verbatim); just take the first.
    const start = t.map[pos];
    const end = t.map[pos + q.norm.length - 1] + 1;
    const replacement = t.content.slice(start, end);
    return replacement === inner ? { status: 'exact' } : { status: 'normalized', replacement };
  }

  // Rung 3: near match. Anchor on word trigrams from the quote; score
  // candidate windows by token overlap; accept a single clear winner ≥ floor.
  const qTokens = q.norm.split(' ').filter(w => w.length > 0);
  if (qTokens.length < 4) return { status: 'none' };
  const candidates: Array<{ start: number; end: number; score: number }> = [];
  const seenStarts = new Set<number>();
  for (let g = 0; g + 2 < qTokens.length && candidates.length < MAX_ANCHOR_CANDIDATES; g++) {
    const gram = qTokens.slice(g, g + 3).join(' ');
    let from = 0;
    while (candidates.length < MAX_ANCHOR_CANDIDATES) {
      const at = t.norm.indexOf(gram, from);
      if (at < 0) break;
      from = at + 1;
      // Window: extend around the anchor to the quote's normalized length
      // ±20%, snapped to word boundaries in normalized space.
      const targetLen = q.norm.length;
      let winStart = Math.max(0, at - Math.floor(g / Math.max(1, qTokens.length) * targetLen) - 20);
      let winEnd = Math.min(t.norm.length, winStart + Math.ceil(targetLen * 1.2) + 40);
      while (winStart > 0 && t.norm[winStart] !== ' ') winStart--;
      while (winEnd < t.norm.length && t.norm[winEnd] !== ' ') winEnd++;
      if (seenStarts.has(winStart)) continue;
      seenStarts.add(winStart);
      const winTokens = t.norm.slice(winStart, winEnd).split(' ').filter(w => w.length > 0);
      const counts = new Map<string, number>();
      for (const w of winTokens) counts.set(w, (counts.get(w) ?? 0) + 1);
      let hit = 0;
      for (const w of qTokens) {
        const c = counts.get(w) ?? 0;
        if (c > 0) { hit++; counts.set(w, c - 1); }
      }
      candidates.push({ start: winStart, end: winEnd, score: hit / qTokens.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < NEAR_MATCH_FLOOR) return { status: 'none' };
  const second = candidates.find(c => c.start !== best.start);
  if (second && best.score - second.score < NEAR_MATCH_AMBIGUITY && second.score >= NEAR_MATCH_FLOOR) {
    // Two plausible homes — refusing to guess beats repairing to the wrong
    // span (ambiguity falls through to strip).
    return { status: 'none' };
  }
  // Map the window back to a verbatim original slice, trimmed of the window's
  // slack: shrink to the tightest run whose tokens still clear the floor is
  // overkill — the ±20% window with word-boundary snap reads naturally.
  const oStart = t.map[best.start];
  const oEnd = t.map[Math.max(best.start, best.end - 1)] + 1;
  const replacement = t.content.slice(oStart, oEnd).trim();
  if (replacement.length === 0) return { status: 'none' };
  return { status: 'near', replacement };
}

/**
 * F4b (warn-only): count numeric/date claims in the body that do not ground
 * in the transcript. Currency, percents, 4+ digit numbers, ISO dates, and
 * month-name dates. No repair, no LLM — telemetry a future grounding gate
 * (filed TODO E7) can act on.
 */
export function countUngroundedNumericClaims(body: string, t: GroundedTranscript): number {
  const masked = body.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const claimRe = /\$[\d,]+(?:\.\d+)?[kmbKMB]?|\b\d+(?:\.\d+)?%|\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b|\b\d{4,}\b/gi;
  let warns = 0;
  const seen = new Set<string>();
  for (const m of masked.match(claimRe) ?? []) {
    const claim = normForGrounding(m);
    if (claim.length === 0 || seen.has(claim)) continue;
    seen.add(claim);
    // Years alone ground too easily / noisily; still checked, cheap.
    if (!t.norm.includes(claim)) warns++;
  }
  return warns;
}

/** Split a serialized page into its frontmatter block and body. */
function splitFrontmatter(md: string): { fm: string; body: string } {
  if (md.startsWith('---\n')) {
    const end = md.indexOf('\n---\n', 4);
    if (end >= 0) return { fm: md.slice(0, end + 5), body: md.slice(end + 5) };
  }
  return { fm: '', body: md };
}

/**
 * Repair one page body against its transcript. Pure: returns the repaired
 * body + per-ladder counts; the caller decides whether to write back.
 */
export function repairBody(body: string, t: GroundedTranscript): {
  body: string;
  changed: boolean;
  quotes: number;
  exact: number;
  normalized: number;
  near: number;
  stripped: number;
  unbalanced: number;
} {
  const { spans, unbalanced } = extractQuoteSpans(body);
  let out = body;
  let exact = 0, normalized = 0, near = 0, stripped = 0;
  // Repair back-to-front so earlier span offsets stay valid.
  for (const sp of [...spans].sort((a, b) => b.start - a.start)) {
    const g = groundQuote(sp.inner, t);
    if (g.status === 'exact') { exact++; continue; }
    if (g.status === 'normalized' || g.status === 'near') {
      if (g.status === 'normalized') normalized++; else near++;
      out = out.slice(0, sp.start + 1) + g.replacement + out.slice(sp.end);
      continue;
    }
    // Strip: drop the enclosing quote marks, keep the text — an honest
    // paraphrase instead of a false verbatim claim. Never delete content.
    stripped++;
    out = out.slice(0, sp.start) + sp.inner + out.slice(sp.end + 1);
  }
  return { body: out, changed: out !== body, quotes: spans.length, exact, normalized, near, stripped, unbalanced };
}

/**
 * Orchestrator entry: verify/repair every newly-created page from this
 * phase's writtenRefs. `transcriptsByPath` maps a transcript filePath →
 * its full content + hash6 (the slug-binding suffix).
 */
export async function verifyAndRepairDreamPages(
  engine: BrainEngine,
  refs: Array<{ slug: string; source_id: string; raw_source?: string }>,
  transcriptsByPath: Map<string, TranscriptForVerify>,
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteVerifyStats> {
  const stats = emptyStats();
  const groundedCache = new Map<string, GroundedTranscript>();
  // Dedupe defensively by (source, slug) — collectChildPutPageSlugs already
  // dedupes slugs, but the contract lives here too.
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.source_id} ${ref.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    throwIfAborted(opts.signal, '[dream] quote verify');

    const t = ref.raw_source ? transcriptsByPath.get(ref.raw_source) : undefined;
    if (!t) { stats.skipped_no_transcript++; continue; }
    // Scope: only pages this transcript CREATED — the slug carries the
    // transcript's hash6 (or hash6-c<idx> for chunked children). A modified
    // pre-existing page (people/patterns) may quote OTHER sources; whole-page
    // verification against one transcript would strip their valid quotes.
    if (!ref.slug.includes(`-${t.hash6}`)) { stats.skipped_preexisting++; continue; }

    let grounded = groundedCache.get(ref.raw_source as string);
    if (!grounded) {
      const { norm, map } = normalizeForGrounding(t.content);
      grounded = { content: t.content, norm, map };
      groundedCache.set(ref.raw_source as string, grounded);
    }

    try {
      const page = await engine.getPage(ref.slug, { sourceId: ref.source_id });
      if (!page) { stats.errors++; continue; }
      stats.pages_checked++;
      const tags = await engine.getTags(ref.slug, { sourceId: ref.source_id });
      const md = serializePageToMarkdown(page, tags);
      const { fm, body } = splitFrontmatter(md);
      const r = repairBody(body, grounded);
      stats.quotes_total += r.quotes;
      stats.exact += r.exact;
      stats.normalized_fixed += r.normalized;
      stats.near_fixed += r.near;
      stats.stripped += r.stripped;
      stats.unbalanced += r.unbalanced;
      stats.numeric_claim_warns += countUngroundedNumericClaims(r.body, grounded);
      if (r.changed) {
        // Canonical write pipeline — same as the children's put_page tool:
        // page + tags + chunks + link extraction, content_hash recomputed.
        // noEmbed: the phase-end embed sweep backfills (oneshot deferEmbeds
        // parity). Provenance fields null → engine COALESCE keeps the
        // first-write record intact.
        await importFromContent(engine, ref.slug, fm + r.body, {
          noEmbed: true,
          remote: false,
          sourceId: ref.source_id,
        });
        stats.pages_repaired++;
      }
    } catch (e) {
      // Fail-open: a verify bug never kills the phase (pacer precedent).
      stats.errors++;
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] quote verify ${ref.slug}@${ref.source_id} failed: ${msg}\n`);
    }
  }
  return stats;
}
