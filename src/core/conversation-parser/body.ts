import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';

export function readSummaryBody(page: Page): string {
  const compiled = page.compiled_truth ?? '';
  const timeline = page.timeline ?? '';
  if (!compiled) return timeline;
  if (!timeline) return compiled;
  return `${compiled}\n\n${timeline}`;
}

function extractRawTranscriptPath(page: Page): string | null {
  const raw = page.frontmatter?.raw_transcript;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function readConversationBodyForParsing(
  engine: BrainEngine,
  page: Page,
): Promise<string> {
  const rawTranscript = extractRawTranscriptPath(page);
  if (rawTranscript) {
    // SECURITY: `raw_transcript` is page frontmatter — ingested content, not
    // trusted config. Unconfined it was an arbitrary local-file read (absolute
    // paths taken as-is; relative paths joined without containment; symlinks
    // unresolved). Confinement: repo-relative only, and the realpath must stay
    // inside sync.repo_path. On refusal, warn with the refusal CLASS only —
    // never echo the attempted path (existence-oracle discipline) — and fall
    // back to the summary body.
    const refuse = (cls: 'absolute_path' | 'outside_repo' | 'unresolvable_path'): string => {
      console.warn(`[conversation-parser] raw_transcript refused (${cls}); falling back to summary body`);
      return readSummaryBody(page);
    };
    if (isAbsolute(rawTranscript)) return refuse('absolute_path');
    const repoPath = await engine.getConfig('sync.repo_path');
    if (repoPath) {
      try {
        const resolved = join(repoPath, rawTranscript);
        if (existsSync(resolved)) {
          const repoReal = realpathSync(repoPath);
          const fileReal = realpathSync(resolved);
          if (fileReal !== repoReal && !fileReal.startsWith(repoReal + sep)) {
            return refuse('outside_repo');
          }
          const rawBody = readFileSync(fileReal, 'utf8').trim();
          if (rawBody.length > 0) return rawBody;
        }
      } catch {
        return refuse('unresolvable_path');
      }
    }
  }
  return readSummaryBody(page);
}
