import type { RankedResult } from "./types.js";

export type ContextSource = {
  n: number;
  source: string;
  headingPath?: string;
  lines?: string;
  score: number;
};

export type DroppedChunk = {
  source: string;
  reason: string;
};

export type BuiltContext = {
  text: string;
  sources: ContextSource[];
  dropped: DroppedChunk[];
};

function sourceOf(r: RankedResult): string {
  return r.chunk.source ?? r.chunk.documentId;
}

function linesOf(r: RankedResult): string | undefined {
  const { startLine, endLine } = r.chunk;
  if (startLine == null) return undefined;
  return endLine != null ? `${startLine}-${endLine}` : `${startLine}`;
}

/**
 * Render the header for one context entry per source spec §4.6:
 * - code (has line range): `[n] src/core/store.ts:41-78 — class SqliteStore > upsert`
 * - docs (no line range):  `[n] docs/setup.md § Instalação > Requisitos`
 */
function header(n: number, r: RankedResult): string {
  const source = sourceOf(r);
  const lines = linesOf(r);
  const heading = r.chunk.headingPath;
  if (lines) {
    const suffix = heading ? ` — ${heading}` : "";
    return `[${n}] ${source}:${lines}${suffix}`;
  }
  return heading ? `[${n}] ${source} § ${heading}` : `[${n}] ${source}`;
}

/**
 * Assemble ranked results into a `<context>` block within a token budget.
 * Whole chunks that do not fit are dropped (never split) and reported for
 * `--explain`. Ordering follows the ranked-result order (already by score).
 */
export function buildContext(
  results: RankedResult[],
  tokenBudget: number,
): BuiltContext {
  const sources: ContextSource[] = [];
  const dropped: DroppedChunk[] = [];
  const blocks: string[] = [];
  let used = 0;
  let n = 0;

  for (const r of results) {
    const cost = r.chunk.tokenEstimate;
    if (used + cost > tokenBudget) {
      dropped.push({
        source: sourceOf(r),
        reason: `token budget exceeded (needs ${cost}, ${tokenBudget - used} left of ${tokenBudget})`,
      });
      continue;
    }
    n += 1;
    used += cost;
    blocks.push(`${header(n, r)}\n${r.chunk.text}`);
    sources.push({
      n,
      source: sourceOf(r),
      headingPath: r.chunk.headingPath,
      lines: linesOf(r),
      score: r.normalizedScore,
    });
  }

  const text = `<context>\n${blocks.join("\n\n")}\n</context>`;
  return { text, sources, dropped };
}
