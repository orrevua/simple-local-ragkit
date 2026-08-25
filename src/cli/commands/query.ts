import { loadConfig } from "../../config.js";
import { buildContext, type BuiltContext } from "../../core/context.js";
import { OllamaEmbeddings } from "../../core/embedder.js";
import { HybridRetriever } from "../../core/retriever.js";
import type {
  HybridSearchResult,
  MetadataFilter,
  SearchResult,
} from "../../core/types.js";
import { openStore } from "./ingest.js";

export type QueryCommandOptions = {
  collection?: string;
  topK?: number;
  explain?: boolean;
  json?: boolean;
};

function formatSourceLine(s: BuiltContext["sources"][number]): string {
  const loc = s.lines ? `${s.source}:${s.lines}` : s.source;
  const heading = s.headingPath ? ` — ${s.headingPath}` : "";
  return `[${s.n}] ${loc}${heading} (${s.score.toFixed(3)})`;
}

/** Human-facing default output: the context block plus a compact source list. */
export function formatDefault(context: BuiltContext): string {
  const lines = [context.text, "", "sources:"];
  if (context.sources.length === 0) {
    lines.push("  (no results)");
  } else {
    for (const s of context.sources) lines.push(`  ${formatSourceLine(s)}`);
  }
  return lines.join("\n");
}

function formatLeg(label: string, leg: SearchResult[]): string[] {
  const out = [`${label} leg (${leg.length} candidates):`];
  for (const r of leg) {
    const src = r.chunk.source ?? r.chunk.documentId;
    out.push(`  #${r.rank} ${src} [${r.chunkId}] raw=${r.rawScore.toFixed(4)}`);
  }
  return out;
}

/** `--explain` output: both legs, per-chunk RRF math, budget decisions, and the
 * final context block exactly as delivered. */
export function formatExplain(
  search: HybridSearchResult,
  context: BuiltContext,
): string {
  const { explain } = search;
  const out: string[] = [];
  out.push(`query: ${explain.query}`);
  out.push(
    `topK=${explain.topK} rrfK=${explain.rrfK} minScore=${explain.minScore} maxFused=${explain.maxFusedScore.toFixed(4)}`,
  );
  out.push("");
  out.push(...formatLeg("dense", explain.dense));
  out.push("");
  out.push(...formatLeg("lexical", explain.lexical));
  out.push("");
  out.push("RRF fusion:");
  for (const e of explain.fused) {
    const dense = e.denseRank ?? "-";
    const lex = e.lexicalRank ?? "-";
    out.push(
      `  ${e.chunkId} dense#${dense} lexical#${lex} ` +
        `fused=${e.fusedScore.toFixed(4)} norm=${e.normalizedScore.toFixed(3)}`,
    );
  }
  out.push("");
  out.push("token budget:");
  for (const s of context.sources) {
    out.push(`  in  [${s.n}] ${s.source}`);
  }
  for (const d of context.dropped) {
    out.push(`  out     ${d.source} — ${d.reason}`);
  }
  out.push("");
  out.push("context:");
  out.push(context.text);
  return out.join("\n");
}

/** `--json` output: a single valid JSON object. */
export function formatJson(
  search: HybridSearchResult,
  context: BuiltContext,
): string {
  return JSON.stringify(
    {
      query: search.explain.query,
      results: search.results.map((r) => ({
        chunkId: r.chunkId,
        rank: r.rank,
        score: r.score,
        normalizedScore: r.normalizedScore,
        source: r.chunk.source,
        headingPath: r.chunk.headingPath ?? null,
        startLine: r.chunk.startLine ?? null,
        endLine: r.chunk.endLine ?? null,
        text: r.chunk.text,
      })),
      context: context.text,
      sources: context.sources,
      explain: {
        topK: search.explain.topK,
        rrfK: search.explain.rrfK,
        minScore: search.explain.minScore,
        maxFusedScore: search.explain.maxFusedScore,
        dense: search.explain.dense.map(toExplainCandidate),
        lexical: search.explain.lexical.map(toExplainCandidate),
        fused: search.explain.fused,
        dropped: context.dropped,
      },
    },
    null,
    2,
  );
}

function toExplainCandidate(r: SearchResult): {
  chunkId: string;
  rank: number;
  rawScore: number;
  source: string | undefined;
} {
  return {
    chunkId: r.chunkId,
    rank: r.rank,
    rawScore: r.rawScore,
    source: r.chunk.source,
  };
}

export async function runQuery(
  cwd: string,
  query: string,
  options: QueryCommandOptions,
  filter?: MetadataFilter,
): Promise<void> {
  const config = await loadConfig(cwd);
  const { db, store } = openStore(config.dbPath);
  try {
    const embedder = new OllamaEmbeddings(db, {
      model: config.embeddings.model,
      baseUrl: config.embeddings.baseUrl,
    });
    const retriever = new HybridRetriever({ store, embedder, config });

    const search = await retriever.hybridSearch(query, {
      topK: options.topK,
      filter,
    });
    const context = buildContext(search.results, config.retrieval.contextTokens);

    let output: string;
    if (options.json) {
      output = formatJson(search, context);
    } else if (options.explain) {
      output = formatExplain(search, context);
    } else {
      output = formatDefault(context);
    }
    process.stdout.write(`${output}\n`);
  } finally {
    db.close();
  }
}
